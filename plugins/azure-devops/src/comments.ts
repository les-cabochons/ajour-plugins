import {
  getProjectName,
  parseAzureWorkItemId,
  requestAzureDevOps,
  type AzureDevOpsConnectionInput,
  type AzureWorkItem,
} from "./azure-devops.js";
import type {
  BacklogComment,
  BacklogListItemCommentsRequest,
  BacklogListItemCommentsResult,
  BacklogPerson,
  BacklogPostItemCommentRequest,
  BacklogPostItemCommentResult,
  BacklogReaction,
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

async function fetchViewer(config: AzureDevOpsConnectionInput): Promise<BacklogPerson> {
  const data = await requestAzureDevOps<AzureConnectionData>(config, "/_apis/connectionData");
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
