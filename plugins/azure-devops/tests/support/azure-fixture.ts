/*
 * A small Azure DevOps service for tests: one organization with a project,
 * work items and their comments, the viewer, an identity directory and one
 * pull request. It answers a request by its method, its path under the
 * organization (or collection) and its query, as the real service lays its
 * REST API out, and keeps what writes change, so a test can read it back.
 */

export const VIEWER = "11111111-1111-1111-1111-111111111111";
export const ALBA = "44444444-4444-4444-4444-444444444444";
export const PROJECT = "Mercury";
export const PROJECT_ID = "99999999-9999-9999-9999-999999999999";

export const ORIGINAL_ESTIMATE = "Microsoft.VSTS.Scheduling.OriginalEstimate";

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
  { name: "Priority", referenceName: "Microsoft.VSTS.Common.Priority", type: "integer", isQueryable: true },
];

const viewer = { id: VIEWER, displayName: "Ada Lovelace", uniqueName: "ada@contoso.com" };
const alba = { id: ALBA, displayName: "Alba Reyes", uniqueName: "alba@contoso.com" };

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
    lastMergeSourceCommit: { commitId: "abc123" },
    repository: { id: "repo-1", name: "api", project: { id: PROJECT_ID, name: PROJECT } },
  };
  let nextCommentId = 100;

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
            : [{ id: 1, createdDate: "2026-10-02T09:00:00Z", author: alba, sourceRefCommit: { commitId: "abc123" } }],
      });
    }
    if (method === "GET" && path === `/${PROJECT_ID}/_apis/policy/evaluations`) {
      return json({ value: [{ status: "approved", configuration: { type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" } } }] });
    }
    return json({ message: `No fixture answers ${method} ${path}.` }, 404);
  }

  return { items, comments, pullRequest, answer };
}

export type AzureFixture = ReturnType<typeof createAzureFixture>;
