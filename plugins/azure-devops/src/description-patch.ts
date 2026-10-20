import { htmlToMarkdown, htmlToMarkdownParts } from "./html-markdown.js";
import { markdownTextEdges, markdownToHtml } from "./markdown-html.js";

// Writes an edited description back into its HTML, keeping the HTML of every
// block the user did not change exactly as it was, and the HTML between
// blocks wherever the blank lines there did not change: empty editor lines,
// spacing and markup stay. Only what changed is written from the Markdown.

/** Past this many line pairs, a line diff costs too much. */
const MAX_DIFF_CELLS = 4_000_000;

/** An empty line of the editor, as Azure DevOps writes one. */
const EMPTY_LINE = "<div><br></div>";

/**
 * For each line of `before`, the line of `after` it stays as, or -1: the
 * lines both start and end with, then a longest common subsequence between.
 */
function matchLines(before: string[], after: string[]): number[] | undefined {
  const match = new Array<number>(before.length).fill(-1);
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) {
    match[head] = head;
    head += 1;
  }
  let tail = 0;
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    match[before.length - 1 - tail] = after.length - 1 - tail;
    tail += 1;
  }
  const n = before.length - head - tail;
  const m = after.length - head - tail;
  if ((n + 1) * (m + 1) > MAX_DIFF_CELLS) return undefined;
  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i * width + j] =
        before[head + i] === after[head + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }
  for (let i = 0, j = 0; i < n && j < m; ) {
    if (before[head + i] === after[head + j]) {
      match[head + i] = head + j;
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return match;
}

/** A piece of the written HTML, and how the reader sets it apart from others. */
interface Piece {
  html: string;
  /** Starts or ends with a block that stands apart by a blank line whatever comes between. */
  firstBlock: boolean;
  lastBlock: boolean;
  /** The kept part it is, if any. */
  part?: number;
}

/** Whether HTML between two lines reads as an empty line between them. */
function holdsEmptyLine(gap: string) {
  return htmlToMarkdown(`<div>x</div>${gap}<div>y</div>`) === "x\n\ny";
}

/** Whether HTML between two lines reads as nothing between them. */
function holdsNothing(gap: string) {
  return htmlToMarkdown(`<div>x</div>${gap}<div>y</div>`) === "x\ny";
}

/**
 * The HTML for `markdown`, an edit of the description `html` holds, with the
 * HTML of each unchanged block, and of each unchanged space between blocks,
 * kept. Undefined when that would not read back as the whole Markdown,
 * written, would.
 */
export function patchDescriptionHtml(html: string, markdown: string): string | undefined {
  const source = htmlToMarkdownParts(html);
  if (!source) return undefined;
  const { parts, gaps, separators } = source;

  // Each part's lines in the Markdown read from the source, and the blank
  // line that stands for each gap set apart by one.
  const before: string[] = [];
  const gapAtLine = new Map<number, number>();
  const spans = parts.map((part, index) => {
    if (index > 0 && separators[index - 1] === "\n\n") {
      gapAtLine.set(before.length, index - 1);
      before.push("");
    }
    const start = before.length;
    before.push(...part.markdown.split("\n"));
    return { start, end: before.length };
  });
  const after = markdown.replace(/\r\n?/g, "\n").replace(/^\n+|\n+$/g, "").split("\n");
  const match = matchLines(before, after);
  if (!match) return undefined;
  // The gaps whose blank line stayed, by the line it stayed as.
  const gapAfterLine = new Map<number, number>();
  for (const [line, gap] of gapAtLine) {
    if (match[line]! >= 0) gapAfterLine.set(match[line]!, gap);
  }

  // A part is kept when all its lines stay, together and in order.
  const placed = spans.map(({ start, end }) => {
    const first = match[start]!;
    if (first === -1) return undefined;
    for (let line = start; line < end; line += 1) {
      if (match[line] !== first + (line - start)) return undefined;
    }
    return { start: first, end: first + (end - start) };
  });
  // A kept block must not touch new text, which would join it: a line after
  // a list goes on its last item. Only plain lines may.
  for (let changed = true; changed; ) {
    changed = false;
    placed.forEach((place, index) => {
      if (!place || parts[index]!.line) return;
      const previous = placed[index - 1];
      const next = placed[index + 1];
      const beforeOk =
        place.start === 0 ||
        after[place.start - 1] === "" ||
        (previous?.end === place.start && separators[index - 1] === "\n");
      const afterOk =
        place.end === after.length ||
        after[place.end] === "" ||
        (next?.start === place.end && separators[index] === "\n");
      if (!beforeOk || !afterOk) {
        placed[index] = undefined;
        changed = true;
      }
    });
  }
  // The edit as the whole Markdown, written, would read back: the kept blocks
  // must change nothing in it. An edit in Markdown's usual form reads back as
  // itself.
  const target = htmlToMarkdown(markdownToHtml(after.join("\n"))) ?? "";
  // A kept block that cannot sit beside the text around it, as a new list
  // line right above a kept line, joins the changed text, and the write is
  // tried again.
  for (;;) {
    const written = write();
    if (typeof written !== "object") return written;
    placed[written.unkeep] = undefined;
  }

  /** The HTML with the blocks `placed` keeps, or the kept block to give up. */
  function write(): string | { unkeep: number } | undefined {
    const keptAt = new Map<number, number>();
    placed.forEach((place, index) => {
      if (place) keptAt.set(place.start, index);
    });

    // The pieces to write, and the blank lines and stayed gap between each pair.
    const pieces: Piece[] = [];
    const joins: { blank: boolean; gap?: number }[] = [];
    let blank = false;
    let stayedGap: number | undefined;
    const push = (piece: Piece) => {
      if (pieces.length > 0) joins.push({ blank, gap: stayedGap });
      pieces.push(piece);
      blank = false;
      stayedGap = undefined;
    };
    for (let line = 0; line < after.length; ) {
      if (after[line] === "") {
        blank = true;
        stayedGap ??= gapAfterLine.get(line);
        line += 1;
        continue;
      }
      const index = keptAt.get(line);
      if (index !== undefined) {
        const part = parts[index]!;
        push({ html: part.html, firstBlock: part.block, lastBlock: part.block, part: index });
        line = placed[index]!.end;
        continue;
      }
      // New or changed text, up to the next kept block or blank line that stayed.
      const start = line;
      while (line < after.length && !keptAt.has(line) && !gapAfterLine.has(line)) line += 1;
      let end = line;
      while (end > start && after[end - 1] === "") end -= 1;
      const text = after.slice(start, end).join("\n");
      const edges = markdownTextEdges(text);
      push({ html: markdownToHtml(text), firstBlock: !edges.first, lastBlock: !edges.last });
      blank = end < line;
    }

    const usedGaps = new Set<number>();
    /**
     * The HTML between two pieces that reads as a blank line, or not: a gap of
     * the source where one fits, else an empty editor line or nothing.
     */
    const between = (previous: Piece, next: Piece, wanted: boolean, candidates: (number | undefined)[]) => {
      const apart = previous.lastBlock || next.firstBlock;
      for (const gap of candidates) {
        if (gap === undefined || usedGaps.has(gap)) continue;
        const gapHtml = gaps[gap]!;
        if (wanted ? apart || holdsEmptyLine(gapHtml) : !apart && holdsNothing(gapHtml)) {
          usedGaps.add(gap);
          return gapHtml;
        }
      }
      if (wanted === apart) return "";
      if (wanted && !apart) return EMPTY_LINE;
      return undefined;
    };

    let out = source!.prefix;
    for (const [index, piece] of pieces.entries()) {
      if (index > 0) {
        const previous = pieces[index - 1]!;
        const join = joins[index - 1]!;
        const html = between(previous, piece, join.blank, [
          join.gap,
          piece.part !== undefined && piece.part > 0 ? piece.part - 1 : undefined,
          previous.part !== undefined && previous.part < gaps.length ? previous.part : undefined,
        ]);
        if (html === undefined) {
          const unkeep = piece.part ?? previous.part;
          return unkeep === undefined ? undefined : { unkeep };
        }
        out += html;
      }
      out += piece.html;
    }
    out += source!.suffix;
    return (htmlToMarkdown(out) ?? "") === target ? out : undefined;
  }
}
