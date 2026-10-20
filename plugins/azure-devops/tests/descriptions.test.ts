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

const ANA = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";

function buildConnection(): AzureDevOpsConnectionInput {
  return {
    label: "Main connection",
    tenantLabel: "Contoso",
    organizationUrl: "https://dev.azure.com/contoso",
    personalAccessToken: "secret",
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
              "System.Description": description,
            },
            ...(format ? { multilineFieldsFormat: { "System.Description": format } } : {}),
          },
        ],
      });
    }
    return json({ value: [] });
  });
  vi.stubGlobal("fetch", withWorkItemTypeStates(fetchMock));
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

    expect(candidate.description).toEqual({ text: `Ask [@someone](mention:${ANA}) first` });
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
    vi.stubGlobal("fetch", withWorkItemTypeStates(fetchMock));
    const result = await fetchAzureDevOpsImportCandidates(buildConnection());

    expect(result.items[0]?.description).toEqual({ text: "" });
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
      personalAccessToken: "secret",
      queryScope: "assigned_to_me",
    },
  } as never;

  it("reads the work item's current description", async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
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
      "https://dev.azure.com/contoso/_apis/wit/workitems/4821?fields=System.Description,System.AssignedTo&api-version=7.1",
    );
  });

  it("refuses a source id that is not one of this organization's work items", async () => {
    vi.stubGlobal("fetch", vi.fn());

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
    expect(lost("<table><tr><th>A</th></tr><tr><td>One<br>Two</td></tr></table>")).toEqual([
      "line breaks in table cells",
    ]);
  });

  it("loses nothing over what Markdown holds, images included", () => {
    expect(
      lost(
        '<h2>Title</h2><p><b>Bold</b>, <i>italic</i>, <s>gone</s>, <code>x</code> and <a href="https://example.test">a link</a></p>' +
          '<ul><li>One</li></ul><blockquote>Quote</blockquote><pre>code</pre><hr>' +
          '<table><tr><th>A</th></tr><tr><td>1</td></tr></table>' +
          '<img src="https://dev.azure.com/contoso/_apis/wit/attachments/1?fileName=x.png" alt="Diagram" width="300">' +
          '<div style="text-align: left; color: inherit">Plain</div>',
      ),
    ).toEqual([]);
  });

  it("names superscript and subscript, which Markdown drops", () => {
    expect(lost("<div>10 m<sup>2</sup> of H<sub>2</sub>O</div>")).toEqual(["superscript", "subscript"]);
  });

  it("keeps a code block's own font, and styled emphasis as Markdown", () => {
    expect(htmlToMarkdownWithLosses('<pre style="font-family: monospace">npm test</pre>')).toEqual({
      markdown: "```\nnpm test\n```",
      lost: [],
    });
    expect(
      htmlToMarkdownWithLosses(
        '<div><span style="font-weight: bold">Warning</span>, <span style="font-style:italic">soon</span>, ' +
          '<span style="text-decoration: line-through">never</span></div>',
      ),
    ).toEqual({ markdown: "**Warning**, _soon_, ~~never~~", lost: [] });
  });

  it("applies emphasis once, however the HTML nests or repeats it", () => {
    const convert = (html: string) => htmlToMarkdownWithLosses(html);
    expect(convert('<span style="font-style:italic"><i>Warning</i></span>')).toEqual({
      markdown: "_Warning_",
      lost: [],
    });
    expect(convert('<b style="font-style:italic">Warning</b>')).toEqual({
      markdown: "**_Warning_**",
      lost: [],
    });
    expect(
      convert('<div><span style="font-weight:bold">Warning</span><span style="font-weight:bold">now</span></div>'),
    ).toEqual({ markdown: "**Warningnow**", lost: [] });
    expect(convert("<div><b>One</b><b>Two</b> and <i>three</i><i>four</i></div>")).toEqual({
      markdown: "**OneTwo** and _threefour_",
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
    expect(htmlToMarkdownWithLosses("<div>a_<i>b</i></div>").markdown).toBe("a\\__b_");
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
        '<table><tr><th>Step</th></tr><tr><td style="text-decoration:line-through">Deprecated</td></tr></table>',
      ),
    ).toEqual({ markdown: "| Step |\n| --- |\n| ~~Deprecated~~ |", lost: [] });
    expect(
      lost("<table><tr><th>Step</th></tr><tr><td><ul><li>Restart service</li></ul></td></tr></table>"),
    ).toEqual(["lists or blocks in table cells"]);
  });

  it("names each loss once", () => {
    expect(lost('<u>a</u><u>b</u><span style="color:red">c</span>')).toEqual(["underline", "text colour"]);
  });
});
