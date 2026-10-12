import {
  getProjectName,
  normalizeDisplayValue,
  parseAzureWorkItemId,
  parsePriorityValue,
  requestAzureDevOps,
  resolveAzureFieldMetadata,
  updateAzureWorkItemFields,
  type AzureDevOpsConnectionInput,
  type AzureWorkItem,
} from "./azure-devops.js";
import type {
  ConnectorSettleStatesResult,
  ConnectorSettleWriteRequest,
  ConnectorSettleWriteResult,
} from "./contract.js";
import {
  createStateCategoryResolver,
  formatStateCategory,
  isDoneStateCategory,
  sortStatesByCategory,
} from "./state-categories.js";

/**
 * Settling a backlog item from Ajour: the states its work item type can move
 * to, and the write of a new state, priority or both. See Ajour's ADR 0001.
 */

function requireWorkItemId(sourceId: string) {
  const id = parseAzureWorkItemId(sourceId);
  if (id === null) {
    throw new Error(`"${sourceId}" is not an Azure DevOps work item.`);
  }
  return id;
}

async function fetchWorkItemState(config: AzureDevOpsConnectionInput, id: number) {
  return await requestAzureDevOps<AzureWorkItem>(
    config,
    `/_apis/wit/workitems/${id}?fields=System.State,System.WorkItemType,System.TeamProject&api-version=7.1`,
  );
}

/** The states of the item's work item type, grouped by category in workflow order. */
export async function listAzureSettleStates(
  config: AzureDevOpsConnectionInput,
  sourceId: string,
): Promise<ConnectorSettleStatesResult> {
  const workItem = await fetchWorkItemState(config, requireWorkItemId(sourceId));
  const projectName = getProjectName(workItem);
  const workItemType = normalizeDisplayValue(workItem.fields?.["System.WorkItemType"]);
  if (!projectName || !workItemType) {
    throw new Error("Azure DevOps did not return the work item's project and type.");
  }

  const states = await createStateCategoryResolver(config, requestAzureDevOps).loadStates(
    projectName,
    workItemType,
  );
  return {
    states: sortStatesByCategory(states).map((state) => ({
      name: state.name,
      category: formatStateCategory(state.category),
      done: isDoneStateCategory(state.category),
    })),
  };
}

/**
 * Writes the settle's changed fields in one update. Priority goes to the
 * connection's priority field, which must be set to write a priority.
 */
export async function writeAzureSettle(
  config: AzureDevOpsConnectionInput,
  request: ConnectorSettleWriteRequest,
): Promise<ConnectorSettleWriteResult> {
  const id = requireWorkItemId(request.sourceId);
  const fields: Record<string, number | string> = {};
  if (request.state !== undefined) {
    fields["System.State"] = request.state;
  }

  const priorityField =
    request.priority !== undefined
      ? await resolveAzureFieldMetadata(config, config.priorityFieldName)
      : undefined;
  if (request.priority !== undefined) {
    if (!priorityField) {
      throw new Error(
        "Set a priority field on the Azure DevOps connection to write priority.",
      );
    }
    // Picklist and text fields take the number as text.
    fields[priorityField.resolvedReferenceName] = priorityField.type
      ?.toLowerCase()
      .includes("string")
      ? String(request.priority)
      : request.priority;
  }

  const updated = await updateAzureWorkItemFields(config, String(id), fields);
  if (!updated) {
    throw new Error("A settle write needs a state, a priority or both.");
  }

  const state = normalizeDisplayValue(updated.fields?.["System.State"]);
  const info = await createStateCategoryResolver(config, requestAzureDevOps).describeState(
    getProjectName(updated),
    normalizeDisplayValue(updated.fields?.["System.WorkItemType"]),
    state,
  );
  return {
    state,
    stateCategory: info.category,
    stateDone: info.done,
    priority: priorityField
      ? parsePriorityValue(updated.fields?.[priorityField.resolvedReferenceName])
      : undefined,
  };
}
