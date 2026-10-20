import { afterEach, describe, expect, it, vi } from "vitest";
import { writeDescription } from "../src/plugin.ts";

const ANA = "0a1b2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d";
const SOURCE_ID = "https://dev.azure.com/contoso/Portal/_workitems/edit/4821";
const ITEM_URL = "https://dev.azure.com/contoso/_apis/wit/workitems/4821";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

interface Item {
  rev: number;
  description: string;
  markdown?: boolean;
}

function asWorkItem(item: Item) {
  return {
    id: 4821,
    rev: item.rev,
    fields: {
      "System.Description": item.description,
      "System.AssignedTo": { id: ANA, displayName: "Ana Silva" },
    },
    multilineFieldsFormat: item.markdown ? { "System.Description": "Markdown" } : {},
  };
}

/**
 * Azure DevOps holding one work item. A patch whose revision test fails, or
 * that `refuse` answers for, changes nothing.
 */
function stubAzure(item: Item, options: { refuse?: Response; changeBeforePatch?: string } = {}) {
  const patches: unknown[][] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      expect(url.startsWith(ITEM_URL)).toBe(true);
      if (init?.method !== "PATCH") return json(asWorkItem(item));
      const operations = JSON.parse(String(init.body)) as { op: string; path: string; value: unknown }[];
      patches.push(operations);
      if (options.changeBeforePatch !== undefined) {
        item.rev += 1;
        item.description = options.changeBeforePatch;
      }
      if (options.refuse) return options.refuse;
      const test = operations.find((operation) => operation.op === "test");
      if (test && test.value !== item.rev) {
        return json({ message: "TF26071: This work item has been changed by someone else since you opened it." }, 412);
      }
      item.rev += 1;
      item.description = String(operations.find((operation) => operation.path === "/fields/System.Description")!.value);
      return json(asWorkItem(item));
    }),
  );
  return patches;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("writeDescription", () => {
  it("writes an HTML item's description as HTML, testing its revision", async () => {
    const item = { rev: 7, description: "<div>Old <b>plan</b></div>" };
    const patches = stubAzure(item);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: `New **plan**, ask [@Ana Silva](mention:${ANA})`,
        expected: "Old **plan**",
      }),
    ).resolves.toEqual({
      outcome: "written",
      description: { text: `New **plan**, ask [@Ana Silva](mention:${ANA})` },
    });
    expect(patches).toEqual([
      [
        { op: "test", path: "/rev", value: 7 },
        {
          op: "add",
          path: "/fields/System.Description",
          value: `<div>New <strong>plan</strong>, ask <a href="#" data-vss-mention="version:2.0,${ANA}">@Ana Silva</a></div>`,
        },
      ],
    ]);
  });

  it("keeps the HTML of the lines and empty lines the edit leaves alone", async () => {
    const html = "<div>Goal</div><div><br></div><div><br></div><div>Steps</div><ul><li>One</li></ul>";
    const item = { rev: 5, description: html };
    const patches = stubAzure(item);

    await writeDescription(connection, {
      sourceId: SOURCE_ID,
      text: "Goal\n\nNew steps\n\n- One",
      expected: "Goal\n\nSteps\n\n- One",
    });
    expect(patches[0]![1]).toEqual({
      op: "add",
      path: "/fields/System.Description",
      value: html.replace("<div>Steps</div>", "<div>New steps</div>"),
    });
  });

  it("writes a Markdown item's description as Markdown, with its mentions", async () => {
    const item = { rev: 3, description: "Old *plan*", markdown: true };
    const patches = stubAzure(item);

    const result = await writeDescription(connection, {
      sourceId: SOURCE_ID,
      text: `New *plan* for [@Ana Silva](mention:${ANA})`,
      expected: "Old *plan*",
    });

    expect(patches[0]).toEqual([
      { op: "test", path: "/rev", value: 3 },
      { op: "add", path: "/fields/System.Description", value: `New *plan* for @<${ANA}>` },
      { op: "add", path: "/multilineFieldsFormat/System.Description", value: "Markdown" },
    ]);
    expect(result).toEqual({
      outcome: "written",
      description: { text: `New *plan* for [@Ana Silva](mention:${ANA})` },
    });
  });

  it("keeps a Markdown item's blank edges and line endings as they were", async () => {
    const item = { rev: 2, description: "\r\nA\r\nB  \r\n\r\n", markdown: true };
    const patches = stubAzure(item);

    await writeDescription(connection, { sourceId: SOURCE_ID, text: "Z\nB", expected: "A\nB" });
    expect(patches[0]![1]).toEqual({
      op: "add",
      path: "/fields/System.Description",
      value: "\r\nZ\r\nB  \r\n\r\n",
    });
  });

  it("writes nothing over a description changed since Ajour read it", async () => {
    const item = { rev: 9, description: "<div>Changed by a colleague</div>" };
    const patches = stubAzure(item);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).resolves.toEqual({ outcome: "conflict", description: { text: "Changed by a colleague" } });
    expect(patches).toEqual([]);
  });

  it("answers a conflict when the item changes between the read and the write", async () => {
    const item = { rev: 4, description: "<div>Old plan</div>" };
    stubAzure(item, { changeBeforePatch: "<div>Changed meanwhile</div>" });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).resolves.toEqual({ outcome: "conflict", description: { text: "Changed meanwhile" } });
    expect(item.description).toBe("<div>Changed meanwhile</div>");
  });

  it("passes on a refused write that is not a conflict", async () => {
    const item = { rev: 4, description: "<div>Old plan</div>" };
    stubAzure(item, {
      refuse: json({ message: "TF401027: You need the Edit work items permission." }, 403),
    });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("You need the Edit work items permission");
  });

  it("refuses a description too long for Azure DevOps once converted, writing nothing", async () => {
    const item = { rev: 1, description: "<div>Old plan</div>" };
    const patches = stubAzure(item);
    const long = "<".repeat(250_001);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: long, expected: "Old plan" }),
    ).rejects.toThrow("too long for Azure DevOps: 1,000,015 of 1,000,000 characters once converted");
    expect(patches).toEqual([]);
  });

  it("answers a conflict, cut as it is, when the description grew past what Ajour keeps", async () => {
    const item = { rev: 1, description: `<div>${"word ".repeat(13_000)}</div>` };
    const patches = stubAzure(item);

    const result = await writeDescription(connection, {
      sourceId: SOURCE_ID,
      text: "Mine",
      expected: "Old plan",
    });
    expect(result.outcome).toBe("conflict");
    expect(result.description.cut).toBe(true);
    expect(patches).toEqual([]);
  });

  it("writes nothing over formatting a colleague added to the same text", async () => {
    const item = { rev: 2, description: "<div><u>Old plan</u></div>" };
    const patches = stubAzure(item);

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("Writing it would lose its underline in Azure DevOps");
    expect(patches).toEqual([]);
  });

  it("writes over lost formatting the user allowed, keeping it in the blocks they left alone", async () => {
    const item = {
      rev: 2,
      description: '<div><u>Old plan</u></div><div><br></div><div><span style="color: red">Red note</span></div>',
    };
    const patches = stubAzure(item);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: "New plan\n\nRed note",
        expected: "Old plan\n\nRed note",
        allowedLoss: ["underline", "text colour"],
      }),
    ).resolves.toMatchObject({ outcome: "written" });
    expect(patches[0]![1]).toEqual({
      op: "add",
      path: "/fields/System.Description",
      value: '<div>New plan</div><div><br></div><div><span style="color: red">Red note</span></div>',
    });
  });

  it("writes nothing over a loss the user did not see", async () => {
    // The user saw the underline; a colleague then added colour to the same text.
    const item = { rev: 3, description: '<div><u><span style="color: red">Old plan</span></u></div>' };
    const patches = stubAzure(item);

    await expect(
      writeDescription(connection, {
        sourceId: SOURCE_ID,
        text: "New plan",
        expected: "Old plan",
        allowedLoss: ["underline"],
      }),
    ).rejects.toThrow("Writing it would lose its text colour in Azure DevOps");
    expect(patches).toEqual([]);
  });

  it("passes on a refused write even when the item changed meanwhile", async () => {
    const item = { rev: 4, description: "<div>Old plan</div>" };
    stubAzure(item, {
      changeBeforePatch: "<div>Changed meanwhile</div>",
      refuse: json({ message: "TF401027: You need the Edit work items permission." }, 403),
    });

    await expect(
      writeDescription(connection, { sourceId: SOURCE_ID, text: "Mine", expected: "Old plan" }),
    ).rejects.toThrow("You need the Edit work items permission");
  });

  it("keeps a mention written as an example in code as written", async () => {
    const item = { rev: 3, description: "Old", markdown: true };
    const patches = stubAzure(item);

    await writeDescription(connection, {
      sourceId: SOURCE_ID,
      text: `Write \`[@Ana](mention:${ANA})\` to mention [@Ana Silva](mention:${ANA})\n\n\`\`\`\n[@Ana](mention:${ANA})\n\`\`\``,
      expected: "Old",
    });
    expect(patches[0]![1]).toEqual({
      op: "add",
      path: "/fields/System.Description",
      value: `Write \`[@Ana](mention:${ANA})\` to mention @<${ANA}>\n\n\`\`\`\n[@Ana](mention:${ANA})\n\`\`\``,
    });
  });
});
