import { describe, expect, it } from "vitest";
import { htmlToMarkdown } from "../src/html-markdown.ts";

describe("htmlToMarkdown", () => {
  it("returns nothing for an empty description", () => {
    expect(htmlToMarkdown("")).toBeUndefined();
    expect(htmlToMarkdown("<div><br></div>")).toBeUndefined();
  });

  it("keeps the editor's lines as single line breaks", () => {
    expect(htmlToMarkdown("<div>First line</div><div>Second <br>line</div>")).toBe("First line\nSecond\nline");
  });

  it("sets paragraphs apart", () => {
    expect(htmlToMarkdown("<p>One</p><p>Two</p>Loose")).toBe("One\n\nTwo\n\nLoose");
  });

  it("renders inline formatting and links", () => {
    expect(
      htmlToMarkdown(
        '<div><b>bold </b><i>italic</i> <s>gone</s> <code>a()</code> <a href="https://example.com/a b">the spec</a> <u>under</u></div>',
      ),
    ).toBe("**bold** _italic_ ~~gone~~ `a()` [the spec](https://example.com/a%20b) under");
  });

  it("escapes characters markdown would read as syntax", () => {
    expect(htmlToMarkdown("<div># not a heading</div><div>snake_case *x* [y]</div><div>1. not a list</div><div>---</div>")).toBe(
      "\\# not a heading\nsnake\\_case \\*x\\* \\[y\\]\n1\\. not a list\n\\---",
    );
  });

  it("decodes entities and collapses whitespace", () => {
    expect(htmlToMarkdown("<div>a &amp; b&nbsp;&lt;c&gt;\n   d&#39;e</div>")).toBe("a & b <c> d'e");
  });

  it("drops scripts and styles", () => {
    expect(htmlToMarkdown("<style>p{}</style><div>Kept</div><script>alert(1)</script>")).toBe("Kept");
  });

  it("renders headings, quotes and rules", () => {
    expect(htmlToMarkdown("<h2>Context</h2><blockquote><div>Quoted</div><div>Twice</div></blockquote><hr><div>After</div>")).toBe(
      "## Context\n\n> Quoted\n> Twice\n\n---\n\nAfter",
    );
  });

  it("renders lists, including the editor's lists nested straight in a list and unclosed items", () => {
    expect(
      htmlToMarkdown('<ul><li>One<li>Two</li><ul><li>Nested</li></ul><li><div>Three</div></li></ul><ol start="4"><li>Four</li><li>Five<ol><li>Inner</li></ol></li></ol>'),
    ).toBe("- One\n- Two\n  - Nested\n- Three\n\n4. Four\n5. Five\n   1. Inner");
  });

  it("fences preformatted code", () => {
    expect(htmlToMarkdown("<pre>const a = 1;\n  if (a &lt; 2) {}\n</pre>")).toBe("```\nconst a = 1;\n  if (a < 2) {}\n```");
  });

  it("renders tables with the first row as the header", () => {
    expect(
      htmlToMarkdown("<table><tbody><tr><td><b>Day</b></td><td>Hours</td></tr><tr><td>Mon</td><td>7|5</td></tr></tbody></table>"),
    ).toBe("| **Day** | Hours |\n| --- | --- |\n| Mon | 7\\|5 |");
  });

  it("keeps images as markdown images", () => {
    expect(htmlToMarkdown('<div><img src="https://dev.azure.com/a/_apis/wit/attachments/1?fileName=x.png" alt="Diagram"></div>')).toBe(
      "![Diagram](https://dev.azure.com/a/_apis/wit/attachments/1?fileName=x.png)",
    );
  });

  it("ignores stray end tags and comments", () => {
    expect(htmlToMarkdown("<!-- note --></span><div>Text</b></div>")).toBe("Text");
  });
});
