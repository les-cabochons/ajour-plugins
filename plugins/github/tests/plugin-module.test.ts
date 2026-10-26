import { afterAll, beforeAll, describe, expect, it } from "vitest";
import manifest from "../plugin.json";

/*
 * The source entrypoint, `src/plugin.ts`, loaded the way Ajour's worker loads
 * a plugin: as an ES module whose named exports are the operations, running with
 * a frozen `ajour` global and nothing else. The global here is a small
 * stand-in for the broker: it derives the REST and GraphQL addresses from the
 * GitHub URL the connection saved, by the manifest's own derived host forms,
 * attaches the bearer credential the vault holds, refuses what the manifest
 * does not declare, and forwards to a fixture GitHub that routes by the real
 * URL, as GitHub.com and GitHub Enterprise Server lay their APIs out.
 */

const TOKEN = "github_pat_5c0ffee";
const BEARER = `Bearer ${TOKEN}`;
const CONNECTION_ID = "connection-1";

const GITHUB_COM = "https://github.com";
const ENTERPRISE = "https://ghe.acme.test:8443";

interface Received {
  /** The URL the broker built. */
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: any;
}

interface FixtureIssue {
  id: string;
  title: string;
  body: string;
  state: "OPEN" | "CLOSED";
  stateReason: "COMPLETED" | "NOT_PLANNED" | "REOPENED" | null;
}

let currentBase = GITHUB_COM;
let received: Received[] = [];
let issues: Record<number, FixtureIssue> = {};
let moduleExports: Record<string, (...args: any[]) => Promise<any>>;

const viewer = { __typename: "User", login: "octocat", name: "The Octocat", avatarUrl: "https://example.test/a.png" };
const alice = { __typename: "User", login: "alice", avatarUrl: "https://example.test/b.png" };

function graphqlIssue(number: number) {
  const issue = issues[number]!;
  return {
    id: issue.id,
    number,
    url: `${currentBase}/acme/api/issues/${number}`,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    stateReason: issue.stateReason,
    repository: { nameWithOwner: "acme/api" },
    assignees: { nodes: [{ login: "octocat" }] },
  };
}

function pullRequest() {
  return {
    id: "PR_1",
    number: 1,
    url: `${currentBase}/acme/api/pull/1`,
    title: "Add rate limits",
    isDraft: false,
    state: "OPEN",
    createdAt: "2026-10-01T10:00:00Z",
    updatedAt: "2026-10-02T10:00:00Z",
    closedAt: null,
    headRefOid: "abc123",
    headRefName: "change/rate-limits",
    headRepository: { nameWithOwner: "alice/api" },
    mergeable: "MERGEABLE",
    repository: { nameWithOwner: "acme/api" },
    author: alice,
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    timelineItems: { nodes: [] },
    reviewRequests: { nodes: [] },
    reviews: {
      nodes: [{ id: "R_1", state: "CHANGES_REQUESTED", submittedAt: "2026-10-01T13:00:00Z", body: "", author: viewer }],
    },
    comments: { nodes: [] },
    reviewThreads: { nodes: [] },
  };
}

function searchResult(nodes: unknown[]) {
  return { search: { issueCount: nodes.length, pageInfo: { hasNextPage: false, endCursor: null }, nodes } };
}

/** What a GitHub API answers, once the URL says which API it is. */
function graphql(request: Received): unknown {
  const { query, variables } = request.body as { query: string; variables: Record<string, any> };
  if (query.includes("closeIssue")) {
    const issue = Object.values(issues).find((candidate) => candidate.id === variables.id)!;
    issue.state = "CLOSED";
    issue.stateReason = variables.reason;
    return { closeIssue: { issue: graphqlIssue(Number(issue.id.slice(2))) } };
  }
  if (query.includes("reopenIssue")) {
    const issue = Object.values(issues).find((candidate) => candidate.id === variables.id)!;
    issue.state = "OPEN";
    issue.stateReason = "REOPENED";
    return { reopenIssue: { issue: graphqlIssue(Number(issue.id.slice(2))) } };
  }
  if (query.includes("organizations")) {
    return { viewer: { organizations: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } };
  }
  if (query.includes("search(")) {
    if (query.includes("... on PullRequest")) {
      return searchResult(String(variables.q).includes("reviewed-by") ? [pullRequest()] : []);
    }
    return searchResult(
      Object.keys(issues)
        .map(Number)
        .filter((number) => issues[number]!.state === "OPEN")
        .map(graphqlIssue),
    );
  }
  if (query.includes("repository(owner: $o0")) {
    return Object.fromEntries(
      Object.entries(variables)
        .filter(([name]) => name.startsWith("n"))
        .map(([name, number]) => [`i${name.slice(1)}`, { issue: issues[number as number] ? graphqlIssue(number as number) : null }]),
    );
  }
  if (query.includes("repository(")) {
    return { repository: { issue: graphqlIssue(variables.number) } };
  }
  return { viewer };
}

/** A fixture GitHub. It routes by the URL the broker built, and refuses a request without the bearer credential. */
function github(request: Received): { status: number; body?: unknown } {
  if (request.headers.authorization !== BEARER) {
    return { status: 401, body: { message: "Bad credentials" } };
  }
  const url = new URL(request.url);
  const onGitHubCom = url.host === "api.github.com";
  const onEnterprise = url.host === new URL(ENTERPRISE).host;
  const graphqlPath = onGitHubCom ? "/graphql" : "/api/graphql";
  const restPrefix = onGitHubCom ? "" : "/api/v3";
  if (!onGitHubCom && !onEnterprise) return { status: 404, body: { message: "Not Found" } };

  if (url.pathname === graphqlPath && request.method === "POST") {
    return { status: 200, body: { data: graphql(request) } };
  }
  if (!url.pathname.startsWith(`${restPrefix}/repos/`)) return { status: 404, body: { message: "Not Found" } };
  const rest = url.pathname.slice(restPrefix.length);

  if (rest === "/repos/alice/api/activity") {
    return {
      status: 200,
      body: [
        { after: "abc123", ref: url.searchParams.get("ref"), activity_type: "push", timestamp: "2026-10-02T10:00:00Z", actor: { login: "octocat", type: "User" } },
      ],
    };
  }
  const issuePath = /^\/repos\/acme\/api\/issues\/(\d+)$/.exec(rest);
  if (issuePath) {
    const issue = issues[Number(issuePath[1])]!;
    if (request.method === "PATCH") issue.body = request.body.body;
    return { status: 200, body: { number: Number(issuePath[1]), body: issue.body } };
  }
  return { status: 404, body: { message: "Not Found" } };
}

function endpointMatches(pattern: string, requestPath: string) {
  const patternParts = pattern.split("/");
  const parts = requestPath.split("/");
  return patternParts.length === parts.length && patternParts.every((part, index) => part === "*" || part === parts[index]);
}

interface DerivedForm {
  whenHost?: string;
  host: string;
  pathPrefix?: string;
  keepBasePath?: boolean;
}

/** The address a derived host's requests go to for a saved base address, by the manifest's forms. */
function derive(forms: DerivedForm[], baseAddress: string) {
  const base = new URL(baseAddress);
  const baseHost = base.hostname.toLowerCase();
  const form = forms.find((candidate) => candidate.whenHost === undefined || candidate.whenHost === baseHost)!;
  const host = form.host.replaceAll("{host}", baseHost);
  const port = host === baseHost && base.port ? `:${base.port}` : "";
  const basePath = form.keepBasePath === false ? "" : base.pathname.replace(/\/+$/, "");
  return `${base.protocol}//${host}${port}${basePath}${form.pathPrefix ?? ""}`;
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
    const derived = manifest.network.derivedHosts.find((candidate) => candidate.id === request.host);
    if (!derived) throw refuse(`The manifest derives no host ${request.host}; the GitHub URL itself declares no endpoint.`);
    if (!derived.endpoints.some((endpoint) => endpoint.method === request.method && endpointMatches(endpoint.path, request.path))) {
      throw refuse(`The manifest allows no ${request.method} ${request.path} on ${derived.id}.`);
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      if (!allowedHeaders.has(name.toLowerCase())) throw refuse(`The manifest does not list the ${name} header.`);
      headers[name.toLowerCase()] = value;
    }
    const url = new URL(derive(derived.forms, currentBase) + request.path);
    for (const [key, value] of Object.entries(request.query ?? {})) url.searchParams.append(key, String(value));
    const seen: Received = {
      url: url.href,
      method: request.method,
      headers: { ...headers, authorization: BEARER },
      ...(request.body !== undefined ? { body: JSON.parse(request.body) } : {}),
    };
    received.push(seen);
    const answer = github(seen);
    const payload = answer.body === undefined ? "" : JSON.stringify(answer.body);
    return Object.freeze({
      status: answer.status,
      ok: answer.status >= 200 && answer.status < 300,
      headers: Object.freeze({}),
      text: async () => payload,
      json: async () => JSON.parse(payload),
    });
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

/** The connection as Ajour hands it to an API 4 operation: no secret field. */
function connection(config: Record<string, string | number | boolean> = {}) {
  return {
    id: CONNECTION_ID,
    pluginId: "github",
    label: "Work",
    tenantLabel: "Acme",
    autoSync: true,
    autoSyncIntervalMinutes: 5,
    connectedAt: 1,
    access: [],
    config: { hostUrl: currentBase, ...config },
  };
}

beforeAll(async () => {
  // Installed before the import, as the worker defines `ajour` before it imports the plugin.
  installAjour();
  moduleExports = await import("../src/plugin.ts");
});

afterAll(() => {
  Reflect.deleteProperty(globalThis, "ajour");
});

describe("the source entrypoint", () => {
  it("exports one function per operation the worker may call", () => {
    expect(Object.keys(moduleExports).sort()).toEqual([
      "listSettleStates",
      "readDescription",
      "syncConnection",
      "syncPullRequests",
      "validateConnection",
      "writeDescription",
      "writeSettle",
    ]);
    for (const operation of Object.values(moduleExports)) expect(typeof operation).toBe("function");
  });
});

describe.each([
  {
    name: "GitHub.com",
    base: GITHUB_COM,
    graphqlUrl: "https://api.github.com/graphql",
    restUrl: (path: string) => `https://api.github.com${path}`,
  },
  {
    name: "GitHub Enterprise Server",
    base: ENTERPRISE,
    graphqlUrl: "https://ghe.acme.test:8443/api/graphql",
    restUrl: (path: string) => `https://ghe.acme.test:8443/api/v3${path}`,
  },
])("the source on $name, run through a stand-in broker", ({ base, graphqlUrl, restUrl }) => {
  const sourceId = (number: number) => `${base}/acme/api/issues/${number}`;
  const urls = () => received.map((request) => `${request.method} ${request.url}`);

  function reset() {
    currentBase = base;
    received = [];
    issues = {
      7: { id: "I_7", title: "Rate limits", body: "Steps for @octocat", state: "OPEN", stateReason: null },
      8: { id: "I_8", title: "Shipped", body: "", state: "CLOSED", stateReason: "COMPLETED" },
    };
  }

  it("validates the connection with one GraphQL POST to the derived address, and returns no secret", async () => {
    reset();

    const result = await moduleExports.validateConnection!(connection({ include: "Acme" }), { capabilities: ["connector", "codeHost"] });

    expect(result).toEqual({
      normalizedConfig: {
        hostUrl: base,
        include: "acme",
        exclude: "",
        hideDrafts: false,
        includeTeamRequests: true,
      },
      connectionSummary: { account: "octocat", host: new URL(base).host },
    });
    expect(urls()).toEqual([`POST ${graphqlUrl}`]);
    expect(received[0]!.headers).toMatchObject({
      authorization: BEARER,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "user-agent": "ajour-github-plugin",
    });
  });

  it("syncs pull requests over GraphQL, and attributes the push over REST with GitHub's version and agent headers", async () => {
    reset();

    const result = await moduleExports.syncPullRequests!(connection(), { tracked: [] });

    expect(result.instanceUrl).toBe(base);
    expect(result.viewer).toMatchObject({ login: "octocat" });
    expect(result.pullRequests).toHaveLength(1);
    expect(result.pullRequests[0]).toMatchObject({
      repository: "acme/api",
      number: 1,
      lastPushedAt: Date.parse("2026-10-02T10:00:00Z"),
      lastPushActor: { login: "octocat", isBot: false },
    });
    const rest = received.filter((request) => !request.url.endsWith("graphql"));
    expect(rest.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${restUrl("/repos/alice/api/activity")}?ref=refs%2Fheads%2Fchange%2Frate-limits&per_page=100&direction=desc`,
    ]);
    expect(rest[0]!.headers).toMatchObject({
      authorization: BEARER,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "ajour-github-plugin",
    });
    const graphqlCalls = received.filter((request) => request.url.endsWith("graphql"));
    expect(graphqlCalls.length).toBeGreaterThan(0);
    expect(graphqlCalls.every((request) => request.url === graphqlUrl && request.method === "POST")).toBe(true);
  });

  it("syncs assigned issues and finds the tracked one that closed", async () => {
    reset();

    const result = await moduleExports.syncConnection!(connection(), [
      { localWorkItemId: "a", sourceId: sourceId(7) },
      { localWorkItemId: "b", sourceId: sourceId(8) },
    ]);

    expect(result.items.map((item: any) => [item.externalId, item.state, item.stateDone, item.connectionId, item.sourceId])).toEqual([
      ["acme/api#7", "Open", false, CONNECTION_ID, sourceId(7)],
      ["acme/api#8", "Closed", true, CONNECTION_ID, sourceId(8)],
    ]);
    expect(result.items[0].description).toEqual({ text: "Steps for @octocat" });
    expect(urls()).toEqual([`POST ${graphqlUrl}`, `POST ${graphqlUrl}`]);
    expect(received.every((request) => request.headers.authorization === BEARER)).toBe(true);
  });

  it("lists the settle states, closes an open issue as not planned, and reopens it", async () => {
    reset();

    await expect(moduleExports.listSettleStates!(connection(), { sourceId: sourceId(7) })).resolves.toEqual({
      states: [
        { name: "Open", category: "Open", done: false },
        { name: "Closed", category: "Closed", done: true },
        { name: "Closed as not planned", category: "Closed", done: true },
      ],
    });

    await expect(moduleExports.writeSettle!(connection(), { sourceId: sourceId(7), state: "Closed as not planned" })).resolves.toEqual({
      state: "Closed as not planned",
      stateCategory: "Closed",
      stateDone: true,
    });
    expect(issues[7]).toMatchObject({ state: "CLOSED", stateReason: "NOT_PLANNED" });

    await expect(moduleExports.writeSettle!(connection(), { sourceId: sourceId(7), state: "Open" })).resolves.toEqual({
      state: "Open",
      stateCategory: "Open",
      stateDone: false,
    });
    expect(issues[7]).toMatchObject({ state: "OPEN" });
    expect(received.every((request) => request.url === graphqlUrl)).toBe(true);
  });

  it("reads and writes a description over REST, and answers a conflict when it moved", async () => {
    reset();

    await expect(moduleExports.readDescription!(connection(), { sourceId: sourceId(7) })).resolves.toEqual({
      description: { text: "Steps for @octocat" },
    });

    await expect(
      moduleExports.writeDescription!(connection(), {
        sourceId: sourceId(7),
        text: "Steps for @octocat and @alice",
        expected: "Steps for @octocat",
      }),
    ).resolves.toEqual({ outcome: "written", description: { text: "Steps for @octocat and @alice" } });
    expect(issues[7]!.body).toBe("Steps for @octocat and @alice");

    await expect(
      moduleExports.writeDescription!(connection(), { sourceId: sourceId(7), text: "Overwrite", expected: "Steps for @octocat" }),
    ).resolves.toMatchObject({ outcome: "conflict", description: { text: "Steps for @octocat and @alice" } });

    expect(urls()).toEqual([
      `GET ${restUrl("/repos/acme/api/issues/7")}`,
      `GET ${restUrl("/repos/acme/api/issues/7")}`,
      `PATCH ${restUrl("/repos/acme/api/issues/7")}`,
      `GET ${restUrl("/repos/acme/api/issues/7")}`,
    ]);
    const patch = received.find((request) => request.method === "PATCH")!;
    expect(patch.headers).toMatchObject({ "content-type": "application/json", "x-github-api-version": "2022-11-28" });
    expect(patch.body).toEqual({ body: "Steps for @octocat and @alice" });
  });

  it("fails with a plain message when the broker's credential is rejected", async () => {
    reset();
    const original = (globalThis as any).ajour;
    Object.defineProperty(globalThis, "ajour", {
      value: Object.freeze({
        ...original,
        http: async () => ({ status: 401, ok: false, headers: {}, text: async () => "", json: async () => ({}) }),
      }),
      configurable: true,
    });

    try {
      await expect(moduleExports.validateConnection!(connection(), { capabilities: [] })).rejects.toThrow(
        "GitHub rejected the token. Check that it is valid and not expired.",
      );
      await expect(moduleExports.readDescription!(connection(), { sourceId: sourceId(7) })).rejects.toThrow(
        "GitHub rejected the token. Check that it is valid and not expired.",
      );
    } finally {
      Object.defineProperty(globalThis, "ajour", { value: original, configurable: true, enumerable: true });
    }
  });
});
