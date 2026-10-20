import { describe, expect, it } from "vitest";
import { patchDescriptionHtml } from "../src/description-patch.ts";
import { htmlToMarkdown } from "../src/html-markdown.ts";
import { markdownToHtml } from "../src/markdown-html.ts";

/** The source's Markdown, edited by `change`, written back into its HTML. */
function edit(html: string, change: (markdown: string) => string) {
  const markdown = htmlToMarkdown(html) ?? "";
  const edited = change(markdown);
  const written = patchDescriptionHtml(html, edited);
  return { markdown, edited, written };
}

const EDITOR_HTML =
  "<div>Context</div><div><br></div><div><br></div><div>First line</div><div>Second line</div>" +
  "<div><br></div><ul><li>One</li><li>Two</li></ul><div>After the list</div><div><br></div>" +
  "<table><tbody><tr><td>A</td><td>B</td></tr></tbody></table>";

describe("writing an edit back into the description's HTML", () => {
  it("reads empty editor lines as blank lines between lines", () => {
    expect(htmlToMarkdown("<div>A</div><div><br></div><div>B</div><div>C</div>")).toBe("A\n\nB\nC");
  });

  it("keeps every block the user did not change as it was, empty lines included", () => {
    const { written } = edit(EDITOR_HTML, (markdown) => markdown.replace("Second line", "Second line, edited"));

    expect(written).toBe(EDITOR_HTML.replace("<div>Second line</div>", "<div>Second line, edited</div>"));
  });

  it("keeps the empty lines around a changed line", () => {
    const { written } = edit(EDITOR_HTML, (markdown) => markdown.replace("Context", "New context"));

    expect(written).toBe(EDITOR_HTML.replace("<div>Context</div>", "<div>New context</div>"));
  });

  it("writes an added paragraph as editor lines, after an empty line when it follows a line", () => {
    expect(edit("<div>A</div>", (markdown) => `${markdown}\n\nAdded`).written).toBe(
      "<div>A</div><div><br></div><div>Added</div>",
    );
    // A table, like any block, has its own spacing.
    expect(edit(EDITOR_HTML, (markdown) => `${markdown}\n\nAdded`).written).toBe(`${EDITOR_HTML}<div>Added</div>`);
  });

  it("rewrites only a list the user changed", () => {
    const { written, edited } = edit(EDITOR_HTML, (markdown) => markdown.replace("- Two", "- Two\n- Three"));

    expect(written).toBe(
      EDITOR_HTML.replace("<ul><li>One</li><li>Two</li></ul>", "<ul><li>One</li><li>Two</li><li>Three</li></ul>"),
    );
    expect(htmlToMarkdown(written!)).toBe(edited);
  });

  it("keeps a block's own markup when the text around it changes", () => {
    const html = '<div>Intro</div><div><br></div><pre style="font-family: Consolas">code()</pre><div>Outro</div>';
    const { written } = edit(html, (markdown) => markdown.replace("Outro", "Outro, longer"));

    expect(written).toBe(html.replace("<div>Outro</div>", "<div>Outro, longer</div>"));
  });

  it("keeps a wrapper of blocks, and does not nest a single line deeper on each edit", () => {
    const wrapped = "<div><div>A</div><div><br></div><div>B</div></div>";
    expect(edit(wrapped, (markdown) => markdown.replace("B", "B2")).written).toBe(
      "<div><div>A</div><div><br></div><div>B2</div></div>",
    );

    let html = "<div>Only line</div>";
    for (const text of ["Second", "Third"]) {
      html = patchDescriptionHtml(html, text)!;
    }
    expect(html).toBe("<div>Third</div>");
  });

  it("sets a rewritten paragraph apart as the source did, and keeps the lines around it", () => {
    const html = "<div>A</div><p>B</p><div>C&nbsp;&nbsp;D</div>";
    const { written, edited } = edit(html, (markdown) => markdown.replace("B", "B2"));

    expect(written).toBe("<div>A</div><div><br></div><div>B2</div><div><br></div><div>C&nbsp;&nbsp;D</div>");
    expect(htmlToMarkdown(written!)).toBe(edited);
  });

  it("keeps non-breaking spaces on the untouched lines of a changed block", () => {
    const { written } = edit("<div>A&nbsp;&nbsp;B<br>C</div><div>D</div>", (markdown) => markdown.replace("C", "C2"));

    expect(written).toBe("<div>A  B<br>C2</div><div>D</div>");
  });

  it("keeps the empty lines between two changed lines", () => {
    const { written } = edit("<div>A</div><div><br></div><div><br></div><div>B</div>", (markdown) =>
      markdown.replace("A", "A2").replace("B", "B2"),
    );

    expect(written).toBe("<div>A2</div><div><br></div><div><br></div><div>B2</div>");
  });

  it("keeps the non-breaking spaces Ajour trims from the end of a description", () => {
    const html = "<div>A</div><div>B&nbsp;&nbsp;</div>";
    const { markdown, written } = edit(html, (text) => text.replace("A", "A2"));

    // Ajour trims a description's end, so the read does too.
    expect(markdown).toBe("A\nB");
    expect(written).toBe("<div>A2</div><div>B&nbsp;&nbsp;</div>");
  });

  it("keeps a block whose text holds several breaks when a later line changes", () => {
    const html = "<div>A<br><br><br>B</div><div>C</div>";
    const { written } = edit(html, (text) => text.replace("C", "C2"));

    expect(written).toBe("<div>A<br><br><br>B</div><div>C2</div>");
  });

  it("takes a kept line into the change when the edit cannot sit beside it", () => {
    // In Markdown the line goes on the new item, so the item takes it.
    const { written, edited } = edit("<div>Intro</div><div><br></div><div>A</div>", (markdown) =>
      markdown.replace("\n\nA", "\n\n- x\nA"),
    );

    // The empty line before it stays.
    expect(written).toBe("<div>Intro</div><div><br></div><ul><li>x<br>A</li></ul>");
    expect(htmlToMarkdown(written!)).toBe(htmlToMarkdown(markdownToHtml(edited)));
  });

  it("gives up, for the whole Markdown to be written, when it cannot read back as the edit", () => {
    expect(patchDescriptionHtml("", "Anything")).toBeUndefined();
  });
});
