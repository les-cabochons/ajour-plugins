import type { AzureWorkItem } from "./azure-devops.js";
import type { ConnectorSyncedDescription } from "./contract.js";
import { htmlToMarkdown, htmlToMarkdownWithLosses } from "./html-markdown.js";
import { toAzureMarkdown } from "./comments.js";
import { replaceOutsideCode } from "./markdown-code.js";
import { markdownToHtml } from "./markdown-html.js";

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
  return replaceOutsideCode(text, MARKDOWN_MENTION, (_match, id: string) => {
    const name =
      assignee?.id?.toLowerCase() === id.toLowerCase() && assignee.displayName
        ? assignee.displayName.replace(/[[\]\\]/g, "")
        : "someone";
    // The id keeps its case, so the write gives back `@<id>` as it was.
    return `[@${name}](mention:${id})`;
  });
}

/**
 * Markdown as Ajour stores it: Unix line endings, without blank lines or
 * trailing spaces, but with its first line's indentation as written: an
 * indented code block needs it, and indented list items or code fences read
 * differently without it.
 */
function normalizeMarkdown(text: string) {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
}

/**
 * What `lost` names for an HTML description whose Markdown would not write
 * back as itself: an edit in Ajour would change parts the user never touched,
 * so Ajour keeps it read-only.
 */
export const NOT_WRITABLE_EXACTLY = "formatting Ajour cannot write back";

/** Whether Markdown read from HTML writes back as HTML that reads as itself. */
function writesBackExactly(markdown: string) {
  return (htmlToMarkdown(markdownToHtml(markdown)) ?? "") === markdown;
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
      const source = normalizeMarkdown(value);
      text = markdownMentionsToAjour(source, workItem);
      // Mentions read and written in different places, such as in code,
      // would write back changed: keep such a description read-only. Ids
      // keep their case both ways, so the write gives back the source.
      if (toAzureMarkdown(text) !== source) lost = [NOT_WRITABLE_EXACTLY];
      // A write gives every line the source's one line ending, so a mix, or
      // old Mac endings, would change.
      if (/\r(?!\n)/.test(value) || (value.includes("\r\n") && /(?:^|[^\r])\n/.test(value))) {
        lost = [...lost, "line endings Ajour cannot keep"];
      }
    } else {
      const converted = htmlToMarkdownWithLosses(value);
      text = converted.markdown ?? "";
      lost = converted.lost;
      if (text.length <= MAX_DESCRIPTION_LENGTH && !writesBackExactly(text)) {
        lost = [...lost, NOT_WRITABLE_EXACTLY];
      }
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
