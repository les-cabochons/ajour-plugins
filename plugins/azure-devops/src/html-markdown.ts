import { NAMED_ENTITIES } from "./html-entities.js";

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
  /** Where the element's tag starts in the HTML. */
  start: number;
  /** Where its end tag starts, or where the HTML ends when it has none. */
  end?: number;
};

type HtmlNode = { kind: "text"; text: string; start: number } | HtmlElement;

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
    const markdown = finishMarkdown(renderFlow(unwrap(parseHtml(html), html.length).nodes));
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
const EMPTY_COLOUR_VALUES = new Set(["", "inherit", "initial", "unset", "currentcolor"]);
const CODE_TAGS = new Set(["pre", "code", "kbd", "samp", "tt"]);

type Emphasis = "bold" | "italic" | "strike";
// Italic is `*`, which, unlike `_`, also works inside a word.
const EMPHASIS_MARKERS: Record<Emphasis, string> = { bold: "**", italic: "*", strike: "~~" };

/**
 * The emphasis the content being rendered already has, so nested emphasis,
 * as `<span style="font-style:italic"><i>x</i></span>`, is applied once.
 */
const activeEmphasis: Record<Emphasis, number> = { bold: 0, italic: 0, strike: 0 };

/** How many headings, bold by default, the content being rendered is in. */
let headingDepth = 0;

/** Renders an element's content with its tag's and its style's emphasis. */
function renderEmphasized(
  element: HtmlElement,
  tagEmphasis: Emphasis | undefined,
  render: () => string = () => renderInlineChildren(element.children),
): string {
  const styled = styledEmphasis(element);
  noteEmphasisResets(element, tagEmphasis);
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

function isItalicJoin(left: number, right: number) {
  return left % 2 === 1 && right % 2 === 1 && (left === 1 || right === 1);
}

function starsAtEnd(text: string) {
  return /\**$/.exec(text)![0].length;
}

function starsAtStart(text: string) {
  return /^\**/.exec(text)![0].length;
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
  // A `!` of the text right before a link would make it an image.
  if (joinedRight.startsWith("[") && joinedLeft.endsWith("!") && !isEscaped(joinedLeft, joinedLeft.length - 1)) {
    joinedLeft = `${joinedLeft.slice(0, -1)}\\!`;
  }
  // Two code spans side by side would join their backticks into one fence.
  if (joinedLeft.endsWith("`") && joinedRight.startsWith("`") && !isEscaped(joinedLeft, joinedLeft.length - 1)) {
    lose("other formatting");
  }
  for (let merged = true; merged; ) {
    merged = false;
    for (const marker of ["**", "~~", "*"]) {
      if (
        joinedLeft.endsWith(marker) &&
        joinedRight.startsWith(marker) &&
        joinedLeft.length > marker.length &&
        !isEscaped(joinedLeft, joinedLeft.length - marker.length) &&
        // A lone `*` is italic where each side's stars are italic alone or
        // italic within bold (three), and one side has italic alone.
        (marker !== "*" || isItalicJoin(starsAtEnd(joinedLeft), starsAtStart(joinedRight)))
      ) {
        joinedLeft = joinedLeft.slice(0, -marker.length);
        joinedRight = joinedRight.slice(marker.length);
        merged = true;
      }
    }
  }
  // Joining can bring a `!` right before a link, as from `<i>!</i><i><a>`.
  if (joinedRight.startsWith("[") && joinedLeft.endsWith("!") && !isEscaped(joinedLeft, joinedLeft.length - 1)) {
    joinedLeft = `${joinedLeft.slice(0, -1)}\\!`;
  }
  return joinedLeft + joinedRight;
}

/**
 * Notes a style that turns off emphasis around it, as plain text inside bold:
 * Markdown cannot end emphasis there, so the text would take it.
 */
function noteEmphasisResets(element: HtmlElement, tagEmphasis: Emphasis | undefined) {
  const style = (element.attrs.style ?? "").toLowerCase().replace(/\s+/g, "");
  const weight = /(?:^|;)font-weight:([^;]+)/.exec(style)?.[1];
  const fontStyle = /(?:^|;)font-style:([^;]+)/.exec(style)?.[1];
  const decoration = /(?:^|;)text-decoration(?:-line)?:([^;]+)/.exec(style)?.[1];
  // `initial` is the normal weight and style, so it turns emphasis off.
  const inherited = (value: string) => ["inherit", "unset"].includes(value);
  // Emphasis around it, or the element's own tag, as `<b style="font-weight:normal">`.
  const has = (kind: Emphasis) =>
    activeEmphasis[kind] > 0 || tagEmphasis === kind || (kind === "bold" && headingDepth > 0);
  const styled = styledEmphasis(element);
  if (
    (weight && !inherited(weight) && has("bold") && !styled.bold) ||
    (fontStyle && !inherited(fontStyle) && has("italic") && !styled.italic) ||
    (decoration && !inherited(decoration) && has("strike") && !styled.strike)
  ) {
    lose("plain text inside emphasis");
  }
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
function noteLosses(element: HtmlElement, ancestors: HtmlElement[]) {
  const declarations = new Map<string, string>();
  for (const declaration of (element.attrs.style ?? "").toLowerCase().split(";")) {
    const colon = declaration.indexOf(":");
    if (colon > 0) declarations.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
  }
  const has = (name: string, empty = EMPTY_STYLE_VALUES) => {
    const value = declarations.get(name);
    return value !== undefined && !empty.has(value);
  };
  // A transparent colour hides the text, so only the inherited one is no colour.
  if (has("color", EMPTY_COLOUR_VALUES) || (element.tag === "font" && element.attrs.color)) lose("text colour");
  if (has("background-color") || has("background")) lose("highlight");
  // Code keeps its own font family as a code span or block, but not its size.
  if (
    has("font-family") ||
    has("font-size") ||
    (element.tag === "font" && (element.attrs.face || element.attrs.size))
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
  // Markdown tables have no header cells of their own; the write gives none.
  if (element.tag === "th" || element.tag === "thead") lose("table header cells");
  if (
    ["ol", "ul", "li"].includes(element.tag) ||
    declarations.has("list-style-type") ||
    declarations.has("list-style")
  ) {
    noteListLosses(element, declarations, ancestors);
  }
  if (element.tag === "img") noteImageLosses(element);
  if (element.tag === "sup") lose("superscript");
  if (element.tag === "sub") lose("subscript");
  if (element.tag === "mark") lose("highlight");
  const decoration = declarations.get("text-decoration") ?? declarations.get("text-decoration-line") ?? "";
  if (element.tag === "u" || element.tag === "ins" || decoration.includes("underline")) lose("underline");
  const alignment = declarations.get("text-align") ?? element.attrs.align?.toLowerCase() ?? "";
  if (!["", "left", "start", "inherit", "initial", "unset"].includes(alignment)) lose("text alignment");
  const inputType = (element.attrs.type ?? "").toLowerCase();
  if (element.tag === "input" && inputType === "checkbox") lose("checkboxes");
  else if (["input", "select", "textarea", "button"].includes(element.tag) && inputType !== "hidden") {
    lose("form fields");
  }
  if (["iframe", "video", "audio", "object", "embed"].includes(element.tag)) lose("embedded content");
  if (
    (element.tag === "td" || element.tag === "th") &&
    ((element.attrs.colspan ?? "1").trim() !== "1" || (element.attrs.rowspan ?? "1").trim() !== "1")
  ) {
    lose("merged table cells");
  }
  noteUnknownFormatting(element);
}

/** The tags whose look the Markdown and the write keep, or whose loss has a name. */
const KNOWN_TAGS = new Set([
  "p", "div", "span", "br", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "blockquote",
  "pre", "code", "kbd", "samp", "tt", "b", "strong", "i", "em", "s", "strike", "del", "a", "img",
  "table", "thead", "tbody", "tfoot", "tr", "td", "th", "hr", "font", "u", "ins", "sup", "sub",
  "mark", "input", "iframe", "video", "audio", "object", "embed", "section", "article", "header",
  "footer", "main", "nav", "aside",
]);

/** Attributes that change nothing a reader sees. */
const NEUTRAL_ATTRIBUTE = /^(?:class|lang|title|role|data-[\w-]+|aria-[\w-]+)$/;

/** The attributes each tag may carry, read or named as lost elsewhere. */
const TAG_ATTRIBUTES: Record<string, string[]> = {
  a: ["href", "target", "rel", "data-vss-mention"],
  img: ["src", "alt", "width", "height"],
  ol: ["start", "type", "reversed"],
  li: ["value"],
  td: ["colspan", "rowspan"],
  th: ["colspan", "rowspan"],
  font: ["color", "face", "size"],
  input: ["type", "checked", "disabled"],
};

// Only the values a write gives back as they look: bold as 700 and normal as
// 400, italic, and strikethrough. A lighter, semi-bold or relative weight, an
// oblique style, or a decoration turned off, as on a link, looks otherwise.
const EMPHASIS_VALUES: Record<string, RegExp> = {
  "font-weight": /^(?:bold|normal|400|700)$/,
  "font-style": /^(?:normal|italic)$/,
  "text-decoration": /^(?:(?:line-through|underline)\s*)+$/,
  "text-decoration-line": /^(?:(?:line-through|underline)\s*)+$/,
};

/** Style properties read, or named as lost elsewhere, when written plainly. */
const NAMED_STYLE_PROPERTIES = new Set([
  "color", "background-color", "background", "font-family", "font-size", "text-align",
  "list-style-type", "list-style",
]);

/**
 * Names anything else an element carries as "other formatting": a tag,
 * attribute or style the Markdown cannot keep and no other loss names, a
 * style set twice or `!important`. Only what is known to come back on write
 * leaves a description editable.
 */
function noteUnknownFormatting(element: HtmlElement) {
  if (!KNOWN_TAGS.has(element.tag)) lose("other formatting");
  // Embedded content is lost whole, under its own name.
  if (["iframe", "video", "audio", "object", "embed"].includes(element.tag)) return;
  const allowed = TAG_ATTRIBUTES[element.tag] ?? [];
  for (const name of Object.keys(element.attrs)) {
    if (name === "style" || name === "align" || NEUTRAL_ATTRIBUTE.test(name) || allowed.includes(name)) continue;
    lose("other formatting");
  }
  // An image's style is checked with its size.
  if (element.tag === "img") return;
  const seen = new Map<string, string>();
  for (const declaration of (element.attrs.style ?? "").split(";")) {
    if (!declaration.trim()) continue;
    const colon = declaration.indexOf(":");
    const name = (colon > 0 ? declaration.slice(0, colon) : declaration).trim().toLowerCase();
    const value = colon > 0 ? declaration.slice(colon + 1).trim().toLowerCase() : "";
    const repeated =
      (seen.has(name) && seen.get(name) !== value) ||
      (name === "text-decoration" && seen.has("text-decoration-line")) ||
      (name === "text-decoration-line" && seen.has("text-decoration"));
    seen.set(name, value);
    if (
      repeated ||
      value.includes("!important") ||
      // A value taken from around the element looks as its surroundings do,
      // which a write does not keep.
      /^(?:inherit|initial|unset|revert|revert-layer)$/.test(value) ||
      !(NAMED_STYLE_PROPERTIES.has(name) || EMPHASIS_VALUES[name]?.test(value))
    ) {
      lose("other formatting");
    }
  }
}

/**
 * Where an image's address carries its size, so a write gives the image back
 * as it was: `#ajour-image?width=120&height=80&style=width%3A50%25`.
 */
export const IMAGE_SIZE_MARK = "#ajour-image?";

const IMAGE_SIZE_ATTRIBUTE = /^\d+%?$/;
const IMAGE_SIZE_DECLARATION = /^(?:max-)?(?:width|height)$/;
const IMAGE_SIZE_VALUE = /^\d+(?:\.\d+)?(?:px|%)$/;

/** An image's size, as the parameters its address carries, or "". */
function imageSize(element: HtmlElement) {
  const params = new URLSearchParams();
  for (const name of ["width", "height"]) {
    const value = element.attrs[name]?.trim();
    if (value && IMAGE_SIZE_ATTRIBUTE.test(value)) params.set(name, value);
  }
  const style = imageSizeStyle(element.attrs.style ?? "");
  if (style) params.set("style", style);
  return params.toString();
}

/** The size declarations of an image's style, as written again. */
function imageSizeStyle(style: string) {
  return style
    .split(";")
    .map((declaration) => declaration.split(":").map((part) => part.trim().toLowerCase()))
    .filter(([name, value]) => name && value && IMAGE_SIZE_DECLARATION.test(name) && IMAGE_SIZE_VALUE.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/** Notes what of an image only its address, text and size cannot carry. */
function noteImageLosses(element: HtmlElement) {
  // Every declaration as written, repeats included: one the size keeps drops
  // nothing, any other would be lost.
  for (const declaration of (element.attrs.style ?? "").split(";")) {
    if (!declaration.trim()) continue;
    const [name = "", value = ""] = declaration.split(":").map((part) => part.trim().toLowerCase());
    if (!(IMAGE_SIZE_DECLARATION.test(name) && IMAGE_SIZE_VALUE.test(value))) {
      lose("image styling");
      break;
    }
  }
  for (const [name, value] of Object.entries(element.attrs)) {
    if (name === "width" || name === "height") {
      if (!IMAGE_SIZE_ATTRIBUTE.test(value.trim())) lose("image styling");
    } else if (name !== "src" && name !== "alt" && name !== "style") {
      lose("image attributes");
    }
  }
  // An address that already holds the size mark could not be told from ours.
  if (element.attrs.src?.includes(IMAGE_SIZE_MARK)) lose("image attributes");
}

/** Notes numbering or markers a list or item sets that Markdown lists cannot. */
function noteListLosses(element: HtmlElement, declarations: Map<string, string>, ancestors: HtmlElement[]) {
  const type = declarations.get("list-style-type");
  const shorthand = declarations.get("list-style");
  // The marker a browser gives the list by default: bullets change with how
  // deep the list is nested; an item takes its list's.
  const lists = ancestors.filter((ancestor) => ancestor.tag === "ul" || ancestor.tag === "ol");
  const list = element.tag === "li" ? lists[lists.length - 1] : element;
  const depth = element.tag === "li" ? lists.length - 1 : lists.length;
  const marker =
    list?.tag === "ol" ? "decimal" : list?.tag === "ul" ? (["disc", "circle"][depth] ?? "square") : undefined;
  // Only a list or item may set a marker, and only the one it has anyway.
  const plain = (value: string | undefined) =>
    value === undefined || (marker !== undefined && (value === marker || (element.tag === "li" && value === "inherit")));
  const start = element.attrs.start;
  if (
    !plain(type) ||
    !plain(shorthand) ||
    (type !== undefined && shorthand !== undefined) ||
    (element.tag === "ol" && start !== undefined && !/^\d{1,9}$/.test(start.trim())) ||
    (element.tag === "ol" && element.attrs.type !== undefined && element.attrs.type !== "1") ||
    (element.tag === "ol" && "reversed" in element.attrs) ||
    (element.tag === "li" && element.attrs.value !== undefined)
  ) {
    lose("list numbering style");
  }
}

/** What HTML reads the numeric references 128 to 159 as: Windows-1252. */
const WINDOWS_1252 = [
  0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d,
  0x17d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a,
  0x153, 0x9d, 0x17e, 0x178,
];

/**
 * Character references as HTML reads them. A numeric one maps as HTML maps
 * it; a named one needs its `;` here. Anything HTML would read otherwise,
 * or as a control character, stays as written and is named as lost.
 */
export function decodeHtmlEntities(value: string) {
  return value.replace(/&(#[xX][0-9a-fA-F]+;?|#[0-9]+;?|[a-zA-Z][a-zA-Z0-9]*;?)/g, (entity, token: string) => {
    if (token.startsWith("#")) {
      const hex = token[1] === "x" || token[1] === "X";
      const digits = token.slice(hex ? 2 : 1).replace(/;$/, "");
      const codePoint = Number.parseInt(digits, hex ? 16 : 10);
      if (codePoint >= 0x80 && codePoint <= 0x9f) return String.fromCodePoint(WINDOWS_1252[codePoint - 0x80]!);
      const control = codePoint < 0x20 && ![0x09, 0x0a, 0x0c, 0x0d].includes(codePoint);
      if (codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) || control) {
        lose("characters Ajour cannot read");
        return entity;
      }
      return String.fromCodePoint(codePoint);
    }
    if (token.endsWith(";")) {
      const named = NAMED_ENTITIES.get(token.slice(0, -1));
      if (named !== undefined) return String.fromCodePoint(named);
    }
    // Shown as written, or read by HTML without its `;`: the Markdown cannot
    // give either back as it shows.
    lose("characters Ajour cannot read");
    return entity;
  });
}

function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { kind: "element", tag: "#root", attrs: {}, children: [], start: 0 };
  // Elements closed by `at`, explicitly or by a sibling, end there.
  const closeTo = (length: number, at: number) => {
    for (const element of stack.slice(length)) element.end ??= at;
    stack.length = length;
  };
  const stack: HtmlElement[] = [root];
  // A `>` inside a quoted attribute value does not end the tag.
  const tokens = /<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z](?:[^>"']|"[^"]*"|'[^']*')*>/g;
  const current = () => stack[stack.length - 1] ?? root;

  let position = 0;
  for (let match = tokens.exec(html); match; match = tokens.exec(html)) {
    if (match.index > position) {
      current().children.push({
        kind: "text",
        text: decodeHtmlEntities(html.slice(position, match.index)),
        start: position,
      });
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
        closeTo(index, match.index);
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
          closeTo(index, match.index);
          break;
        }
        if (closes.includes(open)) {
          break;
        }
      }
    }

    const element: HtmlElement = {
      kind: "element",
      tag,
      attrs: parseAttributes(token),
      children: [],
      start: match.index,
    };
    noteLosses(element, stack);
    current().children.push(element);
    if (!VOID_TAGS.has(tag) && !token.endsWith("/>")) {
      stack.push(element);
    }
  }

  if (position < html.length) {
    current().children.push({ kind: "text", text: decodeHtmlEntities(html.slice(position)), start: position });
  }
  closeTo(1, html.length);
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
/**
 * One block of a flow, from its nodes `first` to `last`. `spaced` when an
 * empty editor line, as `<div><br></div>`, comes before it.
 */
interface FlowItem {
  text: string;
  paragraph: boolean;
  spaced: boolean;
  first: number;
  last: number;
}

function flowItems(nodes: HtmlNode[]): FlowItem[] {
  const items: FlowItem[] = [];
  let inline = "";
  let inlineFirst = -1;
  let spaced = false;
  let emptyLines = 0;
  flowDepth += 1;
  const flush = (last: number) => {
    const text = escapeLineStarts(cleanLines(inline));
    // A break before a block's text, or two after it, shows an empty line the
    // Markdown has no place for.
    if (text.length > 0 && (/^[ \t]*\n/.test(inline) || /\n[ \t]*\n[ \t]*$/.test(inline))) {
      lose("extra blank lines");
    }
    if (text.length > 0) {
      noteEmptyLines();
      items.push({ text, paragraph: false, spaced, first: inlineFirst, last });
      spaced = false;
      emptyLines = 0;
    }
    inline = "";
    inlineFirst = -1;
  };
  // Only the top level keeps the HTML between blocks, with each of several
  // empty lines, and around its first and last; inside a block, several
  // empty lines in a row become one, and those at its edges go.
  const noteEmptyLines = () => {
    if (flowDepth > 1 && (emptyLines > 1 || (emptyLines > 0 && items.length === 0))) {
      lose("extra blank lines");
    }
  };

  nodes.forEach((node, index) => {
    if (node.kind === "element" && isBlock(node.tag)) {
      flush(index - 1);
      const text = renderBlock(node);
      if (trimSpaces(text).length > 0) {
        noteEmptyLines();
        items.push({ text, paragraph: PARAGRAPH_TAGS.has(node.tag), spaced, first: index, last: index });
        spaced = false;
        emptyLines = 0;
      } else if (LINE_TAGS.has(node.tag) || node.tag === "p") {
        // An empty line of the editor sets the lines around it apart.
        if (items.length > 0) spaced = true;
        emptyLines += 1;
      }
      return;
    }
    if (inlineFirst === -1) inlineFirst = index;
    if (node.kind === "text") {
      inline += escapeText(collapseWhitespace(node.text));
    } else if (node.tag === "br") {
      inline += "\n";
    } else {
      inline = joinInline(inline, renderInline(node));
    }
  });
  flush(nodes.length - 1);
  if (emptyLines > 0 && flowDepth > 1 && items.length > 0) lose("extra blank lines");
  flowDepth -= 1;
  return items;
}

/** How deep in blocks the flow being read is: 1 at a description's top. */
let flowDepth = 0;

/** The separator a flow puts before `item`, after `previous`. */
function flowSeparator(previous: FlowItem, item: FlowItem) {
  return previous.paragraph || item.paragraph || item.spaced ? "\n\n" : "\n";
}

function renderFlow(nodes: HtmlNode[]): string {
  const items = flowItems(nodes);
  return items.map((item, index) => (index === 0 ? "" : flowSeparator(items[index - 1]!, item)) + item.text).join("");
}

/**
 * A description's content: inside the line block that wraps it whole, if
 * any, which a write keeps around what it changes. Only a wrapper of
 * blocks: a single line is a block itself, and new lines written into it
 * would nest deeper on every edit. `end` is where the content ends.
 */
function unwrap(nodes: HtmlNode[], end: number): { nodes: HtmlNode[]; end: number } {
  for (;;) {
    const content = nodes.filter((node) => node.kind === "element" || node.text.trim().length > 0);
    const only = content[0];
    if (
      content.length !== 1 ||
      only?.kind !== "element" ||
      !LINE_TAGS.has(only.tag) ||
      !only.children.some((child) => child.kind === "element" && isBlock(child.tag))
    ) {
      return { nodes, end };
    }
    nodes = only.children;
    end = only.end ?? end;
  }
}

/** A top-level block of a description: its Markdown, and the HTML it came from. */
export interface MarkdownPart {
  markdown: string;
  html: string;
  /** Plain lines, which may sit right beside other lines; otherwise a block. */
  line: boolean;
  /** A block the reader sets apart by a blank line whatever comes between. */
  block: boolean;
}

/**
 * A description's Markdown, block by block, each with the HTML it came from:
 * `html` is `prefix`, then each part with `gaps[i]` before part i + 1, then
 * `suffix`, and the Markdown joins the parts with `separators`. A write can
 * keep the HTML of every block the user did not change. Undefined when the
 * blocks do not join into the description's Markdown.
 */
export function htmlToMarkdownParts(html: string):
  | { prefix: string; suffix: string; parts: MarkdownPart[]; gaps: string[]; separators: string[] }
  | undefined {
  const previous = losses;
  losses = new Set();
  try {
    const { nodes, end } = unwrap(parseHtml(html), html.length);
    const items = flowItems(nodes);
    if (items.length === 0) return undefined;
    const startOf = (index: number) => nodes[index]!.start;
    const endOf = (index: number) => nodes[index + 1]?.start ?? end;
    // Each part as the whole description's Markdown has it, its HTML as it is.
    const parts = items.map((item, index) => ({
      markdown: finishPart(item.text, index === 0, index === items.length - 1),
      html: html.slice(startOf(item.first), endOf(item.last)),
      line: !item.paragraph && !/^(?:[-*+] |\d+[.)] |>|`{3}|~{3}|\||#| {4})/m.test(item.text),
      block: item.paragraph,
    }));
    const gaps = items.slice(1).map((item, index) => html.slice(endOf(items[index]!.last), startOf(item.first)));
    const separators = items.slice(1).map((item, index) => flowSeparator(items[index]!, item));
    const joined = parts.map((part, index) => (index === 0 ? "" : separators[index - 1]) + part.markdown).join("");
    const whole = finishMarkdown(renderFlow(unwrap(parseHtml(html), html.length).nodes));
    if (joined !== whole) return undefined;
    return {
      prefix: html.slice(0, startOf(items[0]!.first)),
      suffix: html.slice(endOf(items[items.length - 1]!.last)),
      parts,
      gaps,
      separators,
    };
  } finally {
    losses = previous;
  }
}

/**
 * The whole description's Markdown as Ajour keeps it: one blank line at
 * most, nothing blank before it, and nothing blank after, non-breaking
 * spaces included, as Ajour trims the end of a description.
 */
function finishMarkdown(text: string) {
  const collapsed = text.replace(/\n{3,}/g, "\n\n");
  // More than one empty line in a row, and spaces kept at the very end, have
  // no place in the Markdown: a write would drop them.
  if (collapsed !== text) lose("extra blank lines");
  const started = collapsed.replace(/^[ \t\n\r\f]+/, "");
  const finished = started.trimEnd();
  if (/[^ \t\n\r\f]/.test(started.slice(finished.length))) lose("spaces at the end");
  return finished;
}

/** A part's Markdown as `finishMarkdown` leaves it in the whole description. */
function finishPart(text: string, first: boolean, last: boolean) {
  let finished = text.replace(/\n{3,}/g, "\n\n");
  if (first) finished = finished.replace(/^[ \t\n\r\f]+/, "");
  if (last) finished = finished.trimEnd();
  return finished;
}

/**
 * Notes an address the Markdown would change: a browser drops tabs and
 * newlines in it, which the Markdown would encode, and keeps other spaces at
 * its edges, which the Markdown would trim.
 */
function noteAddress(address: string) {
  if (/[\t\n\r]/.test(address) || address.trim() !== trimSpaces(address)) {
    lose("link addresses Ajour cannot keep");
  }
}

/** Whether an element holds a line break. */
function hasBreak(element: HtmlElement): boolean {
  return elementsOf(element.children).some((child) => child.tag === "br" || hasBreak(child));
}

/** Whether an element holds anything but plain spans: formatting a mention cannot keep. */
function hasFormattingInside(element: HtmlElement): boolean {
  return elementsOf(element.children).some(
    (child) => child.tag !== "span" || Boolean(child.attrs.style) || hasFormattingInside(child),
  );
}

function renderBlock(element: HtmlElement): string {
  switch (element.tag) {
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6": {
      // A heading is bold by default, so its own normal weight is lost too.
      noteEmphasisResets(element, "bold");
      // A Markdown heading is one line.
      headingDepth += 1;
      let text: string;
      try {
        const lines = renderFlow(element.children);
        if (hasBreak(element) || lines.includes("\n")) lose("line breaks in headings");
        text = singleLine(lines);
      } finally {
        headingDepth -= 1;
      }
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
  const start = Number.parseInt(list.attrs.start ?? "", 10);
  let number = Number.isNaN(start) ? 1 : start;
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
  // An item's lines join without blank lines, so code in it would lose its
  // own, and so would an empty line or paragraphs set apart in it.
  if (hasCodeWithBlankLine(item, /\n[ \t]*\n/)) lose("blank lines in code");
  const items = flowItems(item.children);
  const children = elementsOf(item.children);
  const isList = (entry: FlowItem) => {
    const node = item.children[entry.first];
    return node?.kind === "element" && (node.tag === "ul" || node.tag === "ol");
  };
  if (
    items.some((entry) => entry.spaced || /\n[ \t]*\n/.test(entry.text)) ||
    items.some(
      (entry, index) =>
        index > 0 && flowSeparator(items[index - 1]!, entry) === "\n\n" && !isList(entry) && !isList(items[index - 1]!),
    ) ||
    children.some((child, index) => child.tag === "p" && children[index + 1]?.tag === "p")
  ) {
    lose("blank lines in list items");
  }
  return items
    .map((entry, index) => (index === 0 ? "" : flowSeparator(items[index - 1]!, entry)) + entry.text)
    .join("")
    .replace(/\n{2,}/g, "\n");
}

/** Whether preformatted code inside holds a run of blank lines like `pattern`. */
function hasCodeWithBlankLine(element: HtmlElement, pattern: RegExp): boolean {
  return elementsOf(element.children).some((child) =>
    child.tag === "pre" ? pattern.test(textContent(child).replace(/^\n|\n+$/g, "")) : hasCodeWithBlankLine(child, pattern),
  );
}

/** Notes formatting inside code, which keeps only its text. */
function noteCodeFormatting(element: HtmlElement) {
  for (const child of elementsOf(element.children)) {
    if (child.tag !== "br" && !((child.tag === "span" || CODE_TAGS.has(child.tag)) && !child.attrs.style)) {
      lose("formatting inside code");
      return;
    }
    noteCodeFormatting(child);
  }
}

function renderCodeBlock(element: HtmlElement): string {
  noteCodeFormatting(element);
  noteEmphasisResets(element, undefined);
  // Only a newline right after `<pre>` is markup; one inside `<code>` is code.
  const first = element.children[0];
  const all = textContent(element);
  const text = first?.kind === "text" && first.text.startsWith("\n") ? all.slice(1) : all;
  // A newline before the end tag shows nothing; more show empty lines.
  if (/\n[ \t]*\n$/.test(text)) lose("blank lines in code");
  const code = text.replace(/\n+$/, "");
  // The Markdown keeps one blank line at most, in code too.
  if (/\n[ \t]*\n[ \t]*\n/.test(code)) lose("blank lines in code");
  if (code.trim().length === 0) {
    // Code of spaces alone has no Markdown block; it would go.
    if (code.length > 0) lose("other formatting");
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
      noteCodeFormatting(element);
      // A code span is one line.
      if (hasBreak(element)) lose("line breaks in code");
      noteEmphasisResets(element, undefined);
      return renderCodeSpan(textContent(element));
    case "a": {
      // An Azure DevOps mention, as Ajour writes one.
      const mention = /^version:[\d.]+,([0-9a-f-]{36})$/i.exec(element.attrs["data-vss-mention"] ?? "");
      if (mention) {
        // A mention keeps only its name: any style on it or inside it is lost.
        if (element.attrs.style?.trim() || hasFormattingInside(element)) {
          lose("other formatting");
        }
        const written = textContent(element);
        // A mention keeps only its name: spaces around it would go.
        if (written !== written.trim()) lose("mention names Ajour cannot keep");
        const fullName = written.trim().replace(/^@/, "");
        // A mention's name in Ajour holds no brackets or backslashes.
        if (/[[\]\\]/.test(fullName)) lose("mention names Ajour cannot keep");
        const name = fullName.replace(/[[\]\\]/g, "");
        return `[@${name || "someone"}](mention:${mention[1]!.toLowerCase()})`;
      }
      // A link's own style, such as a struck-out old link, goes inside its text.
      const text = renderEmphasized(element, undefined);
      const href = element.attrs.href?.trim();
      if (href !== undefined) noteAddress(element.attrs.href!);
      // An empty address links to the page itself, which Markdown cannot write.
      if (href === "" && trimSpaces(text).length > 0) lose("other formatting");
      if (!href || trimSpaces(text).length === 0) return text;
      // The spaces at the link's edges stay text beside it.
      // Spaces at its edges stay inside the link, which Markdown link text holds.
      return `[${text}](${encodeUrl(href)})`;
    }
    case "img": {
      const src = element.attrs.src?.trim();
      if (src !== undefined) noteAddress(element.attrs.src!);
      if (!src) return "";
      const size = imageSize(element);
      const address = size ? `${src}${IMAGE_SIZE_MARK}${size}` : src;
      return `![${escapeText(collapseWhitespace(trimSpaces(element.attrs.alt ?? "")))}](${encodeUrl(address)})`;
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
    // Spaces alone cannot be a code span, so their code font would go.
    if (text.length > 0) lose("other formatting");
    return text;
  }
  const fence = "`".repeat(longestRun(text, "`") + 1);
  const padding = text.startsWith("`") || text.endsWith("`") ? " " : "";
  // A space at the code's edge would join the padding and go with it.
  if (padding && (text.startsWith(" ") || text.endsWith(" "))) lose("other formatting");
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
  // Spaces move outside the markers, or alone stay unmarked, which a
  // strikethrough line shows.
  if (marker === "~~" && match && (match[1] || match[3])) lose("strikethrough on spaces");
  if (!match || match[2] === "") {
    return text;
  }
  return `${match[1]}${marker}${match[2]}${marker}${match[3]}`;
}

function encodeUrl(url: string): string {
  return url.replace(/[()\s]/g, encodeURIComponent);
}

// Non-breaking spaces are text the writer gives back, so only ordinary
// white space collapses and trims.
function collapseWhitespace(text: string): string {
  return text.replace(/[ \t\n\r\f]+/g, " ");
}

function trimSpaces(text: string): string {
  return text.replace(/^[ \t\n\r\f]+|[ \t\n\r\f]+$/g, "");
}

function cleanLines(text: string): string {
  return text
    .split("\n")
    .map((line) => trimSpaces(line.replace(/[ \t]+/g, " ")))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

function escapeText(text: string): string {
  return text
    .replace(/[\\`*_[\]~|]/g, "\\$&")
    .replace(/&(?=#[0-9]{1,7};|#[xX][0-9a-fA-F]{1,6};|[a-zA-Z][a-zA-Z0-9]{1,31};)/g, "\\&")
    .replace(/<(?=[a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s<>]*>)/g, "\\<");
}

// Text that starts a line with "#", ">", "- ", "+ ", "1. " or a run of "-" or
// "=" would turn into a heading, quote or list. Leading spaces would turn into
// a code block.
function escapeLineStarts(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      line
        .replace(/^[ \t]+/, "")
        .replace(/^(#{1,6}(?=\s|$)|>|[-+](?=\s)|[-=](?=[-=\s]*$)|\d+(?=[.)]\s))/, (token: string) =>
          /^\d/.test(token) ? `${token}\\` : `\\${token}`,
        ),
    )
    .join("\n");
}

function singleLine(text: string): string {
  return trimSpaces(text.replace(/[ \t]*\n[ \t]*/g, " "));
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
