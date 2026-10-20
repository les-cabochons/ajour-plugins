// Converts an Azure DevOps HTML description to the markdown Ajour renders in
// backlog item notes. The parser is lenient, like the editor's HTML: unclosed
// list items and paragraphs close themselves, stray end tags are ignored, and
// lists nested straight inside a list join the previous item. Ajour keeps
// single line breaks, so <br> and each <div> line become plain newlines.

type HtmlElement = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: HtmlNode[];
};

type HtmlNode = { kind: "text"; text: string } | HtmlElement;

const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "col", "area", "base", "wbr", "source"]);
const DROPPED_TAGS = new Set(["script", "style", "head", "title", "template", "noscript"]);
// Blocks set apart by a blank line.
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "blockquote", "pre", "table", "hr"]);
// Blocks that only start a new line, as the editor's one <div> per line.
const LINE_TAGS = new Set([
  "div", "section", "article", "header", "footer", "main", "aside", "nav", "figure", "figcaption",
  "address", "center", "li", "dl", "dt", "dd", "details", "summary", "form", "fieldset",
]);
// Opening one of these closes an open sibling of the same kind.
const SELF_CLOSING_SIBLINGS: Record<string, string[]> = {
  li: ["ul", "ol"],
  p: [],
  tr: ["table", "thead", "tbody", "tfoot"],
  td: ["tr"],
  th: ["tr"],
};

export function htmlToMarkdown(html: string): string | undefined {
  return htmlToMarkdownWithLosses(html).markdown;
}

/**
 * The same conversion, naming what Markdown cannot hold and the conversion
 * dropped, such as "text colour" (Ajour's ADR 0009). Images never count as
 * lost: they keep their address, which is all Azure DevOps needs.
 */
export function htmlToMarkdownWithLosses(html: string): {
  markdown: string | undefined;
  lost: string[];
} {
  const previous = losses;
  losses = new Set();
  try {
    const markdown = renderFlow(parseHtml(html))
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return { markdown: markdown.length > 0 ? markdown : undefined, lost: [...losses] };
  } finally {
    losses = previous;
  }
}

/** What the conversion under way dropped. */
let losses: Set<string> | undefined;

function lose(what: string) {
  losses?.add(what);
}

const EMPTY_STYLE_VALUES = new Set(["", "inherit", "initial", "unset", "transparent", "none"]);
const CODE_TAGS = new Set(["pre", "code", "kbd", "samp", "tt"]);

type Emphasis = "bold" | "italic" | "strike";
const EMPHASIS_MARKERS: Record<Emphasis, string> = { bold: "**", italic: "_", strike: "~~" };

/**
 * The emphasis the content being rendered already has, so nested emphasis,
 * as `<span style="font-style:italic"><i>x</i></span>`, is applied once.
 */
const activeEmphasis: Record<Emphasis, number> = { bold: 0, italic: 0, strike: 0 };

/** Renders an element's content with its tag's and its style's emphasis. */
function renderEmphasized(
  element: HtmlElement,
  tagEmphasis: Emphasis | undefined,
  render: () => string = () => renderInlineChildren(element.children),
): string {
  const styled = styledEmphasis(element);
  const wanted = new Set<Emphasis>(tagEmphasis ? [tagEmphasis] : []);
  if (styled.bold) wanted.add("bold");
  if (styled.italic) wanted.add("italic");
  if (styled.strike) wanted.add("strike");
  const applied = [...wanted].filter((kind) => activeEmphasis[kind] === 0);
  for (const kind of applied) activeEmphasis[kind] += 1;
  let text: string;
  try {
    text = render();
  } finally {
    for (const kind of applied) activeEmphasis[kind] -= 1;
  }
  for (const kind of ["strike", "italic", "bold"] as const) {
    if (applied.includes(kind)) text = wrap(text, EMPHASIS_MARKERS[kind]);
  }
  return text;
}

/** Whether the character at `index` is escaped: an odd run of backslashes before it. */
function isEscaped(text: string, index: number) {
  let backslashes = 0;
  for (let at = index - 1; at >= 0 && text[at] === "\\"; at -= 1) backslashes += 1;
  return backslashes % 2 === 1;
}

/**
 * Joins two runs of inline Markdown. Where one run's emphasis ends right as
 * the next run's same emphasis starts, as in two bold spans side by side,
 * the markers meet and would show; the runs join into one emphasis instead.
 */
function joinInline(left: string, right: string): string {
  let joinedLeft = left;
  let joinedRight = right;
  for (let merged = true; merged; ) {
    merged = false;
    for (const marker of ["**", "~~", "_"]) {
      if (
        joinedLeft.endsWith(marker) &&
        joinedRight.startsWith(marker) &&
        joinedLeft.length > marker.length &&
        !isEscaped(joinedLeft, joinedLeft.length - marker.length)
      ) {
        joinedLeft = joinedLeft.slice(0, -marker.length);
        joinedRight = joinedRight.slice(marker.length);
        merged = true;
      }
    }
  }
  return joinedLeft + joinedRight;
}

/** The bold, italic and strikethrough an element's style asks for, as Markdown can hold them. */
function styledEmphasis(element: HtmlElement) {
  const style = (element.attrs.style ?? "").toLowerCase().replace(/\s+/g, "");
  const weight = /(?:^|;)font-weight:([^;]+)/.exec(style)?.[1] ?? "";
  return {
    bold: weight === "bold" || weight === "bolder" || Number(weight) >= 600,
    italic: /(?:^|;)font-style:(?:italic|oblique)/.test(style),
    strike: /(?:^|;)text-decoration(?:-line)?:[^;]*line-through/.test(style),
  };
}

/** Notes what an element's styling or attributes carry that Markdown cannot. */
function noteLosses(element: HtmlElement) {
  const declarations = new Map<string, string>();
  for (const declaration of (element.attrs.style ?? "").toLowerCase().split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
  }
  const has = (name: string) => {
    const value = declarations.get(name);
    return value !== undefined && !EMPTY_STYLE_VALUES.has(value);
  };
  if (has("color") || (element.tag === "font" && element.attrs.color)) lose("text colour");
  if (has("background-color") || has("background")) lose("highlight");
  // Code keeps its own font as a code span or block, so its font is not lost.
  if (
    !CODE_TAGS.has(element.tag) &&
    (has("font-family") || has("font-size") || (element.tag === "font" && (element.attrs.face || element.attrs.size)))
  ) {
    lose("font");
  }
  if (isBlock(element.tag)) {
    // Markdown emphasis cannot span a block's lines, so a block's own is lost.
    const emphasis = styledEmphasis(element);
    if (emphasis.bold) lose("bold text");
    if (emphasis.italic) lose("italic text");
    if (emphasis.strike) lose("strikethrough text");
  }
  if (CODE_TAGS.has(element.tag)) {
    // Code keeps its text as written, so emphasis set on it is lost.
    const emphasis = styledEmphasis(element);
    if (emphasis.bold || emphasis.italic || emphasis.strike) lose("emphasis on code");
  }
  if (element.tag === "sup") lose("superscript");
  if (element.tag === "sub") lose("subscript");
  if (element.tag === "mark") lose("highlight");
  const decoration = declarations.get("text-decoration") ?? declarations.get("text-decoration-line") ?? "";
  if (element.tag === "u" || element.tag === "ins" || decoration.includes("underline")) lose("underline");
  const alignment = declarations.get("text-align") ?? element.attrs.align?.toLowerCase() ?? "";
  if (["center", "right", "justify"].includes(alignment)) lose("text alignment");
  if (element.tag === "input" && (element.attrs.type ?? "").toLowerCase() === "checkbox") lose("checkboxes");
  if (["iframe", "video", "audio", "object", "embed"].includes(element.tag)) lose("embedded content");
  if (
    (element.tag === "td" || element.tag === "th") &&
    (Number(element.attrs.colspan ?? 1) > 1 || Number(element.attrs.rowspan ?? 1) > 1)
  ) {
    lose("merged table cells");
  }
}

export function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, token: string) => {
    const normalizedToken = token.toLowerCase();
    if (normalizedToken.startsWith("#x")) {
      const codePoint = Number.parseInt(normalizedToken.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }

    if (normalizedToken.startsWith("#")) {
      const codePoint = Number.parseInt(normalizedToken.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }

    switch (normalizedToken) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return entity;
    }
  });
}

function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { kind: "element", tag: "#root", attrs: {}, children: [] };
  const stack: HtmlElement[] = [root];
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>/g;
  const current = () => stack[stack.length - 1] ?? root;

  let position = 0;
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    if (match.index > position) {
      current().children.push({ kind: "text", text: decodeHtmlEntities(html.slice(position, match.index)) });
    }
    position = tokens.lastIndex;

    const token = match[0];
    if (token.startsWith("<!")) {
      continue;
    }

    const tag = /^<\/?\s*([a-zA-Z][\w:-]*)/.exec(token)?.[1]?.toLowerCase();
    if (!tag) {
      continue;
    }

    if (token.startsWith("</")) {
      const index = stack.map((element) => element.tag).lastIndexOf(tag);
      if (index > 0) {
        stack.length = index;
      }
      continue;
    }

    if (DROPPED_TAGS.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, position);
      const close = end === -1 ? -1 : html.indexOf(">", end);
      position = close === -1 ? html.length : close + 1;
      tokens.lastIndex = position;
      continue;
    }

    const closes = SELF_CLOSING_SIBLINGS[tag];
    if (closes) {
      for (let index = stack.length - 1; index > 0; index -= 1) {
        const open = stack[index]?.tag ?? "";
        if (open === tag || (tag === "td" && open === "th") || (tag === "th" && open === "td")) {
          stack.length = index;
          break;
        }
        if (closes.includes(open)) {
          break;
        }
      }
    }

    const element: HtmlElement = { kind: "element", tag, attrs: parseAttributes(token), children: [] };
    noteLosses(element);
    current().children.push(element);
    if (!VOID_TAGS.has(tag) && !token.endsWith("/>")) {
      stack.push(element);
    }
  }

  if (position < html.length) {
    current().children.push({ kind: "text", text: decodeHtmlEntities(html.slice(position)) });
  }
  return root.children;
}

function parseAttributes(token: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const body = token.replace(/^<\s*[a-zA-Z][\w:-]*/, "").replace(/\/?>$/, "");
  const pattern = /([^\s"'=<>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  for (let match = pattern.exec(body); match; match = pattern.exec(body)) {
    const name = match[1]?.toLowerCase();
    if (name) {
      attrs[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
    }
  }
  return attrs;
}

function isBlock(tag: string) {
  return PARAGRAPH_TAGS.has(tag) || LINE_TAGS.has(tag);
}

function elementsOf(nodes: HtmlNode[]): HtmlElement[] {
  return nodes.filter((node): node is HtmlElement => node.kind === "element");
}

// Lays out a run of inline content and blocks: blocks the editor uses as lines
// start a new line, paragraph-like blocks stand apart with a blank line.
function renderFlow(nodes: HtmlNode[]): string {
  const items: { text: string; paragraph: boolean }[] = [];
  let inline = "";
  const flush = () => {
    const text = escapeLineStarts(cleanLines(inline));
    if (text.length > 0) {
      items.push({ text, paragraph: false });
    }
    inline = "";
  };

  for (const node of nodes) {
    if (node.kind === "text") {
      inline += escapeText(collapseWhitespace(node.text));
    } else if (node.tag === "br") {
      inline += "\n";
    } else if (isBlock(node.tag)) {
      flush();
      const text = renderBlock(node);
      if (text.trim().length > 0) {
        items.push({ text, paragraph: PARAGRAPH_TAGS.has(node.tag) });
      }
    } else {
      inline = joinInline(inline, renderInline(node));
    }
  }
  flush();

  return items
    .map((item, index) => {
      const previous = items[index - 1];
      if (!previous) return item.text;
      return (previous.paragraph || item.paragraph ? "\n\n" : "\n") + item.text;
    })
    .join("");
}

function renderBlock(element: HtmlElement): string {
  switch (element.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      const text = singleLine(renderFlow(element.children));
      return text ? `${"#".repeat(Number(element.tag[1]))} ${text}` : "";
    }
    case "ul":
    case "ol":
      return renderList(element);
    case "li":
      return `- ${indentContinuation(renderListItem(element), "  ")}`;
    case "blockquote":
      return prefixLines(renderFlow(element.children), "> ");
    case "pre":
      return renderCodeBlock(element);
    case "table":
      return renderTable(element);
    case "hr":
      return "---";
    default:
      return renderFlow(element.children);
  }
}

function renderList(list: HtmlElement): string {
  const ordered = list.tag === "ol";
  let number = Number.parseInt(list.attrs.start ?? "", 10) || 1;
  const entries: { text: string; indent: number }[] = [];

  for (const child of elementsOf(list.children)) {
    if (child.tag === "ul" || child.tag === "ol") {
      const nested = renderList(child);
      const previous = entries[entries.length - 1];
      if (!nested) continue;
      if (previous) {
        previous.text += `\n${indentAll(nested, " ".repeat(previous.indent))}`;
      } else {
        entries.push({ text: nested, indent: 0 });
      }
      continue;
    }

    const body = child.tag === "li" ? renderListItem(child) : renderBlock(child);
    if (child.tag !== "li" && body.trim().length === 0) continue;
    const marker = ordered ? `${number}. ` : "- ";
    number += 1;
    entries.push({ text: marker + indentContinuation(body, " ".repeat(marker.length)), indent: marker.length });
  }

  return entries.map((entry) => entry.text).join("\n");
}

function renderListItem(item: HtmlElement): string {
  return renderFlow(item.children).replace(/\n{2,}/g, "\n");
}

function renderCodeBlock(element: HtmlElement): string {
  const code = textContent(element).replace(/^\n/, "").replace(/\n+$/, "");
  if (code.trim().length === 0) {
    return "";
  }
  const fence = "`".repeat(Math.max(3, longestRun(code, "`") + 1));
  return `${fence}\n${code}\n${fence}`;
}

function renderTable(table: HtmlElement): string {
  const rows: string[][] = [];
  const collectRows = (nodes: HtmlNode[]) => {
    for (const child of elementsOf(nodes)) {
      if (child.tag === "tr") {
        rows.push(
          elementsOf(child.children)
            .filter((cell) => cell.tag === "td" || cell.tag === "th")
            .map((cell) => {
              // A cell holds one line: a list or other block in it is lost, and
              // the cell's own emphasis goes on its text.
              if (hasBlockInside(cell)) lose("lists or blocks in table cells");
              return renderEmphasized(cell, undefined, () => {
                const text = renderFlow(cell.children);
                if (text.includes("\n")) lose("line breaks in table cells");
                return singleLine(text);
              });
            }),
        );
      } else if (child.tag === "thead" || child.tag === "tbody" || child.tag === "tfoot") {
        collectRows(child.children);
      }
    }
  };
  collectRows(table.children);

  const nonEmpty = rows.filter((row) => row.length > 0);
  const [header, ...body] = nonEmpty;
  if (!header) {
    return "";
  }
  const width = Math.max(...nonEmpty.map((row) => row.length));
  const line = (cells: string[]) =>
    `| ${Array.from({ length: width }, (_, index) => cells[index] ?? "").join(" | ")} |`;
  return [line(header), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

const CELL_BLOCK_TAGS = new Set(["ul", "ol", "li", "blockquote", "pre", "table", "hr", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** Whether a table cell holds a block Markdown cannot put in a cell. */
function hasBlockInside(element: HtmlElement): boolean {
  return elementsOf(element.children).some(
    (child) => CELL_BLOCK_TAGS.has(child.tag) || hasBlockInside(child),
  );
}

function renderInline(element: HtmlElement): string {
  switch (element.tag) {
    case "b":
    case "strong":
      return renderEmphasized(element, "bold");
    case "i":
    case "em":
      return renderEmphasized(element, "italic");
    case "s":
    case "strike":
    case "del":
      return renderEmphasized(element, "strike");
    case "code":
    case "kbd":
    case "samp":
    case "tt":
      return renderCodeSpan(textContent(element));
    case "a": {
      // An Azure DevOps mention, as Ajour writes one.
      const mention = /^version:[\d.]+,([0-9a-f-]{36})$/i.exec(element.attrs["data-vss-mention"] ?? "");
      if (mention) {
        const name = textContent(element).trim().replace(/^@/, "").replace(/[[\]\\]/g, "");
        return `[@${name || "someone"}](mention:${mention[1]!.toLowerCase()})`;
      }
      // A link's own style, such as a struck-out old link, goes inside its text.
      const text = renderEmphasized(element, undefined);
      const href = element.attrs.href?.trim();
      if (!href || text.trim().length === 0) return text;
      return `[${text.trim()}](${encodeUrl(href)})`;
    }
    case "img": {
      const src = element.attrs.src?.trim();
      return src ? `![${escapeText(element.attrs.alt?.trim() ?? "")}](${encodeUrl(src)})` : "";
    }
    case "input":
      return "";
    default:
      // A span's style can carry the emphasis Markdown has, as pasted text does.
      return renderEmphasized(element, undefined);
  }
}

function renderInlineChildren(nodes: HtmlNode[]): string {
  return nodes
    .map((node) => {
      if (node.kind === "text") return escapeText(collapseWhitespace(node.text));
      if (node.tag === "br") return "\n";
      if (isBlock(node.tag)) return `\n${renderBlock(node)}\n`;
      return renderInline(node);
    })
    .reduce(joinInline, "");
}

function renderCodeSpan(code: string): string {
  const text = collapseWhitespace(code);
  if (text.trim().length === 0) {
    return text;
  }
  const fence = "`".repeat(longestRun(text, "`") + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${padding}${text}${padding}${fence}`;
}

function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.text;
  if (node.tag === "br") return "\n";
  const text = node.children.map(textContent).join("");
  return isBlock(node.tag) && node.tag !== "pre" ? `${text}\n` : text;
}

// Markers must touch the text they wrap, so surrounding spaces move outside.
function wrap(text: string, marker: string): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  if (!match || match[2] === "") {
    return text;
  }
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function encodeUrl(url: string): string {
  return url.replace(/[()\s]/g, encodeURIComponent);
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ");
}

function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function escapeText(text: string): string {
  return text.replace(/[\\`*_[\]~|]/g, "\\$&");
}

// Text that starts a line with "#", ">", "- ", "+ ", "1. " or a run of "-" or
// "=" would turn into a heading, quote or list. Leading spaces would turn into
// a code block.
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .trimStart()
        .replace(/^(#{1,6}(?=\s|$)|>|[-+](?=\s)|[-=](?=[-=\s]*$)|\d+(?=[.)]\s))/, (token: string) =>
          /^\d/.test(token) ? `${token}\\` : `\\${token}`,
        ),
    )
    .join("\n");
}

function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function prefixLines(text: string, prefix: string): string {
  return text
    .split("\n")
    .map((line) => (line.length > 0 ? `${prefix}${line}` : prefix.trimEnd()))
    .join("\n");
}

function indentContinuation(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line, index) => (index === 0 || line.length === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function indentAll(text: string, indent: string): string {
  return text
    .split("\n")
    .map((line) => (line.length === 0 ? line : `${indent}${line}`))
    .join("\n");
}

function longestRun(text: string, char: string): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}
