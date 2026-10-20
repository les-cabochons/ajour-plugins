import {
  parseAzureWorkItemId,
  requestAzureDevOps,
  type AzureDevOpsConnectionInput,
  type AzureWorkItem,
} from "./azure-devops.js";
import type {
  BacklogReadDescriptionRequest,
  BacklogReadDescriptionResult,
} from "./contract.js";
import { describeWorkItem } from "./description.js";

function requireWorkItemId(config: AzureDevOpsConnectionInput, sourceId: string) {
  const id = parseAzureWorkItemId(sourceId, config.organizationUrl);
  if (id === null) {
    throw new Error(`"${sourceId}" is not an Azure DevOps work item.`);
  }
  return id;
}

/**
 * The work item's current description, as Ajour syncs it. Ajour asks when the
 * user starts editing and again before it saves, to merge with the source.
 */
export async function readAzureDescription(
  config: AzureDevOpsConnectionInput,
  request: BacklogReadDescriptionRequest,
): Promise<BacklogReadDescriptionResult> {
  const id = requireWorkItemId(config, request.sourceId);
  const workItem = await requestAzureDevOps<AzureWorkItem>(
    config,
    `/_apis/wit/workitems/${id}?fields=System.Description,System.AssignedTo&api-version=7.1`,
  );
  return { description: describeWorkItem(workItem) };
}
