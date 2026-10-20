// Converts the Markdown Ajour edits back to the HTML of an Azure DevOps
// description (Ajour's ADR 0009). It reads the Markdown that html-markdown.ts
// writes, and the CommonMark people type: headings, paragraphs whose single
// line breaks stay line breaks, lists, quotes, code, rules, tables, links,
// images, emphasis, strikethrough and Ajour's mentions. Raw HTML is shown as
// text, never passed through. A blank line ends a list, as html-markdown.ts
// writes two lists apart, so HTML → Markdown → HTML → Markdown is stable.

import { decodeHtmlEntities, IMAGE_SIZE_MARK } from "./html-markdown.js";

type Block =
  | { kind: "paragraph"; lines: string[] }
  | { kind: "heading"; level: number; text: string }
  | { kind: "code"; text: string }
  | { kind: "rule" }
  | { kind: "quote"; blocks: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: Block[][] }
  | { kind: "table"; header: string[]; rows: string[][] };

/** The HTML of a Markdown description, or "" for an empty one. */
export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n");
  return renderBlocks(parseBlocks(lines), false);
}

const FENCE = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE = /^ {0,3}> ?/;
const LIST_ITEM = /^( {0,3})([-*+]|\d{1,9}[.)])( {1,4}|$)/;
const TABLE_DIVIDER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;

// A non-breaking space is text, as in CommonMark: only spaces and tabs are
// blank or indent.
function isBlank(line: string) {
  return /^[ \t]*$/.test(line);
}

function indentOf(line: string) {
  return line.length - line.replace(/^[ \t]+/, "").length;
}

function trimSpaces(text: string) {
  return text.replace(/^[ \t]+|[ \t]+$/g, "");
}

/** Whether a line starts a block that ends a paragraph. */
function startsBlock(line: string) {
  if (FENCE.test(line) || HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) {
    return true;
  }
  const item = LIST_ITEM.exec(line);
  // An ordered list breaks a paragraph only from 1, and no empty item does.
  return Boolean(
    item &&
      item[3] !== "" &&
      (!/^\d/.test(item[2]!) || Number.parseInt(item[2]!, 10) === 1),
  );
}

function isTableRow(line: string) {
  return line.replace(/^[ \t]+/, "").startsWith("|");
}

function parseBlocks(lines: string[]): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence && !(fence[2]![0] === "`" && fence[3]!.includes("`"))) {
      const marker = fence[2]!;
      const indent = fence[1]!.length;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(lines[index]!);
        if (close && close[1]![0] === marker[0] && close[1]!.length >= marker.length) {
          index += 1;
          break;
        }
        body.push(lines[index]!.replace(new RegExp(`^ {0,${indent}}`), ""));
        index += 1;
      }
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    if (indentOf(line) >= 4) {
      const body: string[] = [];
      while (index < lines.length && (indentOf(lines[index]!) >= 4 || isBlank(lines[index]!))) {
        body.push(lines[index]!.slice(Math.min(4, indentOf(lines[index]!))));
        index += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1]!)) body.pop();
      blocks.push({ kind: "code", text: body.join("\n") });
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({ kind: "heading", level: heading[1]!.length, text: heading[2] ?? "" });
      index += 1;
      continue;
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index]!)) {
        body.push(lines[index]!.replace(QUOTE, ""));
        index += 1;
      }
      blocks.push({ kind: "quote", blocks: parseBlocks(body) });
      continue;
    }

    if (LIST_ITEM.test(line)) {
      index = parseList(lines, index, blocks);
      continue;
    }

    if (isTableRow(line) && index + 1 < lines.length && TABLE_DIVIDER.test(lines[index + 1]!)) {
      const header = splitRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]!)) {
        rows.push(splitRow(lines[index]!));
        index += 1;
      }
      blocks.push({ kind: "table", header, rows });
      continue;
    }

    const paragraph: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!)) {
      const next = lines[index]!;
      const setext = SETEXT.exec(next);
      if (setext) {
        blocks.push({
          kind: "heading",
          level: setext[1]![0] === "=" ? 1 : 2,
          text: paragraph.map(trimSpaces).join(" "),
        });
        paragraph.length = 0;
        index += 1;
        break;
      }
      if (startsBlock(next)) break;
      paragraph.push(next);
      index += 1;
    }
    if (paragraph.length > 0) blocks.push({ kind: "paragraph", lines: paragraph });
  }
  return blocks;
}

/** Parses the list starting at `start`, and returns the index after it. */
function parseList(lines: string[], start: number, blocks: Block[]): number {
  const first = LIST_ITEM.exec(lines[start]!)!;
  const ordered = /^\d/.test(first[2]!);
  const delimiter = first[2]!.slice(-1);
  const items: Block[][] = [];
  let index = start;
  while (index < lines.length) {
    const item = LIST_ITEM.exec(lines[index]!);
    if (
      !item ||
      /^\d/.test(item[2]!) !== ordered ||
      item[2]!.slice(-1) !== delimiter
    ) {
      break;
    }
    const content = item[1]!.length + item[2]!.length + (item[3] === "" ? 1 : item[3]!.length);
    const body = [lines[index]!.slice(Math.min(content, lines[index]!.length))];
    index += 1;
    while (index < lines.length) {
      const next = lines[index]!;
      if (isBlank(next)) {
        // A blank line ends the list, unless the item goes on indented.
        const following = lines[index + 1];
        if (following !== undefined && !isBlank(following) && indentOf(following) >= content) {
          body.push("");
          index += 1;
          continue;
        }
        break;
      }
      if (indentOf(next) >= content) {
        body.push(next.slice(content));
      } else if (LIST_ITEM.test(next) || startsBlock(next)) {
        break;
      } else {
        // A lazy line goes on the item's paragraph.
        body.push(next.replace(/^[ \t]+/, ""));
      }
      index += 1;
    }
    items.push(parseBlocks(body));
  }
  blocks.push({
    kind: "list",
    ordered,
    start: ordered ? Number.parseInt(first[2]!, 10) : 1,
    items,
  });
  return index;
}

/** A table row's cells, split on pipes that are not escaped. */
function splitRow(line: string): string[] {
  let text = trimSpaces(line);
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !isEscapedAt(text, text.length - 1)) text = text.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  for (let at = 0; at < text.length; at += 1) {
    if (text[at] === "|" && !isEscapedAt(text, at)) {
      cells.push(trimSpaces(cell));
      cell = "";
    } else {
      cell += text[at];
    }
  }
  cells.push(trimSpaces(cell));
  return cells;
}

function isEscapedAt(text: string, index: number) {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

function renderBlocks(blocks: Block[], inItem: boolean): string {
  return blocks
    .map((block, index) => {
      // Two paragraphs stand apart by an empty line, as Azure DevOps' editor
      // writes one; other blocks have their own spacing.
      const spaced = !inItem && block.kind === "paragraph" && blocks[index - 1]?.kind === "paragraph";
      return (spaced ? "<div><br></div>" : "") + renderBlock(block, inItem);
    })
    .join("");
}

/** Whether Markdown starts and ends with a paragraph, rather than another block. */
export function markdownTextEdges(markdown: string) {
  const blocks = parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n"));
  return {
    first: blocks[0]?.kind === "paragraph",
    last: blocks[blocks.length - 1]?.kind === "paragraph",
  };
}

function renderBlock(block: Block, inItem: boolean): string {
  switch (block.kind) {
    case "paragraph": {
      const html = renderLines(block.lines);
      // A paragraph is a line of the editor, its breaks inside it.
      return `<div>${html}</div>`;
    }
    case "heading":
      return `<h${block.level}>${renderInline(trimSpaces(block.text))}</h${block.level}>`;
    case "code":
      return `<pre><code>${escapeHtml(block.text)}</code></pre>`;
    case "rule":
      return "<hr>";
    case "quote":
      return `<blockquote>${renderBlocks(block.blocks, false)}</blockquote>`;
    case "list": {
      const tag = block.ordered ? "ol" : "ul";
      const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
      const items = block.items.map((item) => `<li>${renderItem(item)}</li>`).join("");
      return `<${tag}${start}>${items}</${tag}>`;
    }
    case "table": {
      const width = Math.max(block.header.length, ...block.rows.map((row) => row.length));
      const row = (cells: string[]) =>
        `<tr>${Array.from({ length: width }, (_, index) => `<td>${renderInline(cells[index] ?? "")}</td>`).join("")}</tr>`;
      // Azure DevOps' own tables have no header cells: the first row is a row.
      return `<table><tbody>${[block.header, ...block.rows].map(row).join("")}</tbody></table>`;
    }
  }
}

/** A list item: its first paragraph inline, then its other blocks. */
function renderItem(blocks: Block[]): string {
  const [first, ...rest] = blocks;
  if (!first) return "";
  const lead = first.kind === "paragraph" ? renderLines(first.lines) : renderBlock(first, true);
  return lead + renderBlocks(rest, true);
}

/**
 * A paragraph's lines, each line break kept as one. Two trailing spaces or a
 * backslash mark a hard break, which every break already is.
 */
function renderLines(lines: string[]) {
  return renderInline(
    lines
      .map((line, index) => {
        const text = trimSpaces(line);
        // Only a backslash a line break follows is a hard break.
        const hardBreak =
          index < lines.length - 1 && text.endsWith("\\") && !isEscapedAt(text, text.length - 1);
        return hardBreak ? text.slice(0, -1) : text;
      })
      .join("\n"),
  );
}

function escapeHtml(text: string) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const ESCAPABLE = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;

/** A named or numeric character reference, as CommonMark reads one. */
const ENTITY = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

type Inline =
  | { kind: "html"; html: string }
  | {
      kind: "delimiter";
      char: "*" | "_" | "~";
      count: number;
      canOpen: boolean;
      canClose: boolean;
    };

/** Inline Markdown as HTML: escapes, code, links, images, mentions and emphasis. */
export function renderInline(text: string): string {
  const tokens: Inline[] = [];
  const brackets = matchBrackets(text);
  const pushText = (value: string) => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === "html") last.html += escapeHtml(value);
    else tokens.push({ kind: "html", html: escapeHtml(value) });
  };

  let at = 0;
  while (at < text.length) {
    const char = text[at]!;

    if (char === "\n") {
      tokens.push({ kind: "html", html: "<br>" });
      at += 1;
      continue;
    }

    if (char === "&") {
      const entity = ENTITY.exec(text.slice(at));
      if (entity) {
        pushText(decodeHtmlEntities(entity[0]));
        at += entity[0].length;
        continue;
      }
    }

    if (char === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1]!)) {
      pushText(text[at + 1]!);
      at += 2;
      continue;
    }

    if (char === "`") {
      const run = /^`+/.exec(text.slice(at))![0];
      const close = findCodeClose(text, at + run.length, run.length);
      if (close === -1) {
        pushText(run);
        at += run.length;
        continue;
      }
      let code = text.slice(at + run.length, close).replace(/\n/g, " ");
      if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ") && code.trim().length > 0) {
        code = code.slice(1, -1);
      }
      tokens.push({ kind: "html", html: `<code>${escapeHtml(code)}</code>` });
      at = close + run.length;
      continue;
    }

    if (char === "!" && text[at + 1] === "[") {
      const link = parseLink(text, at + 1, brackets);
      if (link) {
        const alt = escapeHtml(decodeHtmlEntities(unescapeMarkdown(link.label)));
        const { src, size } = splitImageSize(link.url);
        tokens.push({
          kind: "html",
          html: isSafeUrl(src) ? `<img src="${escapeHtml(src)}" alt="${alt}"${size}>` : alt,
        });
        at = link.end;
        continue;
      }
    }

    if (char === "[") {
      const link = parseLink(text, at, brackets);
      if (link) {
        const mention = /^mention:([0-9a-fA-F-]{36})$/.exec(link.url);
        if (mention && link.label.startsWith("@")) {
          const id = mention[1]!.toLowerCase();
          tokens.push({
            kind: "html",
            html: `<a href="#" data-vss-mention="version:2.0,${id}">${escapeHtml(unescapeMarkdown(link.label))}</a>`,
          });
        } else {
          // A link to a script or other unsafe address keeps only its text.
          tokens.push({
            kind: "html",
            html: isSafeUrl(link.url)
              ? `<a href="${escapeHtml(link.url)}">${renderInline(link.label)}</a>`
              : renderInline(link.label),
          });
        }
        at = link.end;
        continue;
      }
    }

    if (char === "<") {
      const autolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*)>/.exec(text.slice(at));
      if (autolink && isSafeUrl(autolink[1]!)) {
        tokens.push({
          kind: "html",
          html: `<a href="${escapeHtml(autolink[1]!)}">${escapeHtml(autolink[1]!)}</a>`,
        });
        at += autolink[0].length;
        continue;
      }
    }

    if (char === "*" || char === "_" || char === "~") {
      const run = new RegExp(`^\\${char}+`).exec(text.slice(at))![0];
      if (char === "~" && run.length !== 2) {
        pushText(run);
        at += run.length;
        continue;
      }
      const before = at === 0 ? " " : text[at - 1]!;
      const after = at + run.length >= text.length ? " " : text[at + run.length]!;
      const leftFlanking =
        !/\s/.test(after) && (!isPunctuation(after) || /\s/.test(before) || isPunctuation(before));
      const rightFlanking =
        !/\s/.test(before) && (!isPunctuation(before) || /\s/.test(after) || isPunctuation(after));
      const canOpen =
        char === "_" ? leftFlanking && (!rightFlanking || isPunctuation(before)) : leftFlanking;
      const canClose =
        char === "_" ? rightFlanking && (!leftFlanking || isPunctuation(after)) : rightFlanking;
      tokens.push({ kind: "delimiter", char, count: run.length, canOpen, canClose });
      at += run.length;
      continue;
    }

    pushText(char);
    at += 1;
  }

  return resolveEmphasis(tokens);
}

/**
 * An image's address without the size html-markdown.ts carries in it, and
 * that size as attributes. Only sizes it could have written are taken.
 */
function splitImageSize(url: string) {
  const mark = url.lastIndexOf(IMAGE_SIZE_MARK);
  if (mark === -1) return { src: url, size: "" };
  const params = new URLSearchParams(url.slice(mark + IMAGE_SIZE_MARK.length));
  let size = "";
  for (const name of ["width", "height"]) {
    const value = params.get(name);
    if (value && /^\d+%?$/.test(value)) size += ` ${name}="${value}"`;
  }
  const style = params.get("style");
  if (style && /^(?:(?:max-)?(?:width|height):\d+(?:\.\d+)?(?:px|%);?)+$/.test(style)) {
    size += ` style="${escapeHtml(style)}"`;
  }
  return { src: url.slice(0, mark), size };
}

/** Whether an address is web, mail or relative, never a script or data. */
function isSafeUrl(url: string) {
  // A browser drops control characters, and tabs and newlines anywhere, before
  // it reads the scheme, so any of them could hide one.
  if (/[\u0000-\u001F\u007F]/.test(url)) return false;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url.trim())?.[1]?.toLowerCase();
  return scheme === undefined || scheme === "http" || scheme === "https" || scheme === "mailto";
}

function isPunctuation(char: string) {
  return /[\p{P}\p{S}]/u.test(char);
}

/** The index of the backtick run of `length` that closes a code span, or -1. */
function findCodeClose(text: string, from: number, length: number) {
  const pattern = /`+/g;
  pattern.lastIndex = from;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    if (match[0].length === length) return match.index;
  }
  return -1;
}

/**
 * Each `[` and the `]` that closes it, found in one pass: escapes and code
 * spans hold no brackets, and an unclosed `[` closes nothing.
 */
function matchBrackets(text: string) {
  const matches = new Map<number, number>();
  const open: number[] = [];
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\") {
      at += 1;
    } else if (char === "`") {
      const run = /^`+/.exec(text.slice(at, at + 1000))![0];
      const end = findCodeClose(text, at + run.length, run.length);
      at = end === -1 ? at + run.length - 1 : end + run.length - 1;
    } else if (char === "[") {
      open.push(at);
    } else if (char === "]" && open.length > 0) {
      matches.set(open.pop()!, at);
    }
  }
  return matches;
}

/** A link or image at `[`: its label, its address and where it ends. */
function parseLink(text: string, open: number, brackets: Map<number, number>) {
  const close = brackets.get(open) ?? -1;
  if (close === -1 || text[close + 1] !== "(") return undefined;
  const destination = parseDestination(text, close + 2);
  if (!destination) return undefined;
  return {
    label: text.slice(open + 1, close),
    url: decodeHtmlEntities(unescapeMarkdown(destination.url)),
    end: destination.end,
  };
}

/**
 * A link's destination and optional title from `from`, just after its `(`,
 * as CommonMark reads them: in angle brackets, or up to a space with escapes
 * and balanced parentheses. Undefined when no `)` closes it.
 */
function parseDestination(text: string, from: number) {
  let at = from;
  const skipSpaces = () => {
    while (at < text.length && /[ \t\n]/.test(text[at]!)) at += 1;
  };
  skipSpaces();
  let url = "";
  if (text[at] === "<") {
    at += 1;
    while (at < text.length && text[at] !== ">") {
      if (text[at] === "\n" || text[at] === "<") return undefined;
      if (text[at] === "\\" && at + 1 < text.length) {
        url += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      url += text[at];
      at += 1;
    }
    if (text[at] !== ">") return undefined;
    at += 1;
  } else {
    let depth = 0;
    while (at < text.length) {
      const char = text[at]!;
      if (char === "\\" && at + 1 < text.length && ESCAPABLE.test(text[at + 1]!)) {
        url += text.slice(at, at + 2);
        at += 2;
        continue;
      }
      if (/[\s\u0000-\u001F]/.test(char)) break;
      if (char === "(") depth += 1;
      if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      url += char;
      at += 1;
    }
    if (depth !== 0) return undefined;
  }
  skipSpaces();
  const title = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\))/.exec(text.slice(at));
  if (title && /[ \t\n]/.test(text[at - 1] ?? "")) {
    at += title[0].length;
    skipSpaces();
  }
  if (text[at] !== ")") return undefined;
  return { url, end: at + 1 };
}

function unescapeMarkdown(text: string) {
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "$1");
}

/**
 * Pairs emphasis delimiters, CommonMark's way, and renders the tokens. Open
 * delimiters wait on a stack, and a closer that finds no opener marks where
 * later closers of its kind stop looking, so pairing takes linear time.
 */
function resolveEmphasis(tokens: Inline[]): string {
  type Delimiter = Extract<Inline, { kind: "delimiter" }> & { open: string[]; close: string[] };
  const items = tokens.map((token) =>
    token.kind === "delimiter" ? ({ ...token, open: [], close: [] } as Delimiter) : token,
  );
  // Indexes of the delimiters that can still open, in order.
  const openers: number[] = [];
  // Per kind of closer, the index below which no opener can match it.
  const bottoms = new Map<string, number>();
  for (let index = 0; index < items.length; index += 1) {
    const close = items[index]!;
    if (close.kind !== "delimiter") continue;
    if (close.canClose) {
      const kind = `${close.char}${close.canOpen ? 1 : 0}${close.count % 3}`;
      const bottom = bottoms.get(kind) ?? -1;
      let at = openers.length - 1;
      while (close.count > 0 && at >= 0 && openers[at]! > bottom) {
        const open = items[openers[at]!] as Delimiter;
        // A run that can both open and close pairs only when the sum is not
        // a multiple of three, unless both are.
        if (
          open.char !== close.char ||
          ((open.canClose || close.canOpen) &&
            (open.count + close.count) % 3 === 0 &&
            !(open.count % 3 === 0 && close.count % 3 === 0))
        ) {
          at -= 1;
          continue;
        }
        const used = close.char === "~" ? 2 : open.count >= 2 && close.count >= 2 ? 2 : 1;
        const tag = close.char === "~" ? "del" : used === 2 ? "strong" : "em";
        open.count -= used;
        close.count -= used;
        open.open.unshift(`<${tag}>`);
        close.close.push(`</${tag}>`);
        // Delimiters between the pair can no longer open across it.
        openers.length = open.count > 0 ? at + 1 : at;
        at = openers.length - 1;
      }
      if (close.count > 0) bottoms.set(kind, index - 1);
    }
    if (close.canOpen && close.count > 0) openers.push(index);
  }
  return items
    .map((item) => {
      if (item.kind === "html") return item.html;
      const rest = item.char.repeat(item.count);
      // Closers end before what is left of the run, openers start after it.
      return item.close.join("") + rest + item.open.join("");
    })
    .join("");
}
