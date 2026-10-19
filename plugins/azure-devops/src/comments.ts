import {
  createAuthHeader,
  getProjectName,
  parseAzureWorkItemId,
  requestAzureDevOps,
  type AzureDevOpsConnectionInput,
  type AzureWorkItem,
} from "./azure-devops.js";
import type {
  BacklogComment,
  BacklogCommentFact,
  BacklogDeleteItemCommentRequest,
  BacklogEditItemCommentRequest,
  BacklogItemCommentFacts,
  BacklogListItemCommentsRequest,
  BacklogListItemCommentsResult,
  BacklogPerson,
  BacklogPostItemCommentRequest,
  BacklogPostItemCommentResult,
  BacklogReaction,
  BacklogSearchItemPeopleRequest,
  BacklogSearchItemPeopleResult,
  BacklogSetItemCommentReactionRequest,
  BacklogSetItemCommentReactionResult,
  ConnectorSyncWorkItem,
} from "./contract.js";
import { decodeHtmlEntities, htmlToMarkdown } from "./html-markdown.js";

/**
 * An item's comments for Ajour's item page (Ajour's ADR 0008). Ajour asks for
 * the newest page and then earlier ones; Azure DevOps pages newest first, so
 * each page is reversed to read oldest first.
 */

const COMMENTS_API_VERSION = "7.1-preview.4";

/** Azure DevOps reaction types, in Ajour's names. */
const REACTIONS: Record<string, BacklogReaction> = {
  like: "like",
  dislike: "dislike",
  heart: "heart",
  hooray: "hooray",
  smile: "laugh",
  confused: "confused",
};

interface AzureIdentity {
  id?: string;
  displayName?: string;
  uniqueName?: string;
}

interface AzureComment {
  id: number;
  text?: string;
  renderedText?: string;
  /** "markdown" or "html"; some responses send 0 for Markdown and 1 for HTML. */
  format?: string | number;
  createdBy?: AzureIdentity;
  createdDate?: string;
  modifiedDate?: string;
  isDeleted?: boolean;
  reactions?: { type?: string; count?: number; isCurrentUserEngaged?: boolean }[];
}

interface AzureCommentList {
  totalCount?: number;
  count?: number;
  continuationToken?: string;
  comments?: AzureComment[];
}

interface AzureConnectionData {
  authenticatedUser?: {
    id?: string;
    providerDisplayName?: string;
    customDisplayName?: string;
  };
}

// An HTML mention: <a href="#" data-vss-mention="version:2.0,{id}">@Name</a>
const HTML_MENTION =
  /<a\b[^>]*\bdata-vss-mention="version:[\d.]+,([0-9a-fA-F-]{36})"[^>]*>([\s\S]*?)<\/a>/g;
// A Markdown comment mentions as @<id>.
const MARKDOWN_MENTION = /@<([0-9a-fA-F-]{36})>/g;

function isMarkdown(format: AzureComment["format"]) {
  return format === "markdown" || format === 0 || format === "0";
}

function mentionLink(name: string, id: string) {
  const label = name.replace(/^@/, "").replace(/[[\]]/g, "").trim() || "someone";
  return `[@${label}](mention:${id.toLowerCase()})`;
}

/** The people an HTML text mentions, by identity id. */
export function mentionNames(html: string | undefined) {
  const names = new Map<string, string>();
  for (const match of (html ?? "").matchAll(HTML_MENTION)) {
    const text = decodeHtmlEntities(match[2]!.replace(/<[^>]*>/g, "")).trim();
    names.set(match[1]!.toLowerCase(), text);
  }
  return names;
}

/**
 * A comment's text as Markdown. HTML goes through the description converter,
 * Markdown stays as written, and mentions become `[@Name](mention:<id>)`.
 */
export function commentBodyToMarkdown(comment: AzureComment) {
  if (isMarkdown(comment.format)) {
    // The rendered HTML names the people the Markdown mentions by id.
    const names = mentionNames(comment.renderedText);
    return (comment.text ?? "").replace(MARKDOWN_MENTION, (_match, id: string) =>
      mentionLink(names.get(id.toLowerCase()) ?? "someone", id),
    );
  }

  // Swap mentions for markers the converter keeps, then put links back.
  const mentions: string[] = [];
  const html = (comment.text ?? "").replace(HTML_MENTION, (_match, id: string, inner: string) => {
    const name = decodeHtmlEntities(inner.replace(/<[^>]*>/g, ""));
    mentions.push(mentionLink(name, id));
    return `AJOURMENTION${mentions.length - 1}X`;
  });
  const markdown = htmlToMarkdown(html) ?? "";
  return markdown.replace(/AJOURMENTION(\d+)X/g, (_match, index: string) => mentions[Number(index)] ?? "");
}

function person(identity: AzureIdentity | undefined): BacklogPerson {
  return {
    id: identity?.id?.toLowerCase() ?? "unknown",
    displayName: identity?.displayName?.trim() || identity?.uniqueName?.trim() || "Someone",
  };
}

export function toBacklogComment(comment: AzureComment): BacklogComment {
  const reactions = (comment.reactions ?? []).flatMap((reaction) => {
    const name = reaction.type ? REACTIONS[reaction.type.toLowerCase()] : undefined;
    return name && (reaction.count ?? 0) > 0
      ? [
          {
            reaction: name,
            count: reaction.count ?? 0,
            viewerReacted: Boolean(reaction.isCurrentUserEngaged),
          },
        ]
      : [];
  });
  const createdAt = comment.createdDate ?? new Date(0).toISOString();
  return {
    id: String(comment.id),
    author: person(comment.createdBy),
    body: commentBodyToMarkdown(comment),
    createdAt,
    ...(comment.modifiedDate && comment.modifiedDate !== createdAt
      ? { updatedAt: comment.modifiedDate }
      : {}),
    ...(reactions.length > 0 ? { reactions } : {}),
  };
}

async function fetchViewer(
  config: AzureDevOpsConnectionInput,
  init?: RequestInit,
): Promise<BacklogPerson> {
  const data = await requestAzureDevOps<AzureConnectionData>(
    config,
    "/_apis/connectionData",
    init,
  );
  const user = data.authenticatedUser;
  if (!user?.id) {
    throw new Error("Azure DevOps did not name the token's account. Check the organization URL.");
  }
  return {
    id: user.id.toLowerCase(),
    displayName: (user.customDisplayName || user.providerDisplayName || "").trim(),
  };
}

async function fetchProjectName(config: AzureDevOpsConnectionInput, id: number) {
  const workItem = await requestAzureDevOps<AzureWorkItem>(
    config,
    `/_apis/wit/workitems/${id}?fields=System.TeamProject&api-version=7.1`,
  );
  const project = getProjectName(workItem);
  if (!project) {
    throw new Error("Azure DevOps did not return the work item's project.");
  }
  return project;
}

function requireWorkItemId(config: AzureDevOpsConnectionInput, sourceId: string) {
  const id = parseAzureWorkItemId(sourceId, config.organizationUrl);
  if (id === null) {
    throw new Error(`"${sourceId}" is not an Azure DevOps work item.`);
  }
  return id;
}

// Ajour writes a mention as [@Name](mention:<id>); a Markdown comment takes @<id>.
const AJOUR_MENTION = /\[@[^\]]*\]\(mention:([0-9a-fA-F-]{36})\)/g;

/** Ajour's Markdown as an Azure DevOps Markdown comment. */
export function toAzureMarkdown(body: string) {
  return body.replace(AJOUR_MENTION, (_match, id: string) => `@<${id}>`);
}

/** A page of the item's comments: the newest `limit` before the cursor, oldest first. */
export async function listAzureItemComments(
  config: AzureDevOpsConnectionInput,
  request: BacklogListItemCommentsRequest,
): Promise<BacklogListItemCommentsResult> {
  const id = requireWorkItemId(config, request.sourceId);
  const [viewer, project] = await Promise.all([
    fetchViewer(config),
    fetchProjectName(config, id),
  ]);
  const params = new URLSearchParams({
    $top: String(request.limit),
    order: "desc",
    $expand: "renderedText,reactions",
    "api-version": COMMENTS_API_VERSION,
  });
  if (request.cursor) params.set("continuationToken", request.cursor);
  const page = await requestAzureDevOps<AzureCommentList>(
    config,
    `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?${params}`,
  );
  const comments = (page.comments ?? [])
    .filter((comment) => !comment.isDeleted)
    .map(toBacklogComment)
    .reverse();
  return {
    viewer,
    comments,
    ...(typeof page.totalCount === "number" ? { total: page.totalCount } : {}),
    ...(page.continuationToken ? { earlierCursor: page.continuationToken } : {}),
  };
}

/**
 * Posts a Markdown comment at once (Ajour's ADR 0008). Markdown keeps Ajour's
 * text as written; mentions go as Azure DevOps @<id> mentions, which notify.
 */
export async function postAzureItemComment(
  config: AzureDevOpsConnectionInput,
  request: BacklogPostItemCommentRequest,
): Promise<BacklogPostItemCommentResult> {
  const id = requireWorkItemId(config, request.sourceId);
  const body = request.body.trim();
  if (!body) {
    throw new Error("A comment needs some text.");
  }
  const project = await fetchProjectName(config, id);
  const params = new URLSearchParams({
    format: "markdown",
    "api-version": COMMENTS_API_VERSION,
  });
  const created = await requestAzureDevOps<AzureComment>(
    config,
    `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?${params}`,
    { method: "POST", body: JSON.stringify({ text: toAzureMarkdown(body) }) },
  );
  // The comment reads back as Ajour wrote it, with its mentions named.
  return { comment: { ...toBacklogComment(created), body } };
}

/** Ajour's reaction names, as Azure DevOps reaction types. */
const AZURE_REACTIONS = Object.fromEntries(
  Object.entries(REACTIONS).map(([azure, ajour]) => [ajour, azure]),
) as Partial<Record<BacklogReaction, string>>;

function requireCommentId(commentId: string) {
  if (!/^\d+$/.test(commentId)) {
    throw new Error(`"${commentId}" is not an Azure DevOps comment.`);
  }
  return commentId;
}

async function commentPath(
  config: AzureDevOpsConnectionInput,
  request: { sourceId: string; commentId: string },
) {
  const id = requireWorkItemId(config, request.sourceId);
  const project = await fetchProjectName(config, id);
  return `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments/${requireCommentId(request.commentId)}`;
}

/** Edits one of the user's comments at once, as Markdown. */
export async function editAzureItemComment(
  config: AzureDevOpsConnectionInput,
  request: BacklogEditItemCommentRequest,
): Promise<BacklogPostItemCommentResult> {
  const body = request.body.trim();
  if (!body) {
    throw new Error("A comment needs some text.");
  }
  const params = new URLSearchParams({
    format: "markdown",
    "api-version": COMMENTS_API_VERSION,
  });
  const updated = await requestAzureDevOps<AzureComment>(
    config,
    `${await commentPath(config, request)}?${params}`,
    { method: "PATCH", body: JSON.stringify({ text: toAzureMarkdown(body) }) },
  );
  return { comment: { ...toBacklogComment(updated), body } };
}

/** Deletes one of the user's comments. Ajour sends it after its Undo window. */
export async function deleteAzureItemComment(
  config: AzureDevOpsConnectionInput,
  request: BacklogDeleteItemCommentRequest,
): Promise<Record<string, never>> {
  await requestAzureDevOps<unknown>(
    config,
    `${await commentPath(config, request)}?api-version=${COMMENTS_API_VERSION}`,
    { method: "DELETE" },
  );
  return {};
}

/** Adds or removes the user's reaction, then returns the comment's reactions. */
export async function setAzureItemCommentReaction(
  config: AzureDevOpsConnectionInput,
  request: BacklogSetItemCommentReactionRequest,
): Promise<BacklogSetItemCommentReactionResult> {
  const type = AZURE_REACTIONS[request.reaction];
  if (!type) {
    throw new Error(`Azure DevOps has no "${request.reaction}" reaction.`);
  }
  const path = await commentPath(config, request);
  await requestAzureDevOps<unknown>(
    config,
    `${path}/reactions/${type}?api-version=7.1-preview.1`,
    { method: request.reacted ? "PUT" : "DELETE" },
  );
  const comment = await requestAzureDevOps<AzureComment>(
    config,
    `${path}?$expand=reactions&api-version=${COMMENTS_API_VERSION}`,
  );
  return { reactions: toBacklogComment(comment).reactions ?? [] };
}

interface AzureIdentity2 {
  id?: string;
  providerDisplayName?: string;
  customDisplayName?: string;
  isActive?: boolean;
  isContainer?: boolean;
  properties?: Record<string, { $value?: unknown } | undefined>;
}

/** An account name that is an email, as Azure DevOps names most users. */
function emailOf(...candidates: unknown[]) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && /^[^\s@]+@[^\s@]+$/.test(candidate.trim())) {
      return candidate.trim();
    }
  }
  return undefined;
}

/** A person for the @ suggestions, with their email when there is one. */
function suggestion(identity: AzureIdentity): BacklogPerson {
  const email = emailOf(identity.uniqueName);
  return { ...person(identity), ...(email ? { email } : {}) };
}

/**
 * Where identities live: vssps.dev.azure.com/{org} for dev.azure.com,
 * {org}.vssps.visualstudio.com for the older hosts, and the collection
 * itself for Azure DevOps Server.
 */
export function identitiesBaseUrl(organizationUrl: string) {
  const url = new URL(organizationUrl.replace(/\/+$/, ""));
  if (url.hostname === "dev.azure.com") {
    return `https://vssps.dev.azure.com${url.pathname}`;
  }
  const legacy = /^([^.]+)\.visualstudio\.com$/.exec(url.hostname);
  if (legacy) {
    return `https://${legacy[1]}.vssps.visualstudio.com`;
  }
  return `${url.origin}${url.pathname}`;
}

/** The item's fields that name a person. */
const PEOPLE_FIELDS = ["System.AssignedTo", "System.CreatedBy", "System.ChangedBy"];
/** How many of the item's newest comments name their authors as suggestions. */
const PEOPLE_COMMENT_PAGE = 100;
/** How long each request of a people search may take, so one stuck request
 * doesn't hold back what the others found. */
const PEOPLE_REQUEST_TIMEOUT_MS = 4_000;

/** Lowercase words without accents, so "Zoé" matches "zoe". */
function nameWords(text: string) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[\s.,;:()[\]<>@\/_-]+/)
    .filter(Boolean);
}

/** Whether every word of the query starts a word of the person's name or account. */
function matchesQuery(identity: AzureIdentity, query: string[]) {
  const words = nameWords(`${identity.displayName ?? ""} ${identity.uniqueName ?? ""}`);
  return query.every((part) => words.some((word) => word.startsWith(part)));
}

/**
 * The people on the item: who it is assigned to, who created and last changed
 * it, and who commented on it lately. They match any part of their name, so a
 * last name finds them too.
 */
async function fetchItemPeople(
  config: AzureDevOpsConnectionInput,
  id: number,
  timeoutMs: number,
) {
  const workItem = await requestAzureDevOps<AzureWorkItem>(
    config,
    `/_apis/wit/workitems/${id}?fields=System.TeamProject,${PEOPLE_FIELDS.join(",")}&api-version=7.1`,
    { signal: AbortSignal.timeout(timeoutMs) },
  );
  const project = getProjectName(workItem);
  const people = PEOPLE_FIELDS.map((field) => workItem.fields?.[field] as AzureIdentity | undefined);
  if (project) {
    const params = new URLSearchParams({
      $top: String(PEOPLE_COMMENT_PAGE),
      order: "desc",
      "api-version": COMMENTS_API_VERSION,
    });
    // The fields' people still count when the comments fail.
    const page = await requestAzureDevOps<AzureCommentList>(
      config,
      `/${encodeURIComponent(project)}/_apis/wit/workItems/${id}/comments?${params}`,
      { signal: AbortSignal.timeout(timeoutMs) },
    ).catch((): AzureCommentList => ({}));
    people.push(...(page.comments ?? []).map((comment) => comment.createdBy));
  }
  return people.filter(
    (identity): identity is AzureIdentity =>
      typeof identity === "object" && identity !== null && Boolean(identity.id),
  );
}

/**
 * The organization's users whose name starts like the query, without groups
 * or inactive accounts. Azure DevOps decides how much of a name matches.
 */
async function searchOrganizationPeople(
  config: AzureDevOpsConnectionInput,
  query: string,
  timeoutMs: number,
) {
  const url = new URL(`${identitiesBaseUrl(config.organizationUrl)}/_apis/identities`);
  url.searchParams.set("searchFilter", "General");
  url.searchParams.set("filterValue", query);
  url.searchParams.set("queryMembership", "None");
  url.searchParams.set("api-version", "7.1");

  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        Authorization: createAuthHeader(config.personalAccessToken),
      },
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(
      `Azure DevOps request failed: ${error instanceof Error ? error.message : "Network error"}`,
    );
  }
  if (!response.ok) {
    throw new Error(`Azure DevOps request failed (${response.status}): people search`);
  }
  const data = (await response.json()) as { value?: AzureIdentity2[] };
  return (data.value ?? [])
    .filter((identity) => identity.id && identity.isActive !== false && !identity.isContainer)
    .map((identity): BacklogPerson => {
      const email = emailOf(
        identity.properties?.Mail?.$value,
        identity.properties?.Account?.$value,
      );
      return {
        id: identity.id!.toLowerCase(),
        displayName: (identity.customDisplayName || identity.providerDisplayName || "").trim(),
        ...(email ? { email } : {}),
      };
    })
    .filter((person) => person.displayName);
}

/**
 * People for the editor's @ suggestions. Azure DevOps has no list of people
 * allowed on one work item, so the people on the item come first, matched by
 * any part of their name, then the organization's users. A bare @ asks with
 * no query and gets only the item's people. Either search may fail or run
 * out of time, such as when the token can't read identities; only both
 * failing fails.
 */
export async function searchAzureItemPeople(
  config: AzureDevOpsConnectionInput,
  request: BacklogSearchItemPeopleRequest,
  /** Tests pass a shorter one. */
  timeoutMs = PEOPLE_REQUEST_TIMEOUT_MS,
): Promise<BacklogSearchItemPeopleResult> {
  const id = requireWorkItemId(config, request.sourceId);
  const query = request.query.trim().replace(/\s+/g, " ");
  const queryWords = nameWords(query);
  if (query && queryWords.length === 0) return { people: [] };

  const [onItem, inOrganization] = await Promise.allSettled([
    fetchItemPeople(config, id, timeoutMs),
    query ? searchOrganizationPeople(config, query, timeoutMs) : Promise.resolve([]),
  ]);
  if (!query && onItem.status === "rejected") throw onItem.reason;
  if (onItem.status === "rejected" && inOrganization.status === "rejected") {
    throw inOrganization.reason;
  }
  const found = [
    ...(onItem.status === "fulfilled"
      ? onItem.value.filter((identity) => matchesQuery(identity, queryWords)).map(suggestion)
      : []),
    ...(inOrganization.status === "fulfilled" ? inOrganization.value : []),
  ];
  const seen = new Set<string>();
  const people = found.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
  return { people: people.slice(0, request.limit) };
}

/** How many of a settled item's newest comments a sync reads. */
const SETTLED_COMMENT_PAGE = 20;
/** Settled items whose comments are read at the same time. */
const SETTLED_COMMENT_CONCURRENCY = 5;

/**
 * How long a sync spends on comments. Ajour gives the whole sync 30 seconds,
 * and the rest of it has already run, so this stays well within it.
 */
export interface CommentFactsLimits {
  budgetMs: number;
  requestTimeoutMs: number;
  /** Picks where the older items start; tests pass a fixed one. */
  random?: () => number;
}
const COMMENT_FACTS_LIMITS: CommentFactsLimits = {
  budgetMs: 10_000,
  requestTimeoutMs: 4_000,
};

/**
 * The order a sync reads settled items in: most recently settled first, from
 * a random point each sync, so no item keeps losing the budget to the same
 * others. Within a batch, items changed since their settle still go first.
 */
export function commentFactsOrder<Entry extends { since: number }>(
  entries: readonly Entry[],
  random: () => number = Math.random,
): Entry[] {
  const byRecency = [...entries].sort((left, right) => right.since - left.since);
  const start = Math.floor(random() * byRecency.length);
  return [...byRecency.slice(start), ...byRecency.slice(0, start)];
}

/** The most work items one batch request names. */
const WORK_ITEM_BATCH_SIZE = 200;

/** The project of each work item, and when it last changed, in one request. */
async function fetchSettledDetails(
  config: AzureDevOpsConnectionInput,
  ids: number[],
  signal: AbortSignal,
) {
  const details = new Map<number, { project: string; changedAt?: number }>();
  const batch = await requestAzureDevOps<{ value?: (AzureWorkItem | null)[] }>(
    config,
    "/_apis/wit/workitemsbatch?api-version=7.1",
    {
      method: "POST",
      body: JSON.stringify({
        ids,
        fields: ["System.TeamProject", "System.ChangedDate"],
        errorPolicy: "omit",
      }),
      signal,
    },
  );
  for (const workItem of batch.value ?? []) {
    const project = workItem ? getProjectName(workItem) : undefined;
    if (!workItem || !project) continue;
    const changed = workItem.fields?.["System.ChangedDate"];
    const changedAt = typeof changed === "string" ? Date.parse(changed) : NaN;
    details.set(workItem.id, {
      project,
      ...(Number.isFinite(changedAt) ? { changedAt } : {}),
    });
  }
  return details;
}

/**
 * The comments posted on settled items since they were settled, without their
 * text, so Ajour can return an item someone else commented on (its ADR 0008).
 *
 * Best effort, within a time budget: an item whose comments fail or don't fit
 * is skipped, and the sync goes on with what was found. Ajour asks again at
 * the next sync. Items go 200 at a time in `commentFactsOrder`, each batch's
 * projects then its comments, so a large backlog still gets its comments
 * read. A comment changes its work item, so within a batch the items changed
 * since their settle are read first.
 */
export async function findAzureCommentFacts(
  config: AzureDevOpsConnectionInput,
  workItems: ConnectorSyncWorkItem[],
  limits: CommentFactsLimits = COMMENT_FACTS_LIMITS,
): Promise<{ viewer?: BacklogPerson; commentFacts: BacklogItemCommentFacts[] }> {
  const settled = commentFactsOrder(
    workItems.flatMap((workItem) => {
      const since = workItem.commentsSince ? Date.parse(workItem.commentsSince) : NaN;
      const id = parseAzureWorkItemId(workItem.sourceId, config.organizationUrl);
      return Number.isFinite(since) && id !== null
        ? [{ localWorkItemId: workItem.localWorkItemId, id, since }]
        : [];
    }),
    limits.random,
  );
  if (settled.length === 0) return { commentFacts: [] };

  const deadline = Date.now() + limits.budgetMs;
  const signal = () =>
    AbortSignal.timeout(
      Math.max(1, Math.min(limits.requestTimeoutMs, deadline - Date.now())),
    );

  let viewer: BacklogPerson;
  try {
    viewer = await fetchViewer(config, { signal: signal() });
  } catch {
    return { commentFacts: [] };
  }

  const params = new URLSearchParams({
    $top: String(SETTLED_COMMENT_PAGE),
    order: "desc",
    "api-version": COMMENTS_API_VERSION,
  });
  const readComments = async (
    entry: (typeof settled)[number],
    project: string,
  ): Promise<BacklogItemCommentFacts | null> => {
    try {
      const page = await requestAzureDevOps<AzureCommentList>(
        config,
        `/${encodeURIComponent(project)}/_apis/wit/workItems/${entry.id}/comments?${params}`,
        { signal: signal() },
      );
      const comments = (page.comments ?? []).flatMap((comment): BacklogCommentFact[] =>
        !comment.isDeleted &&
        comment.createdDate &&
        Date.parse(comment.createdDate) > entry.since
          ? [
              {
                id: String(comment.id),
                author: person(comment.createdBy),
                createdAt: comment.createdDate,
                // Both formats name a mentioned person by identity id.
                ...((comment.text ?? "").toLowerCase().includes(viewer.id)
                  ? { mentionsViewer: true }
                  : {}),
              },
            ]
          : [],
      );
      return comments.length > 0 ? { localWorkItemId: entry.localWorkItemId, comments } : null;
    } catch {
      return null;
    }
  };

  const commentFacts: BacklogItemCommentFacts[] = [];
  for (let start = 0; start < settled.length; start += WORK_ITEM_BATCH_SIZE) {
    if (Date.now() >= deadline) break;
    const batch = settled.slice(start, start + WORK_ITEM_BATCH_SIZE);
    let details: Awaited<ReturnType<typeof fetchSettledDetails>>;
    try {
      details = await fetchSettledDetails(
        config,
        batch.map((entry) => entry.id),
        signal(),
      );
    } catch {
      continue;
    }
    const changedSinceSettle = (entry: (typeof settled)[number]) => {
      const changedAt = details.get(entry.id)?.changedAt;
      return changedAt === undefined || changedAt > entry.since;
    };
    const ordered = batch
      .filter((entry) => details.has(entry.id))
      .sort(
        (left, right) =>
          Number(changedSinceSettle(right)) - Number(changedSinceSettle(left)),
      );
    for (let group = 0; group < ordered.length; group += SETTLED_COMMENT_CONCURRENCY) {
      if (Date.now() >= deadline) break;
      const found = await Promise.all(
        ordered
          .slice(group, group + SETTLED_COMMENT_CONCURRENCY)
          .map((entry) => readComments(entry, details.get(entry.id)!.project)),
      );
      for (const facts of found) {
        if (facts) commentFacts.push(facts);
      }
    }
  }
  return { viewer, commentFacts };
}
