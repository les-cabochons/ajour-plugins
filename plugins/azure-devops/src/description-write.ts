import {
  parseAzureWorkItemId,
  requestAzureDevOps,
  type AzureDevOpsConnectionInput,
  type AzureWorkItem,
} from "./azure-devops.js";
import { toAzureMarkdown } from "./comments.js";
import type {
  BacklogWriteDescriptionRequest,
  BacklogWriteDescriptionResult,
} from "./contract.js";
import { describeWorkItem, isMarkdownField } from "./description.js";
import { fetchWorkItemWithFormats } from "./description-source.js";
import { patchDescriptionHtml } from "./description-patch.js";
import { markdownToHtml } from "./markdown-html.js";

/** The longest description Azure DevOps takes, as it measures: the stored HTML or Markdown. */
export const AZURE_DESCRIPTION_MAX_LENGTH = 1_000_000;


/**
 * The HTML to write: the description's own, with only what the user changed
 * written from the Markdown. A description that has none yet takes the
 * whole Markdown; one whose untouched parts could not be kept as they are
 * is not written at all.
 */
function htmlFor(workItem: AzureWorkItem, currentText: string, text: string) {
  const source = workItem.fields?.["System.Description"];
  if (typeof source !== "string" || !currentText) return markdownToHtml(text);
  const patched = patchDescriptionHtml(source, text);
  if (patched === undefined) {
    throw new Error(
      "Ajour cannot write this edit without changing parts of the description you did not edit. Edit it in Azure DevOps.",
    );
  }
  return patched;
}

/**
 * The Markdown to write to an item that stores its description as Markdown:
 * the edit, with the blank lines and spaces the read trimmed from the
 * source's start and end, and its line endings, as they were.
 */
function markdownFor(workItem: AzureWorkItem, text: string) {
  const source = workItem.fields?.["System.Description"];
  const written = toAzureMarkdown(text);
  if (typeof source !== "string" || !source.trim()) return written;
  const lines = source.replace(/\r\n?/g, "\n");
  const start = /^(?:[ \t]*\n)*/.exec(lines)![0];
  const end = lines.slice(lines.trimEnd().length);
  const whole = `${start}${written}${end}`;
  return source.includes("\r\n") ? whole.replace(/\n/g, "\r\n") : whole;
}

/** Whether a refused patch is how Azure DevOps answers a failed test operation. */
function isRevisionTestFailure(error: unknown) {
  return error instanceof Error && /request failed \((?:400|409|412)\)/.test(error.message);
}

function requireWorkItemId(config: AzureDevOpsConnectionInput, sourceId: string) {
  const id = parseAzureWorkItemId(sourceId, config.organizationUrl);
  if (id === null) {
    throw new Error(`"${sourceId}" is not an Azure DevOps work item.`);
  }
  return id;
}

/**
 * Writes the user's description, unless the item's description changed since
 * Ajour read it: the current one, converted as a sync converts it, must still
 * be `expected`. The write tests the item's revision too, so a change made in
 * between answers with a conflict rather than being lost. An item that stores
 * its description as Markdown gets Markdown; any other gets HTML.
 */
export async function writeAzureDescription(
  config: AzureDevOpsConnectionInput,
  request: BacklogWriteDescriptionRequest,
): Promise<BacklogWriteDescriptionResult> {
  const id = requireWorkItemId(config, request.sourceId);
  const workItem = await fetchWorkItemWithFormats(config, id);
  const current = describeWorkItem(workItem);
  if (current.text !== request.expected) {
    return { outcome: "conflict", description: current };
  }
  // The same text can come from formatting a colleague added since Ajour read
  // it, which the write would erase. Lossy text is written only when the user
  // saw each of its losses and saved anyway; even then, the blocks they did
  // not change keep their HTML, formatting included. Cut text never is.
  const unseen = (current.lost ?? []).filter((loss) => !(request.allowedLoss ?? []).includes(loss));
  if (current.cut || unseen.length > 0) {
    throw new Error(
      current.cut
        ? "This description is longer than Ajour keeps. Edit it in Azure DevOps."
        : `Writing it would lose its ${unseen.join(", ")} in Azure DevOps. Edit it there.`,
    );
  }

  const markdown = isMarkdownField(workItem, "System.Description");
  const value = markdown ? markdownFor(workItem, request.text) : htmlFor(workItem, current.text, request.text);
  if (value.length > AZURE_DESCRIPTION_MAX_LENGTH) {
    throw new Error(
      `This description is too long for Azure DevOps: ${value.length.toLocaleString("en-US")} of ${AZURE_DESCRIPTION_MAX_LENGTH.toLocaleString("en-US")} characters once converted.`,
    );
  }

  const operations = [
    ...(typeof workItem.rev === "number" ? [{ op: "test", path: "/rev", value: workItem.rev }] : []),
    { op: "add", path: "/fields/System.Description", value },
    ...(markdown
      ? [{ op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" }]
      : []),
  ];
  let written: AzureWorkItem;
  try {
    written = await requestAzureDevOps<AzureWorkItem>(
      config,
      `/_apis/wit/workitems/${id}?api-version=7.1`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json-patch+json" },
        body: JSON.stringify(operations),
      },
    );
  } catch (error) {
    // A failed revision test, as Azure DevOps answers one: someone changed the
    // item in between. Any other refusal, such as a missing permission, stays.
    if (!isRevisionTestFailure(error)) throw error;
    const now = await fetchWorkItemWithFormats(config, id).catch(() => undefined);
    if (now && typeof now.rev === "number" && now.rev !== workItem.rev) {
      return { outcome: "conflict", description: describeWorkItem(now) };
    }
    throw error;
  }
  // The answer holds the item's fields; without them, read it again.
  const answered =
    written?.fields?.["System.Description"] !== undefined ? written : await fetchWorkItemWithFormats(config, id);
  return { outcome: "written", description: describeWorkItem(answered) };
}
