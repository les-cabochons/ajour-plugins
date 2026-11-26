/*
 * A small Azure DevOps service for tests: one organization with a project,
 * work items and their comments, the viewer, an identity directory and one
 * pull request with its iterations, their changes and the repository's
 * files at each commit. It answers a request by its method, its path under
 * the organization (or collection) and its query, as the real service lays
 * its REST API out, and keeps what writes and pushes change, so a test can
 * read it back.
 */

export const VIEWER = "11111111-1111-1111-1111-111111111111";
export const ALBA = "44444444-4444-4444-4444-444444444444";
export const PROJECT = "Mercury";
export const PROJECT_ID = "99999999-9999-9999-9999-999999999999";

/** The pull request's commits: each iteration's head, and the common commit it is compared with. */
export const BASE_1 = "c0ffee00000000000000000000000000000000b1";
export const HEAD_1 = "c0ffee00000000000000000000000000000000a1";
export const BASE_2 = "c0ffee00000000000000000000000000000000b2";
export const HEAD_2 = "c0ffee00000000000000000000000000000000a2";

export const ORIGINAL_ESTIMATE = "Microsoft.VSTS.Scheduling.OriginalEstimate";
export const EFFORT = "Microsoft.VSTS.Scheduling.Effort";

export interface FixtureWorkItem {
  id: number;
  rev: number;
  fields: Record<string, unknown>;
  parent?: number;
  markdown?: boolean;
}

export interface FixtureComment {
  id: number;
  text: string;
  format: "markdown" | "html";
  createdBy: { id: string; displayName: string; uniqueName?: string };
  createdDate: string;
  modifiedDate?: string;
  isDeleted?: boolean;
  reactions: { type: string; count: number; isCurrentUserEngaged: boolean }[];
}

/** A change of an iteration, as Azure DevOps lists it: `changeType` is a list of flags such as "edit, rename". */
export interface FixtureChange {
  changeTrackingId: number;
  changeId: number;
  item: { objectId?: string; originalObjectId?: string; path: string; gitObjectType?: string; isFolder?: boolean };
  changeType: string;
  originalPath?: string;
}

export interface FixtureIteration {
  id: number;
  createdDate: string;
  author: { id: string; displayName: string; uniqueName?: string };
  sourceRefCommit: { commitId: string };
  commonRefCommit?: { commitId: string };
  targetRefCommit: { commitId: string };
  /** Why Azure DevOps made the iteration: create, push, forcePush, rebase… */
  reason?: string;
  push?: { date?: string };
  /** The iteration's commits, newest first, listed only with `includeCommits=true`. */
  commits?: FixtureCommit[];
}

/** A commit as an iteration lists it. */
export interface FixtureCommit {
  commitId: string;
  comment: string;
  author: { name: string; date: string };
  committer: { name: string; date: string };
}

/** A commit by Alba at `date`. */
export function commitOf(commitId: string, comment: string, date: string): FixtureCommit {
  return { commitId, comment, author: { name: "Alba", date }, committer: { name: "Alba", date } };
}

export interface FixtureAnswer {
  status: number;
  headers?: Record<string, string>;
  json?: unknown;
  body?: string;
}

export interface FixtureRequest {
  method: string;
  /** The path under the organization or collection, such as `/_apis/wit/wiql`. */
  path: string;
  query: URLSearchParams;
  body?: string;
  /** Whether the request reached the identities host. */
  identities?: boolean;
}

const AGILE_STATES = [
  { name: "New", category: "Proposed" },
  { name: "Active", category: "InProgress" },
  { name: "Resolved", category: "Resolved" },
  { name: "Closed", category: "Completed" },
  { name: "Removed", category: "Removed" },
];

const FIELDS = [
  { name: "Original Estimate", referenceName: ORIGINAL_ESTIMATE, type: "double", isQueryable: true },
  { name: "Effort", referenceName: EFFORT, type: "double", isQueryable: true },
  { name: "Priority", referenceName: "Microsoft.VSTS.Common.Priority", type: "integer", isQueryable: true },
];

/** The one-path SVG Azure DevOps answers for an icon. */
export const TASK_ICON_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path fill="#F2CB1D" d="M2 2h12v12H2z"/></svg>';

const typeField = (name: string, referenceName: string) => ({ name, referenceName });
const TITLE = typeField("Title", "System.Title");

/** The project's work item types, as `GET {project}/_apis/wit/workitemtypes` lists them. */
const WORK_ITEM_TYPES = [
  {
    name: "Task",
    color: "F2CB1D",
    icon: { id: "icon_clipboard", url: "https://tfsprodcus3.visualstudio.com/_apis/wit/workItemIcons/icon_clipboard" },
    isDisabled: false,
    fields: [
      TITLE,
      typeField("Original Estimate", ORIGINAL_ESTIMATE),
      typeField("Remaining Work", "Microsoft.VSTS.Scheduling.RemainingWork"),
      typeField("Completed Work", "Microsoft.VSTS.Scheduling.CompletedWork"),
    ],
  },
  {
    name: "Bug",
    color: "CC293D",
    icon: { id: "icon_insect" },
    isDisabled: false,
    fields: [TITLE, typeField("Priority", "Microsoft.VSTS.Common.Priority")],
  },
  {
    name: "User Story",
    color: "009CCC",
    icon: { id: "icon_book" },
    isDisabled: false,
    fields: [TITLE, typeField("Story Points", "Microsoft.VSTS.Scheduling.StoryPoints")],
  },
  {
    name: "Epic",
    color: "FF7B00",
    icon: { id: "icon_crown" },
    isDisabled: false,
    fields: [TITLE, typeField("Size", "Microsoft.VSTS.Scheduling.Size"), typeField("Effort", EFFORT)],
  },
  // Listed without its fields, as an answer that leaves them out would be.
  { name: "Issue", color: "B4009E", icon: { id: "icon_list" }, isDisabled: false },
  { name: "Test Case", color: "004B50", icon: { id: "icon_test_case" }, isDisabled: false, fields: [TITLE] },
  { name: "Old Request", color: "773B93", icon: { id: "icon_list" }, isDisabled: true, fields: [TITLE] },
];

/** A second project on another process, whose Task keeps only remaining work. */
export const OTHER_PROJECT = "Venus";
const OTHER_PROJECT_TYPES = [
  {
    name: "Task",
    color: "F2CB1D",
    icon: { id: "icon_clipboard" },
    isDisabled: false,
    fields: [TITLE, typeField("Remaining Work", "Microsoft.VSTS.Scheduling.RemainingWork")],
  },
];

const viewer = { id: VIEWER, displayName: "Ada Lovelace", uniqueName: "ada@contoso.com" };
const alba = { id: ALBA, displayName: "Alba Reyes", uniqueName: "alba@contoso.com" };

/** A file of 40 lines, so a change near its top and one near its end make two hunks. */
const LIMITS_BASE = Array.from({ length: 40 }, (_, index) =>
  index === 1 ? "export const limit = 10;\n" : `// line ${index + 1}\n`,
).join("");
export const LIMITS_HEAD_1 = LIMITS_BASE.replace("limit = 10;", "limit = 20;").replace("// line 39\n", "// line thirty-nine\n");

/** A change of a file, with blob ids as Azure DevOps names them: only the sides the change has. */
export function change(changeTrackingId: number, path: string, changeType: string, originalPath?: string): FixtureChange {
  const flags = changeType.split(",").map((flag) => flag.trim());
  return {
    changeTrackingId,
    changeId: changeTrackingId,
    item: {
      ...(flags.includes("delete") ? {} : { objectId: `blob-new-${changeTrackingId}` }),
      ...(flags.includes("add") ? {} : { originalObjectId: `blob-old-${changeTrackingId}` }),
      path,
      gitObjectType: "blob",
    },
    changeType,
    ...(originalPath ? { originalPath } : {}),
  };
}

function json(body: unknown, status = 200): FixtureAnswer {
  return { status, json: body };
}

export function createAzureFixture(organizationUrl: string) {
  const items = new Map<number, FixtureWorkItem>([
    [
      42,
      {
        id: 42,
        rev: 3,
        fields: {
          "System.Title": "Fix login",
          "System.State": "Active",
          "System.TeamProject": PROJECT,
          "System.WorkItemType": "Task",
          "System.AssignedTo": viewer,
          "System.CreatedBy": alba,
          "System.ChangedDate": "2026-10-20T10:00:00Z",
          "System.Description": "<div>Steps for <b>login</b></div>",
          [ORIGINAL_ESTIMATE]: 4,
        },
        parent: 40,
      },
    ],
    [
      40,
      {
        id: 40,
        rev: 1,
        fields: {
          "System.Title": "Sign-in story",
          "System.State": "Active",
          "System.TeamProject": PROJECT,
          "System.WorkItemType": "User Story",
          "System.ChangedDate": "2026-10-19T10:00:00Z",
        },
      },
    ],
    [
      7,
      {
        id: 7,
        rev: 9,
        fields: {
          "System.Title": "Old bug",
          "System.State": "Closed",
          "System.TeamProject": PROJECT,
          "System.WorkItemType": "Task",
          "System.ChangedDate": "2026-10-21T10:00:00Z",
        },
      },
    ],
  ]);
  const comments = new Map<number, FixtureComment[]>([
    [
      42,
      [
        {
          id: 1,
          text: "Can you look?",
          format: "markdown",
          createdBy: alba,
          createdDate: "2026-10-21T09:00:00Z",
          reactions: [],
        },
      ],
    ],
    [
      7,
      [
        {
          id: 5,
          text: `Reopen this, @<${VIEWER}>?`,
          format: "markdown",
          createdBy: alba,
          createdDate: "2026-10-22T09:00:00Z",
          reactions: [],
        },
      ],
    ],
  ]);
  const pullRequest = {
    pullRequestId: 12,
    status: "active",
    title: "Rate limits",
    creationDate: "2026-10-01T10:00:00Z",
    createdBy: alba,
    reviewers: [{ ...viewer, vote: 0 }],
    mergeStatus: "succeeded",
    lastMergeSourceCommit: { commitId: HEAD_1 },
    targetRefName: "refs/heads/main",
    repository: { id: "repo-1", name: "api", project: { id: PROJECT_ID, name: PROJECT } },
  };
  /** The repository's files at each commit, by `commit:path`. A binary file holds a NUL. */
  const files = new Map<string, string>([
    [`${BASE_1}:src/limits.ts`, LIMITS_BASE],
    [`${HEAD_1}:src/limits.ts`, LIMITS_HEAD_1],
    [`${HEAD_1}:src/new.ts`, "export const added = true;\n"],
    [`${BASE_1}:src/old.ts`, "export const removed = true;\n"],
    [`${BASE_1}:src/before.ts`, "export const moved = 1;\nexport const kept = 2;\n"],
    [`${HEAD_1}:src/after.ts`, "export const moved = 3;\nexport const kept = 2;\n"],
    [`${BASE_1}:docs/read me.md`, "# Read me\n"],
    [`${HEAD_1}:docs/guide.md`, "# Read me\n"],
    [`${BASE_1}:assets/logo.png`, "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR"],
    [`${HEAD_1}:assets/logo.png`, "\u0089PNG\r\n\u001a\n\u0000\u0000\u0000\rIHDR2"],
  ]);
  const iterations: FixtureIteration[] = [
    {
      id: 1,
      createdDate: "2026-10-02T09:00:00Z",
      author: alba,
      sourceRefCommit: { commitId: HEAD_1 },
      commonRefCommit: { commitId: BASE_1 },
      targetRefCommit: { commitId: BASE_1 },
      reason: "create",
      push: { date: "2026-10-02T08:59:00Z" },
      commits: [
        commitOf(HEAD_1, "Raise the limit\n\nTwenty is what the API allows.", "2026-10-02T08:30:00Z"),
        commitOf("c0ffee00000000000000000000000000000000c1", "Add the limits file", "2026-10-02T08:00:00Z"),
      ],
    },
  ];
  /** Each iteration's changes against its common commit, as `$compareTo=0` lists them. */
  const changes = new Map<number, FixtureChange[]>([
    [
      1,
      [
        { changeTrackingId: 1, changeId: 1, item: { path: "/src", gitObjectType: "tree", isFolder: true }, changeType: "edit" },
        change(2, "/src/limits.ts", "edit"),
        change(3, "/src/new.ts", "add"),
        change(4, "/src/old.ts", "delete"),
        change(5, "/src/after.ts", "edit, rename", "/src/before.ts"),
        change(6, "/docs/guide.md", "rename", "/docs/read me.md"),
        change(7, "/assets/logo.png", "edit"),
      ],
    ],
  ]);
  let nextCommentId = 100;

  /**
   * A push: a new iteration with its head and common commit, its changes
   * against that commit, and the files it adds to the repository.
   */
  function push(
    head: string,
    common: string,
    iterationChanges: FixtureChange[],
    added: Record<string, string> = {},
    detail: Pick<FixtureIteration, "reason" | "push" | "commits"> = {},
  ) {
    const id = iterations.length + 1;
    iterations.push({
      id,
      createdDate: `2026-10-0${id + 1}T09:00:00Z`,
      author: alba,
      sourceRefCommit: { commitId: head },
      commonRefCommit: { commitId: common },
      targetRefCommit: { commitId: common },
      reason: "push",
      ...detail,
    });
    changes.set(id, iterationChanges);
    for (const [key, text] of Object.entries(added)) files.set(key, text);
    pullRequest.lastMergeSourceCommit = { commitId: head };
    return id;
  }

  function workItemJson(item: FixtureWorkItem, fieldNames?: string[], relations = false) {
    const fields = fieldNames
      ? Object.fromEntries(Object.entries(item.fields).filter(([name]) => fieldNames.includes(name)))
      : item.fields;
    return {
      id: item.id,
      rev: item.rev,
      fields,
      ...(relations
        ? {
            relations: item.parent
              ? [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `${organizationUrl}/_apis/wit/workItems/${item.parent}` }]
              : [],
          }
        : {}),
      // As the real service: the formats only for a request that names no fields.
      ...(fieldNames ? {} : { multilineFieldsFormat: item.markdown ? { "System.Description": "markdown" } : {} }),
    };
  }

  function commentJson(comment: FixtureComment) {
    return { ...comment, renderedText: comment.text };
  }

  /** Applies a JSON patch to a work item, testing its revision as the real service does. */
  function patch(item: FixtureWorkItem, body: string): FixtureAnswer {
    const operations = JSON.parse(body) as { op: string; path: string; value: unknown }[];
    for (const operation of operations) {
      if (operation.op === "test" && operation.path === "/rev" && operation.value !== item.rev) {
        return json({ message: "TF26071: This work item has been changed by someone else since you opened it." }, 412);
      }
    }
    for (const operation of operations) {
      if (operation.op !== "add") continue;
      if (operation.path.startsWith("/fields/")) item.fields[operation.path.slice("/fields/".length)] = operation.value;
      if (operation.path === "/multilineFieldsFormat/System.Description") item.markdown = operation.value === "Markdown";
    }
    item.rev += 1;
    return json(workItemJson(item));
  }

  function answer(request: FixtureRequest): FixtureAnswer {
    const { method, path, query } = request;
    if (request.identities) {
      if (method === "GET" && path === "/_apis/identities") {
        const filter = (query.get("filterValue") ?? "").toLowerCase();
        return json({
          value: [
            { id: ALBA, providerDisplayName: "Alba Reyes", properties: { Mail: { $value: "alba@contoso.com" } } },
            { id: "66666666-6666-6666-6666-666666666666", providerDisplayName: "Alan Turing", properties: {} },
          ].filter((identity) => identity.providerDisplayName.toLowerCase().startsWith(filter)),
        });
      }
      return json({ message: "Not found" }, 404);
    }

    if (method === "GET" && path === "/_apis/connectionData") {
      return json({
        authenticatedUser: {
          id: VIEWER,
          providerDisplayName: "Ada Lovelace",
          properties: { Account: { $value: "ada@contoso.com" } },
        },
      });
    }
    if (method === "GET" && path === "/_apis/wit/fields") return json({ value: FIELDS });
    if (method === "POST" && path === "/_apis/wit/wiql") {
      const open = [...items.values()].filter(
        (item) => item.fields["System.State"] !== "Closed" && item.fields["System.AssignedTo"] !== undefined,
      );
      return json({ workItems: open.map((item) => ({ id: item.id })) });
    }
    if (method === "POST" && path === `/${PROJECT}/_apis/wit/wiql`) {
      return json({ workItems: [...items.keys()].map((id) => ({ id })) });
    }
    if (method === "POST" && path === "/_apis/wit/workitemsbatch") {
      const batch = JSON.parse(request.body ?? "{}") as { ids: number[]; fields?: string[]; $expand?: string };
      return json({
        value: batch.ids
          .flatMap((id) => (items.has(id) ? [items.get(id)!] : []))
          .map((item) => workItemJson(item, batch.fields, batch.$expand === "Relations")),
      });
    }

    const workItem = /^\/_apis\/wit\/workitems\/(\d+)$/.exec(path);
    if (workItem) {
      const item = items.get(Number(workItem[1]));
      if (!item) return json({ message: "Not found" }, 404);
      if (method === "PATCH") return patch(item, request.body ?? "[]");
      if (method === "GET") return json(workItemJson(item, query.get("fields")?.split(",")));
    }

    if (method === "GET" && path === `/${PROJECT}/_apis/wit/workitemtypes`) {
      return json({ count: WORK_ITEM_TYPES.length, value: WORK_ITEM_TYPES });
    }
    if (method === "GET" && path === `/${OTHER_PROJECT}/_apis/wit/workitemtypes`) {
      return json({ count: OTHER_PROJECT_TYPES.length, value: OTHER_PROJECT_TYPES });
    }
    const icon = /^\/_apis\/wit\/workitemicons\/([^/]+)$/.exec(path);
    if (icon && method === "GET") {
      // As the real service: the SVG, a sign-in page for an icon it won't draw, or an error.
      if (icon[1] === "icon_crown") return json({ message: "Icon service unavailable" }, 500);
      if (icon[1] === "icon_insect") return { status: 200, headers: { "content-type": "text/html" }, body: "<html><body>Sign in</body></html>" };
      return { status: 200, headers: { "content-type": "image/svg+xml" }, body: TASK_ICON_SVG };
    }

    const typeInfo = new RegExp(`^/${PROJECT}/_apis/wit/workitemtypes/([^/]+)/(states|fields)$`).exec(path);
    if (typeInfo && method === "GET") {
      return json({ value: typeInfo[2] === "states" ? AGILE_STATES : FIELDS });
    }

    const commentPath = new RegExp(`^/${PROJECT}/_apis/wit/workItems/(\\d+)/comments(?:/(\\d+))?(?:/reactions/([a-z]+))?$`).exec(path);
    if (commentPath) {
      const list = comments.get(Number(commentPath[1])) ?? [];
      comments.set(Number(commentPath[1]), list);
      const commentId = commentPath[2] ? Number(commentPath[2]) : undefined;
      const reaction = commentPath[3];
      if (commentId === undefined) {
        if (method === "GET") {
          const visible = [...list].reverse();
          return json({ totalCount: list.length, count: visible.length, comments: visible.map(commentJson) });
        }
        if (method === "POST") {
          const created: FixtureComment = {
            id: nextCommentId++,
            text: (JSON.parse(request.body ?? "{}") as { text: string }).text,
            format: query.get("format") === "markdown" ? "markdown" : "html",
            createdBy: viewer,
            createdDate: "2026-10-25T12:00:00Z",
            reactions: [],
          };
          list.push(created);
          return json(commentJson(created));
        }
      }
      const comment = list.find((candidate) => candidate.id === commentId);
      if (!comment) return json({ message: "Not found" }, 404);
      if (reaction) {
        const existing = comment.reactions.find((candidate) => candidate.type === reaction);
        if (method === "PUT") {
          if (existing) {
            existing.count += 1;
            existing.isCurrentUserEngaged = true;
          } else {
            comment.reactions.push({ type: reaction, count: 1, isCurrentUserEngaged: true });
          }
        } else if (method === "DELETE" && existing) {
          existing.count -= 1;
          existing.isCurrentUserEngaged = false;
        }
        return json({ type: reaction });
      }
      if (method === "GET") return json(commentJson(comment));
      if (method === "PATCH") {
        comment.text = (JSON.parse(request.body ?? "{}") as { text: string }).text;
        comment.modifiedDate = "2026-10-25T13:00:00Z";
        return json(commentJson(comment));
      }
      if (method === "DELETE") {
        comment.isDeleted = true;
        return { status: 204 };
      }
    }

    if (method === "GET" && path === "/_apis/teams") return json({ value: [] });
    if (method === "GET" && path === "/_apis/git/repositories") {
      return json({ value: [{ id: "repo-1", project: { id: PROJECT_ID } }] });
    }
    if (method === "GET" && path === "/_apis/git/pullrequests") {
      const reviewer = query.get("searchCriteria.reviewerId");
      return json({ value: reviewer === VIEWER ? [pullRequest] : [] });
    }
    if (method === "GET" && path === `/_apis/git/pullrequests/${pullRequest.pullRequestId}`) return json(pullRequest);
    const details = new RegExp(`^/${PROJECT_ID}/_apis/git/repositories/repo-1/pullRequests/12/(threads|iterations)$`).exec(path);
    if (details && method === "GET") {
      return json({
        value:
          details[1] === "threads"
            ? [
                {
                  id: 3,
                  publishedDate: "2026-10-02T10:00:00Z",
                  comments: [
                    { id: 1, author: alba, commentType: "text", publishedDate: "2026-10-02T10:00:00Z", content: `@<${VIEWER}> ready` },
                  ],
                },
              ]
            : query.get("includeCommits") === "true"
              ? iterations
              : iterations.map(({ commits: _commits, ...iteration }) => iteration),
      });
    }
    // An iteration's changes, a page at a time: 100 unless `$top` says, at most 2,000.
    const iterationChanges = new RegExp(
      `^/${PROJECT_ID}/_apis/git/repositories/repo-1/pullRequests/12/iterations/(\\d+)/changes$`,
    ).exec(path);
    if (iterationChanges && method === "GET") {
      const entries = changes.get(Number(iterationChanges[1]));
      if (!entries) return json({ message: "TF401178: The requested pull request iteration was not found." }, 404);
      if ((query.get("$compareTo") ?? "0") !== "0") return json({ message: "No fixture compares two iterations." }, 400);
      const top = Math.min(Number(query.get("$top") ?? 100), 2000);
      const skip = Number(query.get("$skip") ?? 0);
      const more = skip + top < entries.length;
      return json({
        changeEntries: entries.slice(skip, skip + top),
        ...(more ? { nextSkip: skip + top, nextTop: top } : {}),
      });
    }
    // A file at a commit, raw.
    const itemRoute = /^\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/items$/.exec(path);
    if (itemRoute && method === "GET") {
      if (decodeURIComponent(itemRoute[1]!) !== PROJECT || decodeURIComponent(itemRoute[2]!) !== "api") {
        return json(
          {
            message: `TF401019: The Git repository with name or identifier ${decodeURIComponent(itemRoute[2]!)} does not exist or you do not have permissions for the operation you are attempting.`,
            typeKey: "GitRepositoryNotFoundException",
          },
          404,
        );
      }
      if (query.get("versionDescriptor.versionType") !== "commit") return json({ message: "No fixture reads a branch." }, 400);
      const itemPath = query.get("path") ?? "";
      const version = query.get("versionDescriptor.version") ?? "";
      const text = files.get(`${version}:${itemPath.replace(/^\//, "")}`);
      if (text === undefined) {
        return json(
          {
            message: `TF401174: The item '${itemPath}' could not be found in the repository 'api' at the version specified by '<Commit: ${version}>'.`,
            typeKey: "GitItemNotFoundException",
          },
          404,
        );
      }
      return { status: 200, headers: { "content-type": "application/octet-stream" }, body: text };
    }
    if (method === "GET" && path === `/${PROJECT_ID}/_apis/policy/evaluations`) {
      return json({ value: [{ status: "approved", configuration: { type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" } } }] });
    }
    return json({ message: `No fixture answers ${method} ${path}.` }, 404);
  }

  return { items, comments, pullRequest, files, iterations, changes, push, answer };
}

export type AzureFixture = ReturnType<typeof createAzureFixture>;
