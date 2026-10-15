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
  const markdown = renderFlow(parseHtml(html))
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return markdown.length > 0 ? markdown : undefined;
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
      inline += renderInline(node);
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
            .map((cell) => singleLine(renderFlow(cell.children))),
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

function renderInline(element: HtmlElement): string {
  switch (element.tag) {
    case "b":
    case "strong":
      return wrap(renderInlineChildren(element.children), "**");
    case "i":
    case "em":
      return wrap(renderInlineChildren(element.children), "_");
    case "s":
    case "strike":
    case "del":
      return wrap(renderInlineChildren(element.children), "~~");
    case "code":
    case "kbd":
    case "samp":
    case "tt":
      return renderCodeSpan(textContent(element));
    case "a": {
      const text = renderInlineChildren(element.children);
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
      return renderInlineChildren(element.children);
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
    .join("");
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
