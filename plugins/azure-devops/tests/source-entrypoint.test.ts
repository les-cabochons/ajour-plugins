import { readdir, readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifestJson from "../plugin.json";
import { deriveAddress } from "./support/azure-ajour.ts";
import { withoutCommentsAndStrings } from "./support/code-only.ts";
import { createAzureFixture, PROJECT, VIEWER, type AzureFixture, type FixtureAnswer } from "./support/azure-fixture.ts";

/*
 * The source entrypoint, loaded the way Ajour's worker loads a plugin: as an ES
 * module whose named exports are the operations, running with
 * a frozen `ajour` global and nothing else. The global is a small stand-in for
 * the broker: it builds the address from the Organization URL the connection
 * saved (or the identities host the manifest derives from it), never above its
 * path, refuses an endpoint, header or access choice the manifest and the
 * connection don't allow, attaches the token as Basic credentials with an
 * empty user, and follows a redirect only within the origin and to a declared
 * endpoint, handing any other back as it is. Behind it, a fixture Azure DevOps
 * routes by the real URL.
 */

const PAT = "pat-5c0ffee";
const BASIC = `Basic ${btoa(`:${PAT}`)}`;
const CONNECTION_ID = "connection-1";
const ALL = ["editWorkItems", "pullRequests", "peopleSearch"];

interface Endpoint {
  method: string;
  path: string;
  access?: string;
}
const manifest = manifestJson as unknown as {
  network: {
    endpoints: Endpoint[];
    derivedHosts: { id: string; forms: Parameters<typeof deriveAddress>[0]; endpoints: Endpoint[] }[];
    requestHeaders: string[];
  };
  connectionAccess: { id: string; always?: boolean }[];
};

interface Received {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface Scenario {
  name: string;
  organizationUrl: string;
  onPremises: boolean;
  identitiesUrl: string;
}

let scenario: Scenario;
let fixture: AzureFixture;
let received: Received[] = [];
let turnedOn: string[] = ALL;
/** Replaces the fixture's answer, as a service turning a token away does. */
let override: ((request: Received) => FixtureAnswer | undefined) | undefined;
let moduleExports: Record<string, (...args: any[]) => Promise<any>>;
/** Every source file's code, without its comments and strings. */
let sourceCode: Record<string, string> = {};

function endpointMatches(pattern: string, requestPath: string) {
  const patternParts = pattern.split("/");
  const parts = requestPath.split("/");
  return patternParts.length === parts.length && patternParts.every((part, index) => part === "*" || part === parts[index]);
}

function accessOn() {
  return new Set([...manifest.connectionAccess.filter((choice) => choice.always).map((choice) => choice.id), ...turnedOn]);
}

/** The fixture Azure DevOps, by the URL the broker built. It refuses a request without the Basic credential. */
function azureDevOps(request: Received): FixtureAnswer {
  const replaced = override?.(request);
  if (replaced) return replaced;
  if (request.headers.authorization !== BASIC) return { status: 401, body: "" };
  const url = new URL(request.url);
  for (const [base, identities] of [
    [scenario.identitiesUrl, true],
    [scenario.organizationUrl, false],
  ] as const) {
    const root = new URL(base);
    const basePath = root.pathname.replace(/\/+$/, "");
    if (url.origin === root.origin && url.pathname.startsWith(`${basePath}/`) && (identities || !url.pathname.includes("/_apis/identities"))) {
      // The identities host of an Azure DevOps Server is the collection itself.
      if (identities && !url.pathname.endsWith("/_apis/identities")) continue;
      return fixture.answer({
        method: request.method,
        path: url.pathname.slice(basePath.length),
        query: url.searchParams,
        ...(request.body !== undefined ? { body: request.body } : {}),
        identities,
      });
    }
  }
  return { status: 404, body: "" };
}

/** What Ajour's broker does for `ajour.http`, in miniature. */
function installAjour() {
  const allowedHeaders = new Set(manifest.network.requestHeaders.map((header) => header.toLowerCase()));
  const http = async (request: {
    connectionId: string;
    host?: string;
    method: string;
    path: string;
    query?: Record<string, string | number | boolean>;
    headers?: Record<string, string>;
    body?: string;
  }) => {
    const refuse = (message: string) => Object.assign(new Error(message), { name: "AjourRequestError", code: "refused" });
    if (request.connectionId !== CONNECTION_ID) throw refuse("No such connection.");
    const base = new URL(scenario.organizationUrl);
    if (base.protocol !== "https:" && !scenario.onPremises) throw refuse("Only an on-premises connection may use http://.");
    const derived = request.host === undefined ? undefined : manifest.network.derivedHosts.find((host) => host.id === request.host);
    if (request.host !== undefined && !derived) throw refuse(`The manifest derives no host ${request.host}.`);
    const endpoints = derived ? derived.endpoints : manifest.network.endpoints;
    const address = derived ? deriveAddress(derived.forms, scenario.organizationUrl) : scenario.organizationUrl.replace(/\/+$/, "");
    const allowed = (method: string, requestPath: string) => {
      const matching = endpoints.filter((endpoint) => endpoint.method === method && endpointMatches(endpoint.path, requestPath));
      return { matching, open: matching.find((endpoint) => endpoint.access === undefined || accessOn().has(endpoint.access)) };
    };
    if (request.path.split("/").some((segment) => segment === ".." || segment === ".")) throw refuse("The path climbs.");
    const { matching, open } = allowed(request.method, request.path);
    if (matching.length === 0) throw refuse(`The manifest allows no ${request.method} ${request.path}.`);
    if (!open) throw refuse(`This connection's access doesn't include "${matching[0]!.access}".`);
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (name.toLowerCase() === "authorization" || !allowedHeaders.has(name.toLowerCase())) {
        throw refuse(`The manifest does not list the ${name} header.`);
      }
      headers[name.toLowerCase()] = value;
    }
    let url = new URL(address + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.append(key, String(value));
    const origin = url.origin;
    let method = request.method;
    for (let redirects = 0; ; redirects += 1) {
      const seen: Received = {
        url: url.href,
        method,
        headers: { ...headers, ...(url.origin === origin ? { authorization: BASIC } : {}) },
        ...(request.body !== undefined ? { body: request.body } : {}),
      };
      received.push(seen);
      const answer = azureDevOps(seen);
      const location = answer.headers?.location;
      if (answer.status >= 300 && answer.status < 400 && location) {
        const next = new URL(location, url);
        const basePath = new URL(address).pathname.replace(/\/+$/, "");
        const follows =
          next.origin === origin &&
          next.pathname.startsWith(`${basePath}/`) &&
          allowed(method, next.pathname.slice(basePath.length)).open !== undefined;
        if (follows && redirects < 3) {
          url = next;
          continue;
        }
      }
      const payload = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.body ?? "");
      // The broker scrubs the secret, in its common forms, from what comes back.
      const scrubbed = payload.replaceAll(PAT, "[secret]").replaceAll(btoa(`:${PAT}`), "[secret]");
      return Object.freeze({
        status: answer.status,
        ok: answer.status >= 200 && answer.status < 300,
        headers: Object.freeze({
          ...(answer.json !== undefined ? { "content-type": "application/json" } : {}),
          ...Object.fromEntries(Object.entries(answer.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])),
        }),
        text: async () => scrubbed,
        json: async () => JSON.parse(scrubbed),
      });
    }
  };
  Object.defineProperty(globalThis, "ajour", {
    value: Object.freeze({
      http,
      publicFetch: async () => {
        throw new Error("The plugin has no public hosts.");
      },
      log: () => undefined,
    }),
    configurable: true,
    enumerable: true,
  });
}

/** The connection as Ajour hands it to an API 4 operation: no secret field, and the access choices that are on. */
function connection(config: Record<string, string | number | boolean> = {}) {
  return {
    id: CONNECTION_ID,
    pluginId: "azure_devops",
    label: "Contoso",
    tenantLabel: "Contoso Entra",
    autoSync: true,
    autoSyncIntervalMinutes: 15,
    connectedAt: 1,
    access: [...accessOn()],
    config: {
      organizationUrl: scenario.organizationUrl,
      queryScope: "assigned_to_me",
      originalEstimateFieldName: "Original Estimate",
      ...config,
    },
  };
}

beforeAll(async () => {
  const names = (await readdir("src")).filter((name) => name.endsWith(".ts")).sort();
  for (const name of names) sourceCode[name] = withoutCommentsAndStrings(await readFile(`src/${name}`, "utf8"));
  // Installed before the import, as the worker defines `ajour` before it imports the plugin.
  installAjour();
  moduleExports = await import("../src/plugin.ts");
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "ajour");
});

describe("the source entrypoint", () => {
  it("is plain worker code: no Node built-in, Buffer, process, require, fetch or credential in its code", () => {
    expect(Object.keys(sourceCode).length).toBeGreaterThan(10);
    const forbidden: [string, RegExp][] = [
      ["require(", /\brequire\s*\(/],
      ["Buffer", /\bBuffer\b/],
      ["process.", /\bprocess\s*\./],
      ["fetch(", /\bfetch\s*\(/],
      ["XMLHttpRequest or WebSocket", /\bXMLHttpRequest\b|\bWebSocket\b/],
      ["Authorization", /\bAuthorization\b/i],
      ["the token field", /\bpersonalAccessToken\b/],
      ["a secret or token field", /\b(?:secret|accessToken|apiKey|bearer)\b/i],
    ];
    for (const [name, code] of Object.entries(sourceCode)) {
      for (const [what, pattern] of forbidden) expect(code, `${name} uses ${what}`).not.toMatch(pattern);
    }
  });

  it("imports nothing at run time but its own files, by relative path with the .ts extension", async () => {
    for (const name of Object.keys(sourceCode)) {
      const text = await readFile(`src/${name}`, "utf8");
      for (const match of text.matchAll(/^\s*(?:import|export)\b(?!\s+type\b)[^;]*?\bfrom\s*["']([^"']+)["']/gm)) {
        expect(match[1], `${name} imports ${match[1]}`).toMatch(/^\.\/[a-z-]+\.ts$/);
      }
      expect(text, name).not.toMatch(/^\s*import\s*["']/m);
      expect(text, name).not.toMatch(/\bimport\s*\(/);
    }
  });

  it("builds no identities address of its own: the broker derives that host", () => {
    expect(Object.values(sourceCode).join("\n")).not.toContain("vssps");
    expect(Object.values(sourceCode).join("\n")).not.toMatch(/\bBasic\b/);
  });

  it("exports one function per operation the worker may call", () => {
    expect(Object.keys(moduleExports).sort()).toEqual([
      "deleteItemComment",
      "editItemComment",
      "listItemComments",
      "listSettleStates",
      "postItemComment",
      "readDescription",
      "searchItemPeople",
      "setItemCommentReaction",
      "syncConnection",
      "syncPullRequests",
      "validateConnection",
      "writeDescription",
      "writeSettle",
    ]);
    for (const operation of Object.values(moduleExports)) expect(typeof operation).toBe("function");
  });
});

const scenarios: Scenario[] = [
  {
    name: "dev.azure.com",
    organizationUrl: "https://dev.azure.com/contoso",
    onPremises: false,
    identitiesUrl: "https://vssps.dev.azure.com/contoso",
  },
  {
    name: "visualstudio.com",
    organizationUrl: "https://contoso.visualstudio.com",
    onPremises: false,
    identitiesUrl: "https://contoso.vssps.visualstudio.com",
  },
  {
    name: "an Azure DevOps Server collection",
    organizationUrl: "http://ado.contoso.local:8080/tfs/DefaultCollection",
    onPremises: true,
    identitiesUrl: "http://ado.contoso.local:8080/tfs/DefaultCollection",
  },
];

describe.each(scenarios)("the source on $name, through a stand-in broker", (current) => {
  const sourceId = (id: number) => `${current.organizationUrl}/${PROJECT}/_workitems/edit/${id}`;
  const urls = () => received.map((request) => `${request.method} ${request.url}`);
  const mutations = () => received.filter((request) => ["PATCH", "PUT", "DELETE"].includes(request.method));

  function reset(access: string[] = ALL) {
    scenario = current;
    fixture = createAzureFixture(current.organizationUrl);
    received = [];
    turnedOn = access;
    override = undefined;
  }

  it("validates work items and pull requests, and returns no secret", async () => {
    reset();

    const result = await moduleExports.validateConnection!(connection(), { capabilities: ["connector", "codeHost"] });

    expect(result.normalizedConfig.organizationUrl).toBe(current.organizationUrl);
    expect(JSON.stringify(result)).not.toContain(PAT);
    expect(result.connectionSummary).toMatchObject({ account: "ada@contoso.com" });
    expect(urls()).toEqual([
      `GET ${current.organizationUrl}/_apis/wit/fields?api-version=7.1`,
      `POST ${current.organizationUrl}/_apis/wit/wiql?%24top=200&api-version=7.1`,
      `GET ${current.organizationUrl}/_apis/connectionData`,
      `GET ${current.organizationUrl}/_apis/git/repositories?api-version=7.1`,
    ]);
    expect(received.every((request) => request.headers.authorization === BASIC)).toBe(true);
  });

  it("syncs the backlog, pushes an estimate, reports a done item and the comments since its settle", async () => {
    reset();

    const result = await moduleExports.syncConnection!(connection(), [
      {
        localWorkItemId: "local-42",
        sourceId: sourceId(42),
        originalEstimateHours: 6,
        estimateSync: { originalEstimateHours: { baselineValue: 4, remoteValue: 4 } },
      },
      { localWorkItemId: "local-7", sourceId: sourceId(7), commentsSince: "2026-10-22T00:00:00Z" },
    ]);

    expect(result.items.map((item: any) => [item.externalId, item.stateDone, item.sourceId, item.description?.text])).toEqual([
      ["42", false, sourceId(42), "Steps for **login**"],
      ["7", true, sourceId(7), undefined],
    ]);
    expect(result.workItemUpdates[0].fields.originalEstimateHours).toMatchObject({ status: "pushed", nextBaselineValue: 6 });
    expect(fixture.items.get(42)!.fields["Microsoft.VSTS.Scheduling.OriginalEstimate"]).toBe(6);
    expect(result.commentFacts).toMatchObject([{ localWorkItemId: "local-7", comments: [{ id: "5", mentionsViewer: true }] }]);
    const patch = mutations();
    expect(patch.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PATCH ${current.organizationUrl}/_apis/wit/workitems/42?api-version=7.1`,
    ]);
    expect(patch[0]!.headers["content-type"]).toBe("application/json-patch+json");
  });

  it("settles a work item, and reads and writes its description", async () => {
    reset();

    await expect(moduleExports.writeSettle!(connection(), { sourceId: sourceId(42), state: "Resolved" })).resolves.toMatchObject({
      state: "Resolved",
      stateCategory: "Resolved",
      stateDone: false,
    });
    await expect(moduleExports.readDescription!(connection(), { sourceId: sourceId(42) })).resolves.toEqual({
      description: { text: "Steps for **login**" },
    });
    await expect(
      moduleExports.writeDescription!(connection(), {
        sourceId: sourceId(42),
        expected: "Steps for **login**",
        text: "Steps for **login**, then logout",
      }),
    ).resolves.toMatchObject({ outcome: "written" });
    await expect(
      moduleExports.writeDescription!(connection(), { sourceId: sourceId(42), expected: "Stale", text: "Overwrite" }),
    ).resolves.toMatchObject({ outcome: "conflict" });
    expect(String(fixture.items.get(42)!.fields["System.Description"])).toContain("then logout");
    expect(mutations().every((request) => request.headers["content-type"] === "application/json-patch+json")).toBe(true);
  });

  it("lists, posts, edits, reacts to and deletes comments, and suggests people from the identities host", async () => {
    reset();

    const page = await moduleExports.listItemComments!(connection(), { sourceId: sourceId(42), limit: 20 });
    expect(page.comments.map((comment: any) => comment.body)).toEqual(["Can you look?"]);
    expect(page.viewer).toEqual({ id: VIEWER, displayName: "Ada Lovelace" });

    const posted = await moduleExports.postItemComment!(connection(), { sourceId: sourceId(42), body: "Looking" });
    await moduleExports.editItemComment!(connection(), { sourceId: sourceId(42), commentId: posted.comment.id, body: "Done" });
    await expect(
      moduleExports.setItemCommentReaction!(connection(), {
        sourceId: sourceId(42),
        commentId: posted.comment.id,
        reaction: "hooray",
        reacted: true,
      }),
    ).resolves.toEqual({ reactions: [{ reaction: "hooray", count: 1, viewerReacted: true }] });
    await moduleExports.deleteItemComment!(connection(), { sourceId: sourceId(42), commentId: posted.comment.id });
    expect(fixture.comments.get(42)!.at(-1)).toMatchObject({ text: "Done", isDeleted: true });

    received = [];
    const people = await moduleExports.searchItemPeople!(connection(), { sourceId: sourceId(42), query: "alan", limit: 5 });
    expect(people.people.map((person: any) => person.displayName)).toEqual(["Alan Turing"]);
    expect(urls()).toContain(
      `GET ${current.identitiesUrl}/_apis/identities?searchFilter=General&filterValue=alan&queryMembership=None&api-version=7.1`,
    );
  });

  it("syncs the pull requests the viewer is asked to review", async () => {
    reset();

    const result = await moduleExports.syncPullRequests!(connection(), { tracked: [] });

    expect(result.instanceUrl).toBe(current.organizationUrl);
    expect(result.pullRequests).toMatchObject([
      { number: 12, repository: `${PROJECT}/api`, checks: "success", url: `${current.organizationUrl}/${PROJECT}/_git/api/pullrequest/12` },
    ]);
    expect(result.pullRequests[0].comments).toMatchObject([{ mentionsViewer: true }]);
  });

  it("lets a read-only connection read, WIQL and batch included, and refuses every write before it is sent", async () => {
    reset([]);

    const result = await moduleExports.syncConnection!(connection(), [
      {
        localWorkItemId: "local-42",
        sourceId: sourceId(42),
        originalEstimateHours: 4,
        estimateSync: { originalEstimateHours: { baselineValue: 4, remoteValue: 4 } },
      },
    ]);
    expect(result.items.map((item: any) => item.externalId)).toEqual(["42"]);
    expect(urls().some((url) => url.startsWith(`POST ${current.organizationUrl}/_apis/wit/wiql`))).toBe(true);
    expect(urls().some((url) => url.startsWith(`POST ${current.organizationUrl}/_apis/wit/workitemsbatch`))).toBe(true);
    await expect(moduleExports.listItemComments!(connection(), { sourceId: sourceId(42), limit: 5 })).resolves.toMatchObject({
      comments: [{ body: "Can you look?" }],
    });

    await expect(moduleExports.writeSettle!(connection(), { sourceId: sourceId(42), state: "Closed" })).rejects.toThrow(
      /editWorkItems/,
    );
    await expect(moduleExports.postItemComment!(connection(), { sourceId: sourceId(42), body: "Hi" })).rejects.toThrow(
      /editWorkItems/,
    );
    await expect(moduleExports.syncPullRequests!(connection({ includeTeamReviewRequests: false }), { tracked: [] })).rejects.toThrow(
      /pullRequests/,
    );
    const people = await moduleExports.searchItemPeople!(connection(), { sourceId: sourceId(42), query: "al", limit: 5 });
    expect(people.people.map((person: any) => person.displayName)).toEqual(["Alba Reyes"]);

    expect(mutations()).toEqual([]);
    expect(received.some((request) => request.method === "POST" && request.url.includes("/comments"))).toBe(false);
    expect(received.some((request) => request.url.includes("_apis/identities") || request.url.includes("_apis/git"))).toBe(false);
  });

  it.each([
    ["a 203 sign-in page", { status: 203, headers: { "content-type": "text/html" }, body: "<html>Sign in</html>" }],
    ["a redirect to the sign-in host", { status: 302, headers: { location: "https://app.vssps.visualstudio.com/_signin" } }],
    ["a redirect within the origin to an undeclared sign-in page", { status: 302, headers: { location: "/_signin?realm=x" } }],
  ])("recognises a token turned away with %s", async (_name, answer) => {
    reset();
    override = () => answer as FixtureAnswer;
    const rejected = /Azure DevOps rejected the token/;

    await expect(moduleExports.validateConnection!(connection(), { capabilities: ["codeHost"] })).rejects.toThrow(rejected);
    await expect(moduleExports.validateConnection!(connection(), { capabilities: ["connector"] })).rejects.toThrow(rejected);
    // The broker hands the redirect back, and sends nothing to the sign-in host.
    expect(received.every((request) => request.url.startsWith(new URL(current.organizationUrl).origin))).toBe(true);
  });

  it("follows a redirect within the organization to a declared endpoint", async () => {
    reset();
    const target = `${current.organizationUrl}/_apis/connectionData`;
    let redirected = false;
    override = (request) => {
      if (!redirected && request.url.includes("_apis/connectionData")) {
        redirected = true;
        return { status: 307, headers: { location: `${target}?moved=1` } };
      }
      return undefined;
    };

    await expect(moduleExports.listItemComments!(connection(), { sourceId: sourceId(42), limit: 5 })).resolves.toMatchObject({
      viewer: { id: VIEWER },
    });
    expect(urls()).toContain(`GET ${target}?moved=1`);
  });

  it("explains a token Azure DevOps refuses with 401", async () => {
    reset();
    override = () => ({ status: 401, body: "" });

    await expect(moduleExports.syncPullRequests!(connection(), { tracked: [] })).rejects.toThrow(/rejected the token/);
    await expect(moduleExports.readDescription!(connection(), { sourceId: sourceId(42) })).rejects.toThrow(/\(401\)/);
  });
});
