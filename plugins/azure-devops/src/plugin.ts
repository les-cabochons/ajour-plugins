import type {} from "@ajour/plugin-sdk/globals";
import type { PluginConnection, PluginModule } from "@ajour/plugin-sdk";
import type { ConnectorFieldValues, ConnectorPriorityLevel } from "./contract.ts";
import { parseConnectorFieldValues } from "./contract.ts";
import {
  syncAzureDevOpsConnection,
  type AzureDevOpsConnectionInput,
  validateAzureDevOpsConnection,
} from "./azure-devops.ts";
import { listAzureSettleStates, writeAzureSettle } from "./settle.ts";
import { readAzureDescription } from "./description-source.ts";
import { writeAzureDescription } from "./description-write.ts";
import {
  deleteAzureItemComment,
  editAzureItemComment,
  findAzureCommentFacts,
  listAzureItemComments,
  postAzureItemComment,
  searchAzureItemPeople,
  setAzureItemCommentReaction,
} from "./comments.ts";
import { buildPullRequestConfig, formatScopes, organizationRootUrl } from "./pull-request-config.ts";
import {
  AzureReposClient,
  fetchViewer,
  syncPullRequests as syncAzurePullRequests,
} from "./pull-requests.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  PRIORITY_LEVEL_FIELD_IDS,
  PRIORITY_LEVELS,
  parsePriorityLevelRanges,
} from "./priority-levels.ts";

/*
 * The plugin's entrypoint, loaded as an ES module in Ajour's sandboxed worker
 * (plugin API 4). Each export is one operation. The connection an operation
 * receives holds no token: it stays with Ajour's broker, which attaches it as
 * Basic credentials to every `ajour.http` request. `connection.access` lists
 * the connection's access choices that are on.
 */

/** The access choice that unlocks the pull request operations and endpoints. */
const PULL_REQUESTS_ACCESS = "pullRequests";

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

/**
 * The settings of a connection Ajour hands to an operation. They hold no
 * token: that stays with Ajour's broker, which attaches it to each request.
 */
function buildAzureConfig(connection: PluginConnection): AzureDevOpsConnectionInput {
  const parsed = parseConnectorFieldValues(connection.config);

  if (typeof parsed.organizationUrl !== "string" || !parsed.organizationUrl.trim()) {
    throw new Error('Azure DevOps field "organizationUrl" is required.');
  }
  // The broker sends every request under the saved address, so it must name
  // the organization or collection, not a project.
  organizationRootUrl(parsed.organizationUrl);

  if (parsed.queryScope !== "assigned_to_me" && parsed.queryScope !== "project_open_tasks") {
    throw new Error('Azure DevOps field "queryScope" is invalid.');
  }

  const priorityLevels = parsePriorityLevelRanges(readPriorityLevelTexts(parsed));

  return {
    id: connection.id,
    label: connection.label,
    tenantLabel: connection.tenantLabel,
    organizationUrl: parsed.organizationUrl,
    access: connection.access,
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
export const validateConnection: NonNullable<PluginModule["validateConnection"]> = async (
  connection,
  context,
) => {
  const parsed = parseConnectorFieldValues(connection.config);
  const capabilities: readonly string[] = context?.capabilities ?? ["connector"];
  const [pullRequestValues, otherValues] = splitFields(parsed, PULL_REQUEST_FIELD_IDS);
  // A capability that is off keeps its values as entered, unchecked.
  const workItems = capabilities.includes("connector")
    ? await validateWorkItems(connection)
    : { normalizedConfig: otherValues, connectionSummary: {} };
  const pullRequests = capabilities.includes("codeHost")
    ? await validatePullRequests(connection)
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
};

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

async function validatePullRequests(connection: PluginConnection) {
  const config = buildPullRequestConfig(connection);
  const client = new AzureReposClient(config.connectionId);
  const viewer = await fetchViewer(client);
  // connectionData answers any valid token. Listing repositories proves Code
  // (Read), once the connection's access lets it read pull requests at all.
  if (connection.access.includes(PULL_REQUESTS_ACCESS)) {
    await client.checkCodeAccess();
  }
  return {
    normalizedConfig: {
      organizationUrl: config.organizationUrl,
      pullRequestsInclude: formatScopes(config.include),
      pullRequestsExclude: formatScopes(config.exclude),
      hideDraftPullRequests: config.hideDrafts,
      includeTeamReviewRequests: config.includeTeamRequests,
    } satisfies ConnectorFieldValues,
    connectionSummary: { account: viewer.user.login },
  };
}

async function validateWorkItems(connection: PluginConnection) {
  const parsed = parseConnectorFieldValues(connection.config);
  const azureConfig = buildAzureConfig(connection);
  const validation = await validateAzureDevOpsConnection(azureConfig);

  const normalizedConfig: ConnectorFieldValues = {
    organizationUrl: azureConfig.organizationUrl.replace(/\/+$/, ""),
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

export const syncConnection: NonNullable<PluginModule["syncConnection"]> = async (
  connection,
  workItems = [],
) => {
  const azureConfig = buildAzureConfig(connection);
  const result = await syncAzureDevOpsConnection(azureConfig, workItems);
  return { ...result, ...(await findAzureCommentFacts(azureConfig, workItems)) };
};

export const listSettleStates: NonNullable<PluginModule["listSettleStates"]> = async (connection, request) =>
  await listAzureSettleStates(buildAzureConfig(connection), request.sourceId);

export const writeSettle: NonNullable<PluginModule["writeSettle"]> = async (connection, request) =>
  await writeAzureSettle(buildAzureConfig(connection), request);

/** A page of a work item's comments for Ajour's item page. */
export const listItemComments: NonNullable<PluginModule["listItemComments"]> = async (connection, request) =>
  await listAzureItemComments(buildAzureConfig(connection), request);

/** Posts a comment on a work item, as Markdown. */
export const postItemComment: NonNullable<PluginModule["postItemComment"]> = async (connection, request) =>
  await postAzureItemComment(buildAzureConfig(connection), request);

/** Edits one of the user's comments, as Markdown. */
export const editItemComment: NonNullable<PluginModule["editItemComment"]> = async (connection, request) =>
  await editAzureItemComment(buildAzureConfig(connection), request);

/** Deletes one of the user's comments. */
export const deleteItemComment: NonNullable<PluginModule["deleteItemComment"]> = async (connection, request) =>
  await deleteAzureItemComment(buildAzureConfig(connection), request);

/** Adds or removes the user's reaction on a comment. */
export const setItemCommentReaction: NonNullable<PluginModule["setItemCommentReaction"]> = async (
  connection,
  request,
) => await setAzureItemCommentReaction(buildAzureConfig(connection), request);

/** The item's current description, read when the user edits it in Ajour. */
export const readDescription: NonNullable<PluginModule["readDescription"]> = async (connection, request) =>
  await readAzureDescription(buildAzureConfig(connection), request);

/** Writes the user's edit, unless the item's description changed since it was read. */
export const writeDescription: NonNullable<PluginModule["writeDescription"]> = async (connection, request) =>
  await writeAzureDescription(buildAzureConfig(connection), request);

/** People to mention, for Ajour's @ suggestions. */
export const searchItemPeople: NonNullable<PluginModule["searchItemPeople"]> = async (connection, request) =>
  await searchAzureItemPeople(buildAzureConfig(connection), request);

export const syncPullRequests: NonNullable<PluginModule["syncPullRequests"]> = async (connection, request) =>
  await syncAzurePullRequests(buildPullRequestConfig(connection), request.tracked);
