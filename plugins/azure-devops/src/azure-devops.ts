import type {
  AzureDevOpsQueryScope,
  ConnectorImportCandidateInput,
  ConnectorPluginSyncResult,
  ConnectorSyncFieldUpdate,
  ConnectorSyncWorkItem,
  ConnectorSyncWorkItemUpdate,
} from "./contract.js";
import { resolveEstimateSyncAction } from "./estimate-sync.js";

export interface AzureDevOpsConnectionInput {
  id?: string;
  label: string;
  tenantLabel: string;
  organizationUrl: string;
  project?: string;
  personalAccessToken: string;
  queryScope: AzureDevOpsQueryScope;
  priorityFieldName?: string;
  originalEstimateFieldName?: string;
  remainingEstimateFieldName?: string;
  completedEstimateFieldName?: string;
  autoSync?: boolean;
  autoSyncIntervalMinutes?: number;
}

const CLOSED_STATE_NAMES = new Set([
  "closed",
  "done",
  "completed",
  "removed",
  "resolved",
  "cut",
  "cancelled",
  "canceled",
]);

const TASK_WORK_ITEM_TYPE = "Task";
const BACKLOG_PARENT_WORK_ITEM_TYPES = [
  "Product Backlog Item",
  "User Story",
  "Requirement",
  "Issue",
  "Bug",
] as const;
const RELEVANT_WORK_ITEM_TYPES = [TASK_WORK_ITEM_TYPE, ...BACKLOG_PARENT_WORK_ITEM_TYPES];
const MAX_CANDIDATE_NOTE_LENGTH = 4000;

interface AzureWiqlResponse {
  workItems?: Array<{
    id: number;
  }>;
}

interface AzureWorkItemRelation {
  rel?: string;
  url?: string;
}

interface AzureWorkItem {
  id: number;
  fields?: Record<string, unknown>;
  relations?: AzureWorkItemRelation[];
}

interface AzureWorkItemBatchResponse {
  value?: AzureWorkItem[];
}

interface AzureFieldDefinition {
  name?: string;
  referenceName?: string;
  type?: string;
  isQueryable?: boolean;
}

interface AzureFieldListResponse {
  value?: AzureFieldDefinition[];
}

interface AzureDevOpsImportFetchResult {
  items: ConnectorImportCandidateInput[];
}

interface AzureDevOpsSyncContext {
  items: ConnectorImportCandidateInput[];
  itemsBySourceId: Map<string, ConnectorImportCandidateInput>;
  fields: {
    priorityField?: AzureResolvedFieldMetadata;
    originalEstimateField?: AzureResolvedFieldMetadata;
    remainingEstimateField?: AzureResolvedFieldMetadata;
    completedEstimateField?: AzureResolvedFieldMetadata;
  };
}

export interface AzureResolvedFieldMetadata {
  configuredName: string;
  resolvedName: string;
  resolvedReferenceName: string;
  type?: string;
  isQueryable?: boolean;
}

export interface AzureDevOpsConnectionValidationResult {
  priorityField?: AzureResolvedFieldMetadata;
  originalEstimateField?: AzureResolvedFieldMetadata;
  remainingEstimateField?: AzureResolvedFieldMetadata;
  completedEstimateField?: AzureResolvedFieldMetadata;
}

const BASE_REQUESTED_WORK_ITEM_FIELDS = [
  "System.Id",
  "System.Title",
  "System.Description",
  "System.State",
  "System.AssignedTo",
  "System.IterationPath",
  "System.TeamProject",
  "System.WorkItemType",
] as const;

function normalizeOrganizationUrl(value: string) {
  return value.replace(/\/+$/, "");
}

function createAuthHeader(personalAccessToken: string) {
  return `Basic ${Buffer.from(`:${personalAccessToken}`, "utf8").toString("base64")}`;
}

function normalizeDisplayValue(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }

  if (value && typeof value === "object") {
    const displayName =
      "displayName" in value ? normalizeDisplayValue(value.displayName) : undefined;
    const uniqueName =
      "uniqueName" in value ? normalizeDisplayValue(value.uniqueName) : undefined;
    return displayName ?? uniqueName;
  }

  return undefined;
}

function decodeHtmlEntities(value: string) {
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (entity, token: string) => {
    const normalizedToken = token.toLowerCase();
    if (normalizedToken.startsWith("#x")) {
      const codePoint = Number.parseInt(normalizedToken.slice(2), 16);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }

    if (normalizedToken.startsWith("#")) {
      const codePoint = Number.parseInt(normalizedToken.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : entity;
    }

    switch (normalizedToken) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return "\"";
      case "apos":
        return "'";
      case "nbsp":
        return " ";
      default:
        return entity;
    }
  });
}

function normalizeDescriptionValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const plainText = decodeHtmlEntities(
    value
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<\/(?:p|div|section|article|blockquote|tr|ul|ol|li|table|h[1-6])>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();

  return plainText.length > 0 ? plainText : undefined;
}

function normalizeConfiguredFieldName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function normalizeLookupValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase() : undefined;
}

function parsePriorityValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.min(999, Math.round(value)));
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.min(999, Math.round(parsed)));
    }
  }

  return undefined;
}

function parseEstimateValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.round(value * 10_000) / 10_000);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return undefined;
    }

    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.max(0, Math.round(parsed * 10_000) / 10_000);
    }
  }

  return undefined;
}

function clampNote(value: string) {
  const trimmed = value.trim();
  if (trimmed.length <= MAX_CANDIDATE_NOTE_LENGTH) {
    return trimmed;
  }

  return `${trimmed.slice(0, MAX_CANDIDATE_NOTE_LENGTH - 3).trimEnd()}...`;
}

function getProjectName(workItem: AzureWorkItem) {
  return normalizeDisplayValue(workItem.fields?.["System.TeamProject"]);
}

function parseRelatedWorkItemId(relation: AzureWorkItemRelation | undefined): number | null {
  const url = relation?.url;
  if (!url) {
    return null;
  }

  const match = url.match(/\/workItems\/(\d+)(?:$|[/?#])/i);
  if (!match) {
    return null;
  }

  return Number(match[1]);
}

function isOpenState(state: string | undefined) {
  if (!state) {
    return true;
  }

  return !CLOSED_STATE_NAMES.has(state.trim().toLowerCase());
}

function isTask(workItemType: string | undefined) {
  return workItemType === TASK_WORK_ITEM_TYPE;
}

function isBacklogParentType(workItemType: string | undefined) {
  return Boolean(workItemType && BACKLOG_PARENT_WORK_ITEM_TYPES.includes(workItemType as (typeof BACKLOG_PARENT_WORK_ITEM_TYPES)[number]));
}

function buildWorkItemTypeFilter() {
  return RELEVANT_WORK_ITEM_TYPES.map(
    (type) => `[System.WorkItemType] = '${type.replace(/'/g, "''")}'`,
  ).join("\n      OR ");
}

function buildBaseWiqlQuery(queryScope: AzureDevOpsConnectionInput["queryScope"]) {
  const assignedClause =
    queryScope === "assigned_to_me" ? "\n  AND [System.AssignedTo] = @Me" : "";

  return `SELECT [System.Id]
FROM WorkItems
WHERE (
      ${buildWorkItemTypeFilter()}
  )${assignedClause}
ORDER BY [System.ChangedDate] DESC`;
}

async function requestAzureDevOps<T>(
  config: AzureDevOpsConnectionInput,
  pathname: string,
  init?: RequestInit,
): Promise<T> {
  const organizationUrl = normalizeOrganizationUrl(config.organizationUrl);
  const url = `${organizationUrl}${pathname}`;

  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: createAuthHeader(config.personalAccessToken),
        "Content-Type": "application/json",
        ...init?.headers,
      },
    });
  } catch (error) {
    throw new Error(
      `Azure DevOps request failed: ${error instanceof Error ? error.message : "Network error"}`,
    );
  }

  if (!response.ok) {
    let detail = response.statusText || "Request failed";
    try {
      const payload = (await response.json()) as { message?: string };
      if (typeof payload.message === "string" && payload.message.trim().length > 0) {
        detail = payload.message.trim();
      }
    } catch {
      // Ignore non-JSON error responses.
    }

    throw new Error(`Azure DevOps request failed (${response.status}): ${detail}`);
  }

  return (await response.json()) as T;
}

async function executeWiqlQuery(
  config: AzureDevOpsConnectionInput,
  query: string,
): Promise<number[]> {
  const response = await requestAzureDevOps<AzureWiqlResponse>(
    config,
    "/_apis/wit/wiql?$top=200&api-version=7.1",
    {
      method: "POST",
      body: JSON.stringify({ query }),
    },
  );

  return (response.workItems ?? []).map((item) => item.id);
}

function chunkValues(values: number[], chunkSize: number) {
  const chunks: number[][] = [];
  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }
  return chunks;
}

function requireSingleFieldMatch(
  configuredFieldName: string,
  matches: AzureFieldDefinition[],
  matchKind: "display name" | "reference name",
) {
  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length > 1) {
    const references = matches
      .map((field) => field.referenceName)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right));
    throw new Error(
      `Azure DevOps field "${configuredFieldName}" matched multiple fields by ${matchKind}. Use the exact reference name instead${references.length > 0 ? `: ${references.join(", ")}` : "."}`,
    );
  }

  return undefined;
}

async function resolveAzureFieldMetadata(
  config: AzureDevOpsConnectionInput,
  configuredFieldName: string | undefined,
): Promise<AzureResolvedFieldMetadata | undefined> {
  const normalizedConfiguredFieldName = normalizeConfiguredFieldName(configuredFieldName);
  if (!normalizedConfiguredFieldName) {
    return undefined;
  }

  const normalizedLookupValue = normalizeLookupValue(normalizedConfiguredFieldName);
  const response = await requestAzureDevOps<AzureFieldListResponse>(
    config,
    "/_apis/wit/fields?api-version=7.1",
  );
  const fields = response.value ?? [];

  const referenceNameMatch = requireSingleFieldMatch(
    normalizedConfiguredFieldName,
    fields.filter(
      (field) => normalizeLookupValue(field.referenceName) === normalizedLookupValue,
    ),
    "reference name",
  );
  if (referenceNameMatch?.referenceName) {
    return {
      configuredName: normalizedConfiguredFieldName,
      resolvedName: referenceNameMatch.name?.trim() || normalizedConfiguredFieldName,
      resolvedReferenceName: referenceNameMatch.referenceName,
      type: referenceNameMatch.type?.trim() || undefined,
      isQueryable: referenceNameMatch.isQueryable,
    };
  }

  const displayNameMatch = requireSingleFieldMatch(
    normalizedConfiguredFieldName,
    fields.filter((field) => normalizeLookupValue(field.name) === normalizedLookupValue),
    "display name",
  );
  if (displayNameMatch?.referenceName) {
    return {
      configuredName: normalizedConfiguredFieldName,
      resolvedName: displayNameMatch.name?.trim() || normalizedConfiguredFieldName,
      resolvedReferenceName: displayNameMatch.referenceName,
      type: displayNameMatch.type?.trim() || undefined,
      isQueryable: displayNameMatch.isQueryable,
    };
  }

  throw new Error(
    `Azure DevOps field "${normalizedConfiguredFieldName}" was not found. Enter the display name shown in Azure DevOps or the exact reference name.`,
  );
}

function mergeWorkItemBatchResponses(
  ids: number[],
  fieldItems: AzureWorkItem[],
  relationItems: AzureWorkItem[],
): AzureWorkItem[] {
  const fieldItemsById = new Map(fieldItems.map((item) => [item.id, item]));
  const relationItemsById = new Map(relationItems.map((item) => [item.id, item]));

  return ids.flatMap((id) => {
    const fieldItem = fieldItemsById.get(id);
    const relationItem = relationItemsById.get(id);
    if (!fieldItem && !relationItem) {
      return [];
    }

    return [
      {
        ...relationItem,
        ...fieldItem,
        id,
        fields: fieldItem?.fields ?? relationItem?.fields,
        relations: relationItem?.relations ?? fieldItem?.relations,
      },
    ];
  });
}

async function fetchWorkItems(
  config: AzureDevOpsConnectionInput,
  ids: number[],
  additionalFields: string[] = [],
): Promise<AzureWorkItem[]> {
  if (ids.length === 0) {
    return [];
  }

  const requestedFields = Array.from(
    new Set([
      ...BASE_REQUESTED_WORK_ITEM_FIELDS,
      ...additionalFields,
    ]),
  );

  const results = await Promise.all(
    chunkValues(ids, 200).map(async (chunk) => {
      // Azure DevOps rejects combining `fields` with `$expand: "Relations"` for workitemsbatch.
      const [fieldResponse, relationResponse] = await Promise.all([
        requestAzureDevOps<AzureWorkItemBatchResponse>(
          config,
          "/_apis/wit/workitemsbatch?api-version=7.1",
          {
            method: "POST",
            body: JSON.stringify({
              ids: chunk,
              fields: requestedFields,
              errorPolicy: "omit",
            }),
          },
        ),
        requestAzureDevOps<AzureWorkItemBatchResponse>(
          config,
          "/_apis/wit/workitemsbatch?api-version=7.1",
          {
            method: "POST",
            body: JSON.stringify({
              ids: chunk,
              errorPolicy: "omit",
              $expand: "Relations",
            }),
          },
        ),
      ]);

      return mergeWorkItemBatchResponses(
        chunk,
        fieldResponse.value ?? [],
        relationResponse.value ?? [],
      );
    }),
  );

  return results.flat();
}

async function updateAzureWorkItemFields(
  config: AzureDevOpsConnectionInput,
  workItemId: string,
  fields: Record<string, number>,
) {
  const operations = Object.entries(fields).map(([fieldName, value]) => ({
    op: "add",
    path: `/fields/${fieldName}`,
    value,
  }));
  if (operations.length === 0) {
    return;
  }

  await requestAzureDevOps(
    config,
    `/_apis/wit/workitems/${encodeURIComponent(workItemId)}?api-version=7.1`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json-patch+json",
      },
      body: JSON.stringify(operations),
    },
  );
}

function buildSourceUrl(config: AzureDevOpsConnectionInput, workItem: AzureWorkItem) {
  const organizationUrl = normalizeOrganizationUrl(config.organizationUrl);
  const projectName = getProjectName(workItem) ?? config.project;
  const projectSegment = projectName ? `/${encodeURIComponent(projectName)}` : "";
  return `${organizationUrl}${projectSegment}/_workitems/edit/${workItem.id}`;
}

function buildCandidateNote(workItem: AzureWorkItem) {
  const description = normalizeDescriptionValue(workItem.fields?.["System.Description"]);
  return description ? clampNote(description) : undefined;
}

function getParentId(workItem: AzureWorkItem): number | null {
  const relation = workItem.relations?.find(
    (candidate) => candidate.rel === "System.LinkTypes.Hierarchy-Reverse",
  );
  return parseRelatedWorkItemId(relation);
}

function getChildIds(workItem: AzureWorkItem): number[] {
  return (workItem.relations ?? [])
    .filter((candidate) => candidate.rel === "System.LinkTypes.Hierarchy-Forward")
    .map((candidate) => parseRelatedWorkItemId(candidate))
    .filter((candidate): candidate is number => candidate !== null);
}

function mapWorkItemToCandidate(
  config: AzureDevOpsConnectionInput,
  workItem: AzureWorkItem,
  allItems: Map<number, AzureWorkItem>,
  baseCandidateIds: Set<number>,
  fieldReferences?: {
    priorityFieldReferenceName?: string;
    originalEstimateFieldReferenceName?: string;
    remainingEstimateFieldReferenceName?: string;
    completedEstimateFieldReferenceName?: string;
  },
): ConnectorImportCandidateInput | null {
  const title = normalizeDisplayValue(workItem.fields?.["System.Title"]);
  const state = normalizeDisplayValue(workItem.fields?.["System.State"]);
  const workItemType = normalizeDisplayValue(workItem.fields?.["System.WorkItemType"]);
  const assignedTo = normalizeDisplayValue(workItem.fields?.["System.AssignedTo"]);
  const projectName = getProjectName(workItem);
  const priority = fieldReferences?.priorityFieldReferenceName
    ? parsePriorityValue(workItem.fields?.[fieldReferences.priorityFieldReferenceName])
    : undefined;
  const originalEstimateHours = fieldReferences?.originalEstimateFieldReferenceName
    ? parseEstimateValue(workItem.fields?.[fieldReferences.originalEstimateFieldReferenceName])
    : undefined;
  const remainingEstimateHours = fieldReferences?.remainingEstimateFieldReferenceName
    ? parseEstimateValue(workItem.fields?.[fieldReferences.remainingEstimateFieldReferenceName])
    : undefined;
  const completedEstimateHours = fieldReferences?.completedEstimateFieldReferenceName
    ? parseEstimateValue(workItem.fields?.[fieldReferences.completedEstimateFieldReferenceName])
    : undefined;

  if (!title || !workItemType || !isOpenState(state)) {
    return null;
  }

  const isBaseCandidate = baseCandidateIds.has(workItem.id);
  const selectable = isBaseCandidate;
  const sourceUrl = buildSourceUrl(config, workItem);

  if (isTask(workItemType)) {
    const parentId = getParentId(workItem);
    const parent = parentId ? allItems.get(parentId) : undefined;
    const parentTitle = normalizeDisplayValue(parent?.fields?.["System.Title"]);
    const parentState = normalizeDisplayValue(parent?.fields?.["System.State"]);
    const hasImportableParent = Boolean(parent && parentTitle && isOpenState(parentState));

    return {
      source: "azure_devops",
      connectionId: config.id ?? "unknown_connection",
      connectionLabel: config.label,
      tenantLabel: config.tenantLabel,
      sourceId: sourceUrl,
      externalId: String(workItem.id),
      sourceUrl,
      title,
      note: buildCandidateNote(workItem),
      projectName,
      workItemType,
      state,
      assignedTo,
      priority,
      originalEstimateHours,
      remainingEstimateHours,
      completedEstimateHours,
      parentSourceId: hasImportableParent && parent ? buildSourceUrl(config, parent) : undefined,
      parentTitle: hasImportableParent ? parentTitle : undefined,
      depth: hasImportableParent ? 1 : 0,
      selectable,
      selected: selectable,
      childCount: 0,
    };
  }

  if (!isBacklogParentType(workItemType)) {
    return null;
  }

  const includedChildCount = getChildIds(workItem).filter((childId) => {
    if (!baseCandidateIds.has(childId)) {
      return false;
    }

    const child = allItems.get(childId);
    const childType = normalizeDisplayValue(child?.fields?.["System.WorkItemType"]);
    const childState = normalizeDisplayValue(child?.fields?.["System.State"]);
    return Boolean(child && isTask(childType) && isOpenState(childState));
  }).length;

  if (!selectable && includedChildCount === 0) {
    return null;
  }

  return {
    source: "azure_devops",
    connectionId: config.id ?? "unknown_connection",
    connectionLabel: config.label,
    tenantLabel: config.tenantLabel,
    sourceId: sourceUrl,
    externalId: String(workItem.id),
    sourceUrl,
    title,
    note: buildCandidateNote(workItem),
    projectName,
    workItemType,
    state,
    assignedTo,
    priority,
    originalEstimateHours,
    remainingEstimateHours,
    completedEstimateHours,
    depth: 0,
    selectable,
    selected: selectable,
    childCount: includedChildCount,
  };
}

async function fetchAzureDevOpsSyncContext(
  config: AzureDevOpsConnectionInput,
): Promise<AzureDevOpsSyncContext> {
  const priorityField = await resolveAzureFieldMetadata(config, config.priorityFieldName);
  const originalEstimateField = await resolveAzureFieldMetadata(config, config.originalEstimateFieldName);
  const remainingEstimateField = await resolveAzureFieldMetadata(config, config.remainingEstimateFieldName);
  const completedEstimateField = await resolveAzureFieldMetadata(config, config.completedEstimateFieldName);
  const baseIds = await executeWiqlQuery(config, buildBaseWiqlQuery(config.queryScope));
  if (baseIds.length === 0) {
    return {
      items: [],
      itemsBySourceId: new Map(),
      fields: {
        priorityField,
        originalEstimateField,
        remainingEstimateField,
        completedEstimateField,
      },
    };
  }

  const additionalFields = [
    priorityField?.resolvedReferenceName,
    originalEstimateField?.resolvedReferenceName,
    remainingEstimateField?.resolvedReferenceName,
    completedEstimateField?.resolvedReferenceName,
  ].filter((value): value is string => Boolean(value));
  const baseItems = await fetchWorkItems(config, baseIds, additionalFields);
  const baseCandidateIds = new Set(baseItems.map((item) => item.id));

  const parentContextIds = new Set<number>();
  for (const workItem of baseItems) {
    const workItemType = normalizeDisplayValue(workItem.fields?.["System.WorkItemType"]);
    if (!isTask(workItemType)) {
      continue;
    }

    const parentId = getParentId(workItem);
    if (parentId && !baseCandidateIds.has(parentId)) {
      parentContextIds.add(parentId);
    }
  }

  const parentContextItems = await fetchWorkItems(config, Array.from(parentContextIds), additionalFields);
  const allItems = new Map<number, AzureWorkItem>(
    [...baseItems, ...parentContextItems].map((item) => [item.id, item] as const),
  );

  const candidatesBySourceId = new Map<string, ConnectorImportCandidateInput>();
  for (const workItem of allItems.values()) {
    const candidate = mapWorkItemToCandidate(
      config,
      workItem,
      allItems,
      baseCandidateIds,
      {
        priorityFieldReferenceName: priorityField?.resolvedReferenceName,
        originalEstimateFieldReferenceName: originalEstimateField?.resolvedReferenceName,
        remainingEstimateFieldReferenceName: remainingEstimateField?.resolvedReferenceName,
        completedEstimateFieldReferenceName: completedEstimateField?.resolvedReferenceName,
      },
    );
    if (!candidate) {
      continue;
    }

    candidatesBySourceId.set(candidate.sourceId, candidate);
  }

  const items = Array.from(candidatesBySourceId.values()).sort((left, right) => {
    if (left.connectionId !== right.connectionId) {
      return left.connectionId.localeCompare(right.connectionId);
    }

    if (left.depth !== right.depth) {
      return left.depth - right.depth;
    }

    if ((left.parentSourceId ?? "") !== (right.parentSourceId ?? "")) {
      return (left.parentSourceId ?? "").localeCompare(right.parentSourceId ?? "");
    }

    return left.title.localeCompare(right.title);
  });

  return {
    items,
    itemsBySourceId: new Map(items.map((item) => [item.sourceId, item] as const)),
    fields: {
      priorityField,
      originalEstimateField,
      remainingEstimateField,
      completedEstimateField,
    },
  };
}

function buildAzureEstimateFieldUpdate(
  localWorkItem: ConnectorSyncWorkItem,
  remoteItem: ConnectorImportCandidateInput,
  fieldKey: "originalEstimateHours" | "remainingEstimateHours" | "completedEstimateHours",
): ConnectorSyncFieldUpdate | null {
  const fieldSyncState = localWorkItem.estimateSync?.[fieldKey];
  if (
    remoteItem[fieldKey] === undefined &&
    fieldSyncState?.remoteValue === undefined &&
    fieldSyncState?.baselineValue === undefined
  ) {
    return null;
  }

  const action = resolveEstimateSyncAction({
    localValue: localWorkItem[fieldKey],
    remoteValue: remoteItem[fieldKey],
    baselineValue: fieldSyncState?.baselineValue,
    resolution: fieldSyncState?.resolution,
  });

  return {
    status:
      action.status === "push"
        ? "pushed"
        : action.status === "pull"
          ? "pulled"
          : action.status,
    localValue: action.localValue,
    remoteValue: action.remoteValue,
    baselineValue: action.baselineValue,
    nextBaselineValue: "nextBaselineValue" in action ? action.nextBaselineValue : undefined,
  };
}

async function buildAzureWorkItemUpdates(
  config: AzureDevOpsConnectionInput,
  syncContext: AzureDevOpsSyncContext,
  workItems: ConnectorSyncWorkItem[],
): Promise<ConnectorSyncWorkItemUpdate[]> {
  const updates: ConnectorSyncWorkItemUpdate[] = [];
  const mappedFieldNames = {
    originalEstimateHours: syncContext.fields.originalEstimateField?.resolvedReferenceName,
    remainingEstimateHours: syncContext.fields.remainingEstimateField?.resolvedReferenceName,
    completedEstimateHours: syncContext.fields.completedEstimateField?.resolvedReferenceName,
  } as const;

  for (const workItem of workItems) {
    const remoteItem = syncContext.itemsBySourceId.get(workItem.sourceId);
    if (!remoteItem) {
      continue;
    }

    const fieldUpdates: ConnectorSyncWorkItemUpdate["fields"] = {};

    for (const fieldKey of Object.keys(mappedFieldNames) as Array<keyof typeof mappedFieldNames>) {
      const mappedFieldName = mappedFieldNames[fieldKey];
      if (!mappedFieldName) {
        continue;
      }

      const fieldUpdate = buildAzureEstimateFieldUpdate(workItem, remoteItem, fieldKey);
      if (!fieldUpdate) {
        continue;
      }
      fieldUpdates[fieldKey] = fieldUpdate;
    }

    if (Object.keys(fieldUpdates).length === 0) {
      continue;
    }

    for (const fieldKey of Object.keys(fieldUpdates) as Array<keyof typeof fieldUpdates>) {
      const mappedFieldName = mappedFieldNames[fieldKey];
      const fieldUpdate = fieldUpdates[fieldKey];
      if (!mappedFieldName || fieldUpdate?.status !== "pushed" || typeof workItem[fieldKey] !== "number") {
        continue;
      }

      try {
        await updateAzureWorkItemFields(config, remoteItem.externalId, {
          [mappedFieldName]: workItem[fieldKey]!,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to update Azure DevOps work item.";
        fieldUpdates[fieldKey] = {
          ...fieldUpdate,
          status: "error",
          message,
        };
      }
    }

    updates.push({
      localWorkItemId: workItem.localWorkItemId,
      sourceId: workItem.sourceId,
      fields: fieldUpdates,
    });
  }

  return updates;
}

export async function validateAzureDevOpsConnection(config: AzureDevOpsConnectionInput) {
  const priorityField = await resolveAzureFieldMetadata(config, config.priorityFieldName);
  const originalEstimateField = await resolveAzureFieldMetadata(config, config.originalEstimateFieldName);
  const remainingEstimateField = await resolveAzureFieldMetadata(config, config.remainingEstimateFieldName);
  const completedEstimateField = await resolveAzureFieldMetadata(config, config.completedEstimateFieldName);
  const ids = await executeWiqlQuery(config, buildBaseWiqlQuery(config.queryScope));
  if (!Array.isArray(ids)) {
    throw new Error(
      `Azure DevOps query did not return a valid work item list for ${normalizeOrganizationUrl(config.organizationUrl)}.`,
    );
  }

  return {
    priorityField,
    originalEstimateField,
    remainingEstimateField,
    completedEstimateField,
  } satisfies AzureDevOpsConnectionValidationResult;
}

export async function fetchAzureDevOpsImportCandidates(
  config: AzureDevOpsConnectionInput,
): Promise<AzureDevOpsImportFetchResult> {
  const syncContext = await fetchAzureDevOpsSyncContext(config);
  return { items: syncContext.items };
}

export async function syncAzureDevOpsConnection(
  config: AzureDevOpsConnectionInput,
  workItems: ConnectorSyncWorkItem[] = [],
): Promise<ConnectorPluginSyncResult> {
  const syncContext = await fetchAzureDevOpsSyncContext(config);
  return {
    items: syncContext.items,
    workItemUpdates: await buildAzureWorkItemUpdates(config, syncContext, workItems),
  };
}
