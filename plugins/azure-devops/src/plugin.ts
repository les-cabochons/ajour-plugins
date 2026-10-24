import type {
  BacklogReadDescriptionRequest,
  BacklogWriteDescriptionRequest,
  BacklogSearchItemPeopleRequest,
  BacklogDeleteItemCommentRequest,
  BacklogEditItemCommentRequest,
  BacklogSetItemCommentReactionRequest,
  BacklogListItemCommentsRequest,
  BacklogListItemCommentsResult,
  BacklogPostItemCommentRequest,
  BacklogPostItemCommentResult,
  CodeHostSyncRequest,
  CodeHostSyncResult,
  ConnectorFieldValues,
  ConnectorValidationContext,
  ConnectorPriorityLevel,
  ConnectorPluginConnection,
  ConnectorSettleStatesRequest,
  ConnectorSettleWriteRequest,
  ConnectorSyncWorkItem,
} from "./contract.js";
import { parseConnectorFieldValues } from "./contract.js";
import {
  syncAzureDevOpsConnection,
  type AzureDevOpsConnectionInput,
  validateAzureDevOpsConnection,
} from "./azure-devops.js";
import { listAzureSettleStates, writeAzureSettle } from "./settle.js";
import { readAzureDescription } from "./description-source.js";
import { writeAzureDescription } from "./description-write.js";
import {
  deleteAzureItemComment,
  editAzureItemComment,
  findAzureCommentFacts,
  listAzureItemComments,
  postAzureItemComment,
  searchAzureItemPeople,
  setAzureItemCommentReaction,
} from "./comments.js";
import { buildPullRequestConfig, formatScopes } from "./pull-request-config.js";
import {
  AzureReposClient,
  fetchViewer,
  syncPullRequests as syncAzurePullRequests,
} from "./pull-requests.js";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  PRIORITY_LEVEL_FIELD_IDS,
  PRIORITY_LEVELS,
  parsePriorityLevelRanges,
} from "./priority-levels.js";

const TASK_ICON_DISPLAY_MODES = new Set(["always", "fallback", "never"]);

/**
 * Each level's trimmed text. A connection saved before these fields existed
 * gets the defaults; an empty text means the level has no values.
 */
function readPriorityLevelTexts(values: ConnectorFieldValues) {
  return Object.fromEntries(
    PRIORITY_LEVELS.map((level) => {
      const fieldId = PRIORITY_LEVEL_FIELD_IDS[level];
      const value = values[fieldId];
      if (value === undefined) {
        return [level, DEFAULT_PRIORITY_LEVEL_VALUES[level]];
      }
      if (typeof value !== "string") {
        throw new Error(`Azure DevOps field "${fieldId}" must be text.`);
      }
      return [level, value.trim()];
    }),
  ) as Record<ConnectorPriorityLevel, string>;
}

function buildAzureConfig(values: ConnectorFieldValues, connection?: { id: string; label: string; tenantLabel: string }): AzureDevOpsConnectionInput {
  const parsed = parseConnectorFieldValues(values);

  if (typeof parsed.organizationUrl !== "string" || !parsed.organizationUrl.trim()) {
    throw new Error('Azure DevOps field "organizationUrl" is required.');
  }

  if (typeof parsed.personalAccessToken !== "string" || !parsed.personalAccessToken.trim()) {
    throw new Error('Azure DevOps field "personalAccessToken" is required.');
  }

  if (parsed.queryScope !== "assigned_to_me" && parsed.queryScope !== "project_open_tasks") {
    throw new Error('Azure DevOps field "queryScope" is invalid.');
  }

  const priorityLevels = parsePriorityLevelRanges(readPriorityLevelTexts(parsed));

  return {
    id: connection?.id,
    label: connection?.label ?? "Azure DevOps",
    tenantLabel: connection?.tenantLabel ?? "Default tenant",
    organizationUrl: parsed.organizationUrl,
    personalAccessToken: parsed.personalAccessToken,
    queryScope: parsed.queryScope,
    priorityFieldName:
      typeof parsed.priorityFieldName === "string" && parsed.priorityFieldName.trim()
        ? parsed.priorityFieldName.trim()
        : undefined,
    priorityLevels,
    originalEstimateFieldName:
      typeof parsed.originalEstimateFieldName === "string" && parsed.originalEstimateFieldName.trim()
        ? parsed.originalEstimateFieldName.trim()
        : undefined,
    remainingEstimateFieldName:
      typeof parsed.remainingEstimateFieldName === "string" && parsed.remainingEstimateFieldName.trim()
        ? parsed.remainingEstimateFieldName.trim()
        : undefined,
    completedEstimateFieldName:
      typeof parsed.completedEstimateFieldName === "string" && parsed.completedEstimateFieldName.trim()
        ? parsed.completedEstimateFieldName.trim()
        : undefined,
  };
}

/**
 * Checks the access of the capabilities that are on, and keeps the values of
 * the others. Ajour before per-capability switches sends no context: it only
 * ran work items for this plugin.
 */
export async function validateConnection(
  config: ConnectorFieldValues,
  context?: ConnectorValidationContext,
) {
  const parsed = parseConnectorFieldValues(config);
  const capabilities = context?.capabilities ?? ["connector"];
  const [pullRequestValues, otherValues] = splitFields(parsed, PULL_REQUEST_FIELD_IDS);
  // A capability that is off keeps its values as entered, unchecked.
  const workItems = capabilities.includes("connector")
    ? await validateWorkItems(parsed)
    : { normalizedConfig: otherValues, connectionSummary: {} };
  const pullRequests = capabilities.includes("codeHost")
    ? await validatePullRequests(parsed)
    : { normalizedConfig: pullRequestValues, connectionSummary: {} };

  return {
    // The shared organization URL and token keep the work items' form when
    // they are on, as before pull requests existed.
    normalizedConfig: capabilities.includes("connector")
      ? { ...pullRequests.normalizedConfig, ...workItems.normalizedConfig }
      : { ...workItems.normalizedConfig, ...pullRequests.normalizedConfig },
    connectionSummary: {
      ...workItems.connectionSummary,
      ...pullRequests.connectionSummary,
    },
  };
}

const PULL_REQUEST_FIELD_IDS = new Set([
  "pullRequestsInclude",
  "pullRequestsExclude",
  "hideDraftPullRequests",
  "includeTeamReviewRequests",
]);

function splitFields(values: ConnectorFieldValues, ids: ReadonlySet<string>) {
  const entries = Object.entries(values);
  return [
    Object.fromEntries(entries.filter(([id]) => ids.has(id))),
    Object.fromEntries(entries.filter(([id]) => !ids.has(id))),
  ] as const;
}

async function validatePullRequests(parsed: ConnectorFieldValues) {
  const config = buildPullRequestConfig(parsed);
  const client = new AzureReposClient(config.organizationUrl, config.token);
  const viewer = await fetchViewer(client);
  // connectionData answers any valid token. Listing repositories proves Code (Read).
  await client.checkCodeAccess();
  return {
    normalizedConfig: {
      organizationUrl: config.organizationUrl,
      personalAccessToken: config.token,
      pullRequestsInclude: formatScopes(config.include),
      pullRequestsExclude: formatScopes(config.exclude),
      hideDraftPullRequests: config.hideDrafts,
      includeTeamReviewRequests: config.includeTeamRequests,
    } satisfies ConnectorFieldValues,
    connectionSummary: { account: viewer.user.login },
  };
}

async function validateWorkItems(parsed: ConnectorFieldValues) {
  const azureConfig = buildAzureConfig(parsed);
  const validation = await validateAzureDevOpsConnection(azureConfig);

  const normalizedConfig: ConnectorFieldValues = {
    organizationUrl: azureConfig.organizationUrl.replace(/\/+$/, ""),
    personalAccessToken: azureConfig.personalAccessToken,
    queryScope: azureConfig.queryScope,
  };

  if (
    typeof parsed.taskIconDisplayMode === "string" &&
    TASK_ICON_DISPLAY_MODES.has(parsed.taskIconDisplayMode)
  ) {
    normalizedConfig.taskIconDisplayMode = parsed.taskIconDisplayMode;
  }

  if (azureConfig.priorityFieldName) {
    normalizedConfig.priorityFieldName = azureConfig.priorityFieldName;
  }
  // Kept even when empty, so a cleared level stays cleared.
  const priorityLevelTexts = readPriorityLevelTexts(parsed);
  for (const level of PRIORITY_LEVELS) {
    normalizedConfig[PRIORITY_LEVEL_FIELD_IDS[level]] = priorityLevelTexts[level];
  }
  if (azureConfig.originalEstimateFieldName) {
    normalizedConfig.originalEstimateFieldName = azureConfig.originalEstimateFieldName;
  }
  if (azureConfig.remainingEstimateFieldName) {
    normalizedConfig.remainingEstimateFieldName = azureConfig.remainingEstimateFieldName;
  }
  if (azureConfig.completedEstimateFieldName) {
    normalizedConfig.completedEstimateFieldName = azureConfig.completedEstimateFieldName;
  }

  const connectionSummary: Record<string, string | boolean> = {
    organizationUrl: azureConfig.organizationUrl.replace(/\/+$/, ""),
    scope: azureConfig.queryScope === "assigned_to_me" ? "Assigned to me" : "Open tasks across organization",
  };

  if (validation.priorityField?.configuredName) {
    connectionSummary.priorityFieldName = validation.priorityField.configuredName;
  }
  if (validation.priorityField?.resolvedReferenceName) {
    connectionSummary.priorityFieldResolvedReferenceName = validation.priorityField.resolvedReferenceName;
  }
  if (validation.priorityField?.type) {
    connectionSummary.priorityFieldType = validation.priorityField.type;
  }
  if (typeof validation.priorityField?.isQueryable === "boolean") {
    connectionSummary.priorityFieldIsQueryable = validation.priorityField.isQueryable;
  }
  if (validation.originalEstimateField?.configuredName) {
    connectionSummary.originalEstimateFieldName = validation.originalEstimateField.configuredName;
  }
  if (validation.remainingEstimateField?.configuredName) {
    connectionSummary.remainingEstimateFieldName = validation.remainingEstimateField.configuredName;
  }
  if (validation.completedEstimateField?.configuredName) {
    connectionSummary.completedEstimateFieldName = validation.completedEstimateField.configuredName;
  }

  return {
    normalizedConfig,
    connectionSummary,
  };
}

export async function syncConnection(
  connection: ConnectorPluginConnection,
  workItems: ConnectorSyncWorkItem[] = [],
) {
  const azureConfig = buildAzureConfig(connection.config, connection);
  const result = await syncAzureDevOpsConnection(azureConfig, workItems);
  return { ...result, ...(await findAzureCommentFacts(azureConfig, workItems)) };
}

export async function listSettleStates(
  connection: ConnectorPluginConnection,
  request: ConnectorSettleStatesRequest,
) {
  return await listAzureSettleStates(buildAzureConfig(connection.config, connection), request.sourceId);
}

export async function writeSettle(
  connection: ConnectorPluginConnection,
  request: ConnectorSettleWriteRequest,
) {
  return await writeAzureSettle(buildAzureConfig(connection.config, connection), request);
}

/** A page of a work item's comments for Ajour's item page. */
export async function listItemComments(
  connection: ConnectorPluginConnection,
  request: BacklogListItemCommentsRequest,
): Promise<BacklogListItemCommentsResult> {
  return await listAzureItemComments(buildAzureConfig(connection.config, connection), request);
}

/** Posts a comment on a work item, as Markdown. */
export async function postItemComment(
  connection: ConnectorPluginConnection,
  request: BacklogPostItemCommentRequest,
): Promise<BacklogPostItemCommentResult> {
  return await postAzureItemComment(buildAzureConfig(connection.config, connection), request);
}

/** Edits one of the user's comments, as Markdown. */
export async function editItemComment(
  connection: ConnectorPluginConnection,
  request: BacklogEditItemCommentRequest,
) {
  return await editAzureItemComment(buildAzureConfig(connection.config, connection), request);
}

/** Deletes one of the user's comments. */
export async function deleteItemComment(
  connection: ConnectorPluginConnection,
  request: BacklogDeleteItemCommentRequest,
) {
  return await deleteAzureItemComment(buildAzureConfig(connection.config, connection), request);
}

/** Adds or removes the user's reaction on a comment. */
export async function setItemCommentReaction(
  connection: ConnectorPluginConnection,
  request: BacklogSetItemCommentReactionRequest,
) {
  return await setAzureItemCommentReaction(buildAzureConfig(connection.config, connection), request);
}

/** The item's current description, read when the user edits it in Ajour. */
export async function readDescription(
  connection: ConnectorPluginConnection,
  request: BacklogReadDescriptionRequest,
) {
  return await readAzureDescription(buildAzureConfig(connection.config, connection), request);
}

/** Writes the user's edit, unless the item's description changed since it was read. */
export async function writeDescription(
  connection: ConnectorPluginConnection,
  request: BacklogWriteDescriptionRequest,
) {
  return await writeAzureDescription(buildAzureConfig(connection.config, connection), request);
}

/** People to mention, for Ajour's @ suggestions. */
export async function searchItemPeople(
  connection: ConnectorPluginConnection,
  request: BacklogSearchItemPeopleRequest,
) {
  return await searchAzureItemPeople(buildAzureConfig(connection.config, connection), request);
}

export async function syncPullRequests(
  connection: ConnectorPluginConnection,
  request: CodeHostSyncRequest,
): Promise<CodeHostSyncResult> {
  return await syncAzurePullRequests(buildPullRequestConfig(connection.config), request.tracked);
}
