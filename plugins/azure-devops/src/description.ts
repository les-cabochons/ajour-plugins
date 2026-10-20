import type { AzureWorkItem } from "./azure-devops.js";
import type { ConnectorSyncedDescription } from "./contract.js";
import { htmlToMarkdownWithLosses } from "./html-markdown.js";

/** A Markdown description's mention, as Azure DevOps writes it. */
const MARKDOWN_MENTION = /@<([0-9a-fA-F-]{36})>/g;

/**
 * A Markdown description names the people it mentions only by id. The item's
 * assignee is named in the sync's fields; anyone else shows as "someone".
 */
function markdownMentionsToAjour(text: string, workItem: AzureWorkItem) {
  const assignee = workItem.fields?.["System.AssignedTo"] as
    | { id?: string; displayName?: string }
    | undefined;
  return text.replace(MARKDOWN_MENTION, (_match, id: string) => {
    const name =
      assignee?.id?.toLowerCase() === id.toLowerCase() && assignee.displayName
        ? assignee.displayName.replace(/[[\]\\]/g, "")
        : "someone";
    return `[@${name}](mention:${id.toLowerCase()})`;
  });
}

/**
 * Markdown as Ajour stores it: Unix line endings, without blank lines or
 * spaces around it, but with a first line's indentation of four spaces or
 * more, which Markdown reads as an indented code block. One to three leading
 * spaces mean nothing in Markdown and go.
 */
function normalizeMarkdown(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/^ {1,3}(?=\S)/, "")
    .trimEnd();
}

/** The most of a description Ajour stores (Ajour's ADR 0009). */
export const MAX_DESCRIPTION_LENGTH = 64_000;

/** Whether a multiline field holds Markdown rather than HTML. */
export function isMarkdownField(workItem: AzureWorkItem, field: string) {
  const format = workItem.multilineFieldsFormat?.[field];
  return typeof format === "string" && format.toLowerCase() === "markdown";
}

/**
 * A work item's description as Ajour syncs it: Markdown, what the conversion
 * from HTML dropped, and whether it was cut to what Ajour stores. Since 2025
 * an item can store its description as Markdown, which is kept as written.
 */
export function describeWorkItem(workItem: AzureWorkItem): ConnectorSyncedDescription {
  const value = workItem.fields?.["System.Description"];
  let text = "";
  let lost: string[] = [];
  if (typeof value === "string") {
    if (isMarkdownField(workItem, "System.Description")) {
      text = markdownMentionsToAjour(normalizeMarkdown(value), workItem);
    } else {
      const converted = htmlToMarkdownWithLosses(value);
      text = converted.markdown ?? "";
      lost = converted.lost;
    }
  }
  const cut = text.length > MAX_DESCRIPTION_LENGTH;
  if (cut) {
    text = text.slice(0, MAX_DESCRIPTION_LENGTH);
    // Never leave half of a character made of two code units.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return {
    text,
    ...(lost.length > 0 ? { lost } : {}),
    ...(cut ? { cut: true } : {}),
  };
}
