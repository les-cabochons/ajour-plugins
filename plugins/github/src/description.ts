import type { ConnectorSyncedDescription } from "./contract.js";

/** The most of a description Ajour stores (Ajour's ADR 0009). */
export const MAX_DESCRIPTION_LENGTH = 64_000;

/**
 * The longest body GitHub takes. GitHub does not document it; it refuses a
 * longer one with "Body is too long (maximum is 65536 characters)", counting
 * characters, not UTF-16 code units.
 */
export const GITHUB_BODY_MAX_LENGTH = 65_536;

/** What `lost` names for a body whose lines end in more than one way. */
export const MIXED_LINE_ENDINGS = "line endings Ajour cannot keep";

/**
 * An issue body as Ajour syncs it. A body is Markdown already, so the text is
 * the body as written, `@login` mentions and GitHub-only syntax included. As
 * Ajour stores a description, its lines end in Unix line endings, without the
 * blank lines before it or the spaces after it; `bodyFor` puts them back.
 */
export function describeIssueBody(body: string | null | undefined): ConnectorSyncedDescription {
  const source = body ?? "";
  let text = source
    .replace(/\r\n?/g, "\n")
    .replace(/^(?:[ \t]*\n)+/, "")
    .trimEnd();
  // A write gives every line the body's one line ending, so a mix, or old
  // Mac endings, would change.
  const mixed = /\r(?!\n)/.test(source) || (source.includes("\r\n") && /(?:^|[^\r])\n/.test(source));
  const cut = text.length > MAX_DESCRIPTION_LENGTH;
  if (cut) {
    text = text.slice(0, MAX_DESCRIPTION_LENGTH);
    // Never leave half of a character made of two code units.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  }
  return {
    text,
    ...(mixed ? { lost: [MIXED_LINE_ENDINGS] } : {}),
    ...(cut ? { cut: true } : {}),
  };
}

/** Past this many line pairs, a line diff costs too much. */
const MAX_DIFF_CELLS = 4_000_000;

/** The end of a refused write: the user can still make the edit in GitHub. */
const EDIT_IN_GITHUB = "Edit the description in GitHub.";

function quoted(line: string) {
  const trimmed = line.trim();
  return `"${trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed}"`;
}

/**
 * Where the source's last line is among the edited lines, by a line diff: a
 * longest common subsequence of the two. Every optimal alignment counts, not
 * one pick among them. Returns the edited line it stays as when every
 * alignment keeps it there, or `undefined` when none keeps it: the user
 * edited, deleted or moved it. Throws when alignments disagree, since which
 * line is the user's own is then a guess.
 */
function lastLineAt(before: string[], after: string[]) {
  const last = before.length - 1;
  const line = before[last]!;
  // `row[j]` is the longest common subsequence of the lines before the last
  // one and the first j edited lines. Lines both start with are common.
  let head = 0;
  while (head < last && head < after.length && before[head] === after[head]) head += 1;
  const columns = after.length - head;
  if ((last - head) * (columns + 1) > MAX_DIFF_CELLS) {
    throw new Error(
      `Ajour cannot work out where ${quoted(line)} went in an edit this large, to keep the spaces at its end. ${EDIT_IN_GITHUB}`,
    );
  }
  let row = new Uint32Array(columns + 1);
  let next = new Uint32Array(columns + 1);
  for (let i = head; i < last; i += 1) {
    for (let j = 1; j <= columns; j += 1) {
      next[j] = before[i] === after[head + j - 1] ? row[j - 1]! + 1 : Math.max(row[j]!, next[j - 1]!);
    }
    [row, next] = [next, row];
  }
  const common = (j: number) => (j <= head ? j : head + row[j - head]!);

  // The last line is kept as edited line j in some optimal alignment when it
  // matches it after a longest common subsequence of all that came before.
  const unmatched = common(after.length);
  let longest = unmatched;
  for (let j = 0; j < after.length; j += 1) {
    if (after[j] === line) longest = Math.max(longest, common(j) + 1);
  }
  const places = after.flatMap((edited, j) => (edited === line && common(j) + 1 === longest ? [j] : []));
  if (places.length === 0) return undefined;
  if (places.length === 1 && unmatched < longest) return places[0];
  throw new Error(
    `Ajour cannot tell which ${quoted(line)} line is the one that ends the description, to keep the spaces at its end. ${EDIT_IN_GITHUB}`,
  );
}

/**
 * The body to write for Ajour's text: the text as it is, with the source
 * body's line endings, and the whitespace the read trimmed put back where it
 * was, or a refusal.
 *
 * - Blank lines before and after the text stay at the body's start and end:
 *   they belong to no line, and next to an added line they would split a
 *   paragraph the user wrote as one.
 * - The last line's trailing spaces, tabs or non-breaking spaces stay on it,
 *   wherever a line diff finds it, and go with it when the user edited,
 *   deleted or moved it. When the diff cannot tell which line it is, the
 *   write is refused.
 * - Uniform CRLF endings go on every line. Mixed ones are already `lost`.
 *
 * An emptied description empties the body, and a blank body, with nothing to
 * keep in place, takes the text as it is.
 */
export function bodyFor(source: string | null | undefined, text: string) {
  const lines = (source ?? "").replace(/\r\n?/g, "\n");
  const start = /^(?:[ \t]*\n)*/.exec(lines)![0];
  const read = lines.slice(start.length).trimEnd();
  if (!text || !read) return text;
  if (text === read) return source!;
  const end = lines.slice(start.length + read.length);
  const lineEnd = end.indexOf("\n");
  const trailing = lineEnd === -1 ? end : end.slice(0, lineEnd);
  const blankLines = lineEnd === -1 ? "" : end.slice(lineEnd);
  const edited = text.split("\n");
  if (trailing) {
    // GitHub renders every newline in an issue as a line break, so two
    // trailing spaces before a line the user added change nothing.
    const at = lastLineAt(read.split("\n"), edited);
    if (at !== undefined) edited[at] += trailing;
  }
  const whole = `${start}${edited.join("\n")}${blankLines}`;
  return source!.includes("\r\n") ? whole.replace(/\n/g, "\r\n") : whole;
}

/** A body's length as GitHub counts it: a character made of two code units counts once. */
export function bodyLength(body: string) {
  return [...body].length;
}
