import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchAzureDevOpsImportCandidates,
  type AzureDevOpsConnectionInput,
} from "../src/azure-devops.ts";
import { htmlToMarkdownWithLosses } from "../src/html-markdown.ts";
import { readDescription } from "../src/plugin.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
} from "../src/priority-levels.ts";
import { withWorkItemTypeStates } from "./work-item-type-states.ts";
import { ALL_ACCESS, stubAzureFetch } from "./support/azure-ajour.ts";

const ANA = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

function buildConnection(): AzureDevOpsConnectionInput {
  return {
    label: "Main connection",
    tenantLabel: "Contoso",
    organizationUrl: "https://dev.azure.com/contoso",
    access: ALL_ACCESS,
    queryScope: "assigned_to_me",
    autoSync: false,
    autoSyncIntervalMinutes: 15,
    priorityLevels: parsePriorityLevelRanges(DEFAULT_PRIORITY_LEVEL_VALUES),
  };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The import candidate a sync sends for one work item with this description. */
async function candidateFor(description: string, format?: string) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/_apis/wit/wiql")) return json({ workItems: [{ id: 123 }] });
    if (url.includes("/_apis/wit/workitemsbatch")) {
      const body = JSON.parse(String(init?.body));
      // As Azure DevOps answers: the formats come with $expand, not with fields.
      if (body.$expand) {
        return json({
          value: [
            {
              id: 123,
              relations: [],
              multilineFieldsFormat: format ? { "System.Description": format } : {},
            },
          ],
        });
      }
      return json({
        value: [
          {
            id: 123,
            fields: {
              "System.Title": "Investigate incident",
              "System.State": "Active",
              "System.TeamProject": "Maintenance and Support",
              "System.WorkItemType": "Task",
              "System.Description": description,
            },
            multilineFieldsFormat: {},
          },
        ],
      });
    }
    return json({ value: [] });
  });
  stubAzureFetch(withWorkItemTypeStates(fetchMock));
  const result = await fetchAzureDevOpsImportCandidates(buildConnection());
  return result.items[0]!;
}

describe("descriptions a sync sends", () => {
  it("sends the full description beside the old 4,000-character note", async () => {
    const long = "word ".repeat(1500).trim();
    const candidate = await candidateFor(`<div>${long}</div>`);

    expect(candidate.description).toEqual({ text: long });
    expect(candidate.note).toHaveLength(4000);
    expect(candidate.note?.endsWith("...")).toBe(true);
  });

  it("names what the conversion from HTML lost", async () => {
    const candidate = await candidateFor(
      '<div><span style="color: rgb(255, 0, 0)">Red</span> and <u>underlined</u></div>',
    );

    expect(candidate.description).toEqual({
      text: "Red and underlined",
      lost: ["text colour", "underline"],
    });
  });

  it("keeps a Markdown description as written, with nothing lost", async () => {
    const candidate = await candidateFor("**Steps**\r\n\r\n- Open <u>raw</u>", "Markdown");

    expect(candidate.description).toEqual({ text: "**Steps**\n\n- Open <u>raw</u>" });
  });

  it("keeps a Markdown description's indented code block", async () => {
    const candidate = await candidateFor("\r\n    - Literal command\r\n", "Markdown");

    expect(candidate.description).toEqual({ text: "    - Literal command" });
  });

  it("keeps a Markdown description's indented list as written", async () => {
    const candidate = await candidateFor("  - First\r\n  - Second", "Markdown");

    expect(candidate.description).toEqual({ text: "  - First\n  - Second" });
  });

  it("cuts a description longer than Ajour stores, and says so", async () => {
    const candidate = await candidateFor("x".repeat(70_000), "Markdown");

    expect(candidate.description?.text).toHaveLength(64_000);
    expect(candidate.description?.cut).toBe(true);
  });

  it("writes a mention as Ajour's mention link", async () => {
    const candidate = await candidateFor(
      `<div>Ask <a href="#" data-vss-mention="version:2.0,${ANA.toUpperCase()}">@Ana Silva</a> first</div>`,
    );

    expect(candidate.description).toEqual({ text: `Ask [@Ana Silva](mention:${ANA}) first` });
  });

  it("writes a Markdown description's mentions as Ajour's mention links", async () => {
    const candidate = await candidateFor(`Ask @<${ANA.toUpperCase()}> first`, "Markdown");

    // The id keeps its case, so a write gives the source back as it was.
    expect(candidate.description).toEqual({ text: `Ask [@someone](mention:${ANA.toUpperCase()}) first` });
  });

  it("gives back a Markdown description's mentions as written, in code it does not see too", async () => {
    const source = `    @<${ANA.toUpperCase()}>\n\nElse`;
    const candidate = await candidateFor(source, "Markdown");

    expect(candidate.description?.lost).toBeUndefined();
  });

  it("sends an empty description when the item has none", async () => {
    const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/_apis/wit/wiql")) return json({ workItems: [{ id: 123 }] });
      if (url.includes("/_apis/wit/workitemsbatch")) {
        const body = JSON.parse(String(init?.body));
        if (body.$expand) return json({ value: [{ id: 123, relations: [] }] });
        return json({
          value: [
            {
              id: 123,
              fields: {
                "System.Title": "Investigate incident",
                "System.State": "Active",
                "System.TeamProject": "Maintenance and Support",
                "System.WorkItemType": "Task",
              },
            },
          ],
        });
      }
      return json({ value: [] });
    });
    stubAzureFetch(withWorkItemTypeStates(fetchMock));
    const result = await fetchAzureDevOpsImportCandidates(buildConnection());

    expect(result.items[0]?.description).toEqual({ text: "" });
  });
});

describe("descriptions Ajour cannot write back as they are", () => {
  it("names a Markdown description whose mentions would not write back as they are", async () => {
    const candidate = await candidateFor(`\`first\n[@Ana](mention:${ANA})\nlast\``, "Markdown");

    expect(candidate.description?.lost).toEqual(["formatting Ajour cannot write back"]);
  });

  it("names a description whose Markdown would not write back as itself", async () => {
    const candidate = await candidateFor("<div>a<b>!</b>b</div>");

    expect(candidate.description?.lost).toEqual(["formatting Ajour cannot write back"]);
  });

  it("leaves a description that writes back as itself editable", async () => {
    const candidate = await candidateFor("<div><b>Plan</b></div><ul><li>One</li></ul>");

    expect(candidate.description).toEqual({ text: "**Plan**\n\n- One" });
  });
});

describe("readDescription", () => {
  const connection = {
    id: "connection-1",
    pluginId: "azure_devops",
    label: "Main connection",
    tenantLabel: "Contoso",
    config: {
      organizationUrl: "https://dev.azure.com/contoso",
      queryScope: "assigned_to_me",
    },
  } as never;

  it("reads the work item's current description", async () => {
    const urls: string[] = [];
    stubAzureFetch(vi.fn(async (input: unknown) => {
        urls.push(String(input));
        return json({
          id: 4821,
          rev: 7,
          fields: { "System.Description": "<div><s>Old</s> plan</div>" },
          multilineFieldsFormat: {},
        });
      }),
    );

    await expect(
      readDescription(
        connection,
        { sourceId: "https://dev.azure.com/contoso/Portal/_workitems/edit/4821" },
      ),
    ).resolves.toEqual({ description: { text: "~~Old~~ plan" } });
    expect(urls[0]).toBe(
      "https://dev.azure.com/contoso/_apis/wit/workitems/4821?api-version=7.1",
    );
  });

  it("keeps a Markdown description as written, though a request naming fields omits its format", async () => {
    stubAzureFetch(vi.fn(async (input: unknown) =>
        json({
          id: 4821,
          rev: 7,
          fields: { "System.Description": "Hello **world**\n\n- one\n- two" },
          // As Azure DevOps answers: the format only without `fields=`.
          multilineFieldsFormat: String(input).includes("fields=")
            ? {}
            : { "System.Description": "markdown" },
        }),
      ),
    );

    await expect(
      readDescription(
        connection,
        { sourceId: "https://dev.azure.com/contoso/Portal/_workitems/edit/4821" },
      ),
    ).resolves.toEqual({ description: { text: "Hello **world**\n\n- one\n- two" } });
  });

  it("refuses a source id that is not one of this organization's work items", async () => {
    stubAzureFetch(vi.fn());

    await expect(
      readDescription(
        connection,
        { sourceId: "https://dev.azure.com/fabrikam/Portal/_workitems/edit/1" },
      ),
    ).rejects.toThrow("is not an Azure DevOps work item");
  });
});

describe("what a conversion loses", () => {
  const lost = (html: string) => htmlToMarkdownWithLosses(html).lost;

  it("names styling Markdown cannot hold", () => {
    expect(lost('<span style="background-color: yellow">Note</span>')).toEqual(["highlight"]);
    expect(lost('<span style="font-family: Consolas; font-size: 9pt">x</span>')).toEqual(["font"]);
    expect(lost('<font color="red">x</font>')).toEqual(["text colour"]);
    expect(lost('<span style="text-decoration: underline">x</span>')).toEqual(["underline"]);
    expect(lost('<div style="text-align: center">x</div>')).toEqual(["text alignment"]);
  });

  it("names structure Markdown cannot hold", () => {
    expect(lost('<div><input type="checkbox" checked> Done</div>')).toEqual(["checkboxes"]);
    expect(lost('<iframe src="https://example.test"></iframe>')).toEqual(["embedded content"]);
    expect(lost('<table><tr><td colspan="2">Wide</td></tr></table>')).toEqual(["merged table cells"]);
    expect(lost("<table><tr><td>A</td></tr><tr><td>One<br>Two</td></tr></table>")).toEqual([
      "line breaks in table cells",
    ]);
    // A write gives a table no header cells, as Azure DevOps' editor makes them.
    expect(lost("<table><thead><tr><th>A</th></tr></thead><tr><td>1</td></tr></table>")).toEqual([
      "table header cells",
    ]);
    expect(lost('<ol type="a"><li>x</li></ol><ul style="list-style-type: square"><li>y</li></ul>')).toEqual([
      "list numbering style",
    ]);
  });

  it("names any tag, attribute or style it does not know as other formatting", () => {
    expect(lost("<table><caption>Matrix</caption><tr><td>Production</td></tr></table>")).toEqual([
      "other formatting",
    ]);
    expect(lost('<table><tr><td style="border: 3px solid red">Production</td></tr></table>')).toEqual([
      "other formatting",
    ]);
    expect(lost('<table border="1"><tr><td>Production</td></tr></table>')).toEqual(["other formatting"]);
    expect(lost('<span style="font-weight: bold !important">Warning</span>')).toEqual(["other formatting"]);
    expect(lost('<b style="font-weight: bold; font-weight: normal">Plain</b>')).toContain("other formatting");
    expect(lost('<div class="x" lang="en" data-foo="1"><a href="https://e.test" target="_blank">ok</a></div>')).toEqual(
      [],
    );
    // An in-page link may point at an id or a named anchor.
    expect(lost('<a href="#target">Go</a><div id="target">Target</div>')).toEqual(["other formatting"]);
    expect(lost('<a name="target">Target</a>')).toEqual(["other formatting"]);
  });

  it("checks each named style's value, not only its name", () => {
    expect(lost('<p style="text-align: end">Right side</p>')).toEqual(["text alignment"]);
    expect(lost('<p style="text-align: left">Left</p>')).toEqual([]);
    expect(lost('<span style="color: transparent">Hidden</span>')).toEqual(["text colour"]);
    // A colour taken from around it looks as its surroundings do, which a write does not keep.
    expect(lost('<span style="color: inherit">Plain</span>')).toEqual(["other formatting"]);
    expect(lost('<pre style="font-size: 48px">Large code</pre>')).toEqual(["font"]);
    expect(lost('<pre style="font-family: Consolas">Code</pre>')).toEqual(["font"]);
    expect(lost('<span style="text-decoration: line-through; text-decoration-line: none">Current</span>')).toContain(
      "other formatting",
    );
  });

  it("names plain text in a heading, which is bold by default", () => {
    expect(lost('<h1><span style="font-weight: normal">Plain heading</span></h1>')).toEqual([
      "plain text inside emphasis",
    ]);
    expect(lost('<h1 style="font-weight: normal">Plain heading</h1>')).toEqual(["plain text inside emphasis"]);
  });

  it("names empty lines or paragraphs inside a list item, which the Markdown joins", () => {
    expect(lost("<ul><li>A<div><br></div><div>B</div></li><li>C</li></ul>")).toEqual(["blank lines in list items"]);
    expect(lost("<ul><li><p>A</p><p>B</p></li></ul>")).toEqual(["blank lines in list items"]);
    expect(lost("<ul><li>A<ul><li>Nested</li></ul></li><li><div>B</div><div>C</div></li></ul>")).toEqual([]);
  });

  it("names spacing the Markdown has no place for", () => {
    // More than one empty line in a row, from line breaks.
    expect(lost("<div>A<br><br><br>B</div><div>C</div>")).toEqual(["extra blank lines"]);
    // Non-breaking spaces at the very end, which Ajour trims.
    expect(lost("<div>A<br>B&nbsp;&nbsp;</div>")).toEqual(["spaces at the end"]);
    expect(lost("<div>A&nbsp;&nbsp;</div><div>B</div>")).toEqual([]);
    // An empty line inside a list item, from breaks or nested paragraphs.
    expect(lost("<ul><li>A<br><br>B</li><li>C</li></ul>")).toEqual(["blank lines in list items"]);
    expect(lost("<ul><li><div><p>A</p><p>B</p></div></li></ul>")).toEqual(["blank lines in list items"]);
    // Ordinary editor spacing stays editable.
    expect(lost("<div>A</div><div><br></div><div><br></div><div>B</div>")).toEqual([]);
  });

  it("names each place the Markdown would drop spacing or characters", () => {
    // Breaks at a line's edges show empty lines.
    expect(lost("<div>A<br>B<br><br></div><div>C</div>")).toEqual(["extra blank lines"]);
    expect(lost("<div><br>A</div>")).toEqual(["extra blank lines"]);
    expect(lost("<div>A<br></div><div>B</div>")).toEqual([]);
    // Several empty lines inside a block, where no HTML between blocks is kept.
    expect(lost("<blockquote><div>A</div><div><br></div><div><br></div><div>B</div></blockquote>")).toEqual([
      "extra blank lines",
    ]);
    expect(lost("<blockquote><div>A</div><div><br></div><div>B</div></blockquote>")).toEqual([]);
    // Blocks set apart inside a list item.
    expect(lost("<ul><li><div>A</div><p>B</p></li><li>C</li></ul>")).toEqual(["blank lines in list items"]);
    // Empty lines at the end of code.
    expect(lost("<pre>A\nB\n\n</pre><div>C</div>")).toEqual(["blank lines in code"]);
    expect(lost("<pre>A\nB\n</pre>")).toEqual([]);
    // Breaks in a heading or in inline code.
    expect(lost("<h1>A<br>B</h1>")).toEqual(["line breaks in headings"]);
    expect(lost("<div><code>B<br>C</code></div>")).toEqual(["line breaks in code"]);
    // Any space Ajour trims from the end, not only a non-breaking one.
    expect(lost("<div>A<br>B&#8195;</div>")).toEqual(["spaces at the end"]);
    // A character reference the reader does not know.
    expect(lost("<div>&copy; 2026 &eacute;t&eacute; &Eacute;</div>")).toEqual([]);
    expect(htmlToMarkdownWithLosses("<div>&Eacute;t&eacute; &frac12;</div>").markdown).toBe("Été ½");
    expect(lost("<div>&notarealname; 2026</div>")).toEqual(["characters Ajour cannot read"]);
  });

  it("names empty lines at the edges of a block, or several before a line, but not apart ones", () => {
    expect(lost("<blockquote><div>A</div><div><br></div></blockquote>")).toEqual(["extra blank lines"]);
    expect(lost("<blockquote><div><br></div><div>A</div></blockquote>")).toEqual(["extra blank lines"]);
    expect(lost("<blockquote><div>A</div><div><br></div><div><br></div>B</blockquote>")).toEqual([
      "extra blank lines",
    ]);
    expect(lost("<blockquote><div>A</div><div><br></div>B<div><br></div><div>C</div></blockquote>")).toEqual([]);
    // The top level keeps them, with the HTML around its blocks.
    expect(lost("<div><br></div><div>A</div><div><br></div>")).toEqual([]);
  });

  it("names a line break a heading gets from a block, and addresses the Markdown would change", () => {
    expect(lost("<h2>A<div>B</div></h2>")).toEqual(["line breaks in headings"]);
    expect(lost('<a href="https://e.test/a&#9;b">Link</a>')).toEqual(["link addresses Ajour cannot keep"]);
    expect(lost('<img src="https://e.test/x&#160;">')).toEqual(["link addresses Ajour cannot keep"]);
    expect(lost('<a href=" https://e.test/a b ">Link</a>')).toEqual([]);
  });

  it("keeps non-breaking spaces in an image's text", () => {
    expect(htmlToMarkdownWithLosses('<img src="x" alt="&#160;Label&#160;">')).toEqual({
      markdown: "![ Label ](x)",
      lost: [],
    });
  });

  it("names a Markdown description's mixed or old line endings", async () => {
    expect((await candidateFor("A\r\nB\nC", "Markdown")).description?.lost).toEqual([
      "line endings Ajour cannot keep",
    ]);
    expect((await candidateFor("A\rB", "Markdown")).description?.lost).toEqual(["line endings Ajour cannot keep"]);
    expect((await candidateFor("A\r\nB", "Markdown")).description?.lost).toBeUndefined();
  });

  it("counts empty paragraphs as empty lines, keeps a newline inside code, and names bracketed mention names", () => {
    expect(lost("<blockquote><p><br></p><div>A</div><div>B</div></blockquote>")).toEqual(["extra blank lines"]);
    expect(htmlToMarkdownWithLosses("<pre><code>\nA\nB</code></pre>")).toEqual({ markdown: "```\n\nA\nB\n```", lost: [] });
    expect(htmlToMarkdownWithLosses("<pre>\nA\nB</pre>").markdown).toBe("```\nA\nB\n```");
    expect(
      lost('<a href="#" data-vss-mention="version:2.0,0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d">@Ana [External]</a>'),
    ).toEqual(["mention names Ajour cannot keep"]);
  });

  it("names weights and decorations a write would show otherwise", () => {
    expect(lost('<a href="https://e.test" style="text-decoration: none">Reference</a>')).toEqual(["other formatting"]);
    expect(lost('<span style="font-weight: 300">Light</span>')).toEqual(["other formatting"]);
    expect(lost('<span style="font-weight: 600">Semi-bold</span>')).toEqual(["other formatting"]);
    expect(lost('<span style="font-style: oblique">Oblique</span>')).toEqual(["other formatting"]);
    expect(lost('<span style="font-weight: 700">Bold</span> <span style="font-style: italic">i</span>')).toEqual([]);
  });

  it("reads a quoted > in an attribute as part of the tag, and names resets, empty links and form fields", () => {
    expect(htmlToMarkdownWithLosses('<div>Before <a href="https://e.test" title=">">Reference</a></div>')).toEqual({
      markdown: "Before [Reference](https://e.test)",
      lost: [],
    });
    expect(lost('<b style="font-weight: inherit">plain</b>')).toContain("other formatting");
    expect(lost('<h1>Before <span style="font-size: initial">small</span></h1>')).toContain("other formatting");
    expect(lost('<code style="font-family: serif">sample</code>')).toEqual(["font"]);
    expect(lost('<a href="">Reference</a>')).toEqual(["other formatting"]);
    expect(lost('<input type="text"> <select></select> <input type="hidden">')).toContain("form fields");
  });

  it("names formatting anywhere inside a mention", () => {
    expect(
      lost(
        '<a href="#" data-vss-mention="version:2.0,0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"><span><b>@Ana</b></span></a>',
      ),
    ).toEqual(["other formatting"]);
  });

  it("names style on a mention, which keeps only its name", () => {
    expect(
      lost(
        '<a href="#" data-vss-mention="version:2.0,0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d" style="font-weight: bold">@Ana</a>',
      ),
    ).toEqual(["other formatting"]);
  });

  it("names merged cells at any span but one, and formatting in a mention", () => {
    expect(lost('<table><tr><td rowspan="0">A</td><td>B</td></tr><tr><td>C</td></tr></table>')).toEqual([
      "merged table cells",
    ]);
    expect(
      lost('<a href="#" data-vss-mention="version:2.0,0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d"><b>@Ana</b></a>'),
    ).toEqual(["other formatting"]);
  });

  it("keeps the spaces at a link's edges inside the link", () => {
    expect(htmlToMarkdownWithLosses('<div><a href="https://e.test">Link </a>after</div>')).toEqual({
      markdown: "[Link ](https://e.test)after",
      lost: [],
    });
    expect(htmlToMarkdownWithLosses('<div><a href="https://e.test">A&nbsp;&nbsp;</a>X</div>').markdown).toBe(
      "[A  ](https://e.test)X",
    );
  });

  it("names spaces at a mention's edges, and spaces under a strikethrough's edges", () => {
    expect(
      lost('<a href="#" data-vss-mention="version:2.0,0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d">@Ana&nbsp;&nbsp;</a>next'),
    ).toEqual(["mention names Ajour cannot keep"]);
    expect(lost("<div><s>A&nbsp;&nbsp;</s>X</div>")).toEqual(["strikethrough on spaces"]);
    expect(lost("<div><s>A</s> X <b>bold </b>Y</div>")).toEqual([]);
  });

  it("names struck-through or code spaces alone, and reads a wrapper's spacing as the top level's", () => {
    expect(lost("<div>A<s>&nbsp;&nbsp;</s>B</div>")).toEqual(["strikethrough on spaces"]);
    expect(lost("<div>A<code>&nbsp;&nbsp;</code>B</div>")).toEqual(["other formatting"]);
    // A write keeps a wrapper of blocks around what it changes, with its empty lines.
    expect(lost("<div><div>A</div><div><br></div><div><br></div><div>Else</div></div>")).toEqual([]);
  });

  it("keeps text that looks like a reference or an autolink, italics inside a word, and names joined code spans", () => {
    expect(htmlToMarkdownWithLosses("<div>Use &amp;amp; and &lt;https://e.test&gt;</div>")).toEqual({
      markdown: "Use \\&amp; and \\<https://e.test>",
      lost: [],
    });
    expect(htmlToMarkdownWithLosses("<div>un<i>break</i>able</div>")).toEqual({ markdown: "un*break*able", lost: [] });
    expect(lost("<div><code>A</code><code>B</code></div>")).toEqual(["other formatting"]);
  });

  it("names code with a backtick at one edge and a space at the other", () => {
    expect(lost("<div><code>`A </code>B</div>")).toEqual(["other formatting"]);
    expect(lost("<div><code> B`</code></div>")).toEqual(["other formatting"]);
    expect(htmlToMarkdownWithLosses("<div><code>`A`</code></div>")).toEqual({ markdown: "`` `A` ``", lost: [] });
  });

  it("joins italic beside bold italic, and escapes a ! that joining brings before a link", () => {
    expect(htmlToMarkdownWithLosses("<div><b><i>A</i></b><i>B</i></div>")).toEqual({ markdown: "***A**B*", lost: [] });
    expect(htmlToMarkdownWithLosses("<div><i>A</i><b><i>B</i></b></div>")).toEqual({ markdown: "*A**B***", lost: [] });
    expect(
      htmlToMarkdownWithLosses('<div><i>!</i><i><a href="https://e.test">Reference</a></i> Else</div>'),
    ).toEqual({ markdown: "*\\![Reference](https://e.test)* Else", lost: [] });
  });

  it("escapes a ! right before a link, and names a code block of spaces alone", () => {
    expect(htmlToMarkdownWithLosses('<div>!<a href="https://e.test">Reference</a> Wow!</div>')).toEqual({
      markdown: "\\![Reference](https://e.test) Wow!",
      lost: [],
    });
    expect(lost("<blockquote><pre><code>   </code></pre><div>Else</div></blockquote>")).toEqual(["other formatting"]);
  });

  it("names emphasis turned off on code inside emphasis", () => {
    expect(lost('<b><code style="font-weight: normal">A</code></b>')).toContain("plain text inside emphasis");
    expect(lost('<i><code style="font-style: normal">A</code></i>')).toContain("plain text inside emphasis");
  });

  it("reads character references as HTML does, and names what it would read otherwise", () => {
    expect(htmlToMarkdownWithLosses("<div>&#128; &#x93;quoted&#x94;</div>")).toEqual({
      markdown: "€ “quoted”",
      lost: [],
    });
    expect(lost("<div>&copy 2026</div>")).toEqual(["characters Ajour cannot read"]);
    expect(lost("<div>&#0;</div>")).toEqual(["characters Ajour cannot read"]);
    expect(lost("<div>&#169; &#xA9; &copy;</div>")).toEqual([]);
  });

  it("judges a list marker by how deep its list is", () => {
    expect(lost('<ul><li>A<ul style="list-style-type: disc"><li>B</li></ul></li></ul>')).toEqual([
      "list numbering style",
    ]);
    expect(lost('<ul><li>A<ul style="list-style-type: circle"><li>B</li></ul></li></ul>')).toEqual([]);
    expect(lost('<div style="list-style-type: square"><ul><li>A</li></ul></div>')).toEqual(["list numbering style"]);
    expect(lost('<ul><li style="list-style-type: disc">A</li></ul><ol><li style="list-style-type: decimal">B</li></ol>')).toEqual(
      [],
    );
  });

  it("turns emphasis off with initial, and keeps a list starting at zero", () => {
    expect(lost('<b>bold <span style="font-weight: initial">plain</span></b>')).toContain(
      "plain text inside emphasis",
    );
    expect(htmlToMarkdownWithLosses('<ol start="0"><li>Zero</li><li>One</li></ol>')).toEqual({
      markdown: "0. Zero\n1. One",
      lost: [],
    });
  });

  it("names a marker another list type would show, and emphasis inside code", () => {
    expect(lost('<ul style="list-style-type: decimal"><li>A</li></ul>')).toEqual(["list numbering style"]);
    expect(lost('<ul style="list-style-type: disc; list-style: none"><li>A</li></ul>')).toEqual([
      "list numbering style",
    ]);
    expect(lost("<pre><code><b>Warning</b> normal</code></pre>")).toEqual(["formatting inside code"]);
    expect(lost("<pre><code>plain<br>lines</code></pre>")).toEqual([]);
  });

  it("names list numbering Markdown lists cannot carry", () => {
    expect(lost("<ol reversed><li>A</li><li>B</li></ol>")).toEqual(["list numbering style"]);
    expect(lost('<ol><li>A</li><li value="8">B</li></ol>')).toEqual(["list numbering style"]);
    expect(lost('<ul><li style="list-style-type: none">A</li></ul>')).toEqual(["list numbering style"]);
    expect(lost('<ul style="list-style-type: disc"><li>A</li></ul><ol type="1"><li>B</li></ol>')).toEqual([]);
  });

  it("names blank lines in code that the Markdown cannot keep", () => {
    expect(lost("<pre>line 1\n\n\nline 2</pre>")).toContain("blank lines in code");
    expect(lost("<pre>line 1\n\nline 2</pre>")).toEqual([]);
    expect(lost("<ul><li>Run<pre>a\n\nb</pre></li></ul>")).toContain("blank lines in code");
  });

  it("names plain text set inside emphasis, which the Markdown would emphasize", () => {
    expect(lost('<b>first <span style="font-weight: normal">plain</span> last</b>')).toEqual([
      "plain text inside emphasis",
    ]);
    expect(lost('<i>a <span style="font-style: normal">b</span></i>')).toEqual(["plain text inside emphasis"]);
    expect(lost('<b style="font-weight: normal">not bold</b>')).toEqual(["plain text inside emphasis"]);
    expect(lost('<span style="font-weight: normal">plain</span> <b style="font-weight: 700">bold</b>')).toEqual([]);
  });

  it("names image styling hidden by a repeated declaration, and an address holding the size mark", () => {
    expect(lost('<img src="https://e.test/a.png" style="width:50% !important;width:80%">')).toEqual([
      "image styling",
    ]);
    expect(lost('<img src="https://e.test/a.svg#ajour-image?width=120">')).toEqual(["image attributes"]);
  });

  it("carries an image's size in its address, and names other image styling", () => {
    expect(
      htmlToMarkdownWithLosses('<img src="https://e.test/x.png" alt="X" width="120" height="80" style="max-width: 50%">'),
    ).toEqual({
      markdown: "![X](https://e.test/x.png#ajour-image?width=120&height=80&style=max-width%3A50%25)",
      lost: [],
    });
    expect(lost('<img src="https://e.test/x.png" style="border: 1px solid red">')).toEqual(["image styling"]);
    expect(lost('<img src="https://e.test/x.png" class="framed">')).toEqual(["image attributes"]);
  });

  it("loses nothing over what Markdown holds, images included", () => {
    expect(
      lost(
        '<h2>Title</h2><p><b>Bold</b>, <i>italic</i>, <s>gone</s>, <code>x</code> and <a href="https://example.test">a link</a></p>' +
          '<ul><li>One</li></ul><blockquote>Quote</blockquote><pre>code</pre><hr>' +
          '<table><tr><td>A</td></tr><tr><td>1</td></tr></table>' +
          '<img src="https://dev.azure.com/contoso/_apis/wit/attachments/1?fileName=x.png" alt="Diagram" width="300">' +
          '<div style="text-align: left">Plain</div>',
      ),
    ).toEqual([]);
  });

  it("names superscript and subscript, which Markdown drops", () => {
    expect(lost("<div>10 m<sup>2</sup> of H<sub>2</sub>O</div>")).toEqual(["superscript", "subscript"]);
  });

  it("names a code block's own font, and keeps styled emphasis as Markdown", () => {
    expect(htmlToMarkdownWithLosses('<pre style="font-family: serif">npm test</pre>')).toEqual({
      markdown: "```\nnpm test\n```",
      lost: ["font"],
    });
    expect(
      htmlToMarkdownWithLosses(
        '<div><span style="font-weight: bold">Warning</span>, <span style="font-style:italic">soon</span>, ' +
          '<span style="text-decoration: line-through">never</span></div>',
      ),
    ).toEqual({ markdown: "**Warning**, *soon*, ~~never~~", lost: [] });
  });

  it("applies emphasis once, however the HTML nests or repeats it", () => {
    const convert = (html: string) => htmlToMarkdownWithLosses(html);
    expect(convert('<span style="font-style:italic"><i>Warning</i></span>')).toEqual({
      markdown: "*Warning*",
      lost: [],
    });
    expect(convert('<b style="font-style:italic">Warning</b>')).toEqual({
      markdown: "***Warning***",
      lost: [],
    });
    expect(
      convert('<div><span style="font-weight:bold">Warning</span><span style="font-weight:bold">now</span></div>'),
    ).toEqual({ markdown: "**Warningnow**", lost: [] });
    expect(convert("<div><b>One</b><b>Two</b> and <i>three</i><i>four</i></div>")).toEqual({
      markdown: "**OneTwo** and *threefour*",
      lost: [],
    });
    expect(convert("<div><b>Bold</b> <b>apart</b></div>")).toEqual({
      markdown: "**Bold** **apart**",
      lost: [],
    });
  });

  it("names emphasis set on a whole block, which Markdown cannot carry across lines", () => {
    expect(lost('<div style="font-weight: bold">Warning</div>')).toEqual(["bold text"]);
    expect(lost('<p style="font-style: italic">Aside</p>')).toEqual(["italic text"]);
  });

  it("keeps an escaped character beside emphasis", () => {
    expect(htmlToMarkdownWithLosses("<div>a_<i>b</i></div>").markdown).toBe("a\\_*b*");
  });

  it("joins emphasis after an escaped backslash", () => {
    expect(htmlToMarkdownWithLosses("<div><b>C:\\</b><b>Windows</b></div>").markdown).toBe(
      "**C:\\\\Windows**",
    );
  });

  it("keeps a link's styled emphasis inside its text", () => {
    expect(
      htmlToMarkdownWithLosses(
        '<a href="https://example.test/runbook" style="text-decoration:line-through">Old runbook</a>',
      ),
    ).toEqual({ markdown: "[~~Old runbook~~](https://example.test/runbook)", lost: [] });
  });

  it("names emphasis set on code, which code cannot carry", () => {
    expect(lost('<code style="font-weight:bold">npm test</code>')).toEqual(["emphasis on code"]);
  });

  it("keeps a table cell's own emphasis, and names a list in a cell as lost", () => {
    expect(
      htmlToMarkdownWithLosses(
        '<table><tr><td>Step</td></tr><tr><td style="text-decoration:line-through">Deprecated</td></tr></table>',
      ),
    ).toEqual({ markdown: "| Step |\n| --- |\n| ~~Deprecated~~ |", lost: [] });
    expect(
      lost("<table><tr><td>Step</td></tr><tr><td><ul><li>Restart service</li></ul></td></tr></table>"),
    ).toEqual(["lists or blocks in table cells"]);
  });

  it("names each loss once", () => {
    expect(lost('<u>a</u><u>b</u><span style="color:red">c</span>')).toEqual(["underline", "text colour"]);
  });
});
