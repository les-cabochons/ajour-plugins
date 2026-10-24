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

/**
 * The work item with every field and the format of each multiline field.
 * Azure DevOps leaves the formats out of an answer to a request that names
 * its `fields`, so a description stored as Markdown would read as HTML, and
 * be written back as HTML.
 */
export async function fetchWorkItemWithFormats(config: AzureDevOpsConnectionInput, id: number) {
  return await requestAzureDevOps<AzureWorkItem>(config, `/_apis/wit/workitems/${id}?api-version=7.1`);
}

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
  return { description: describeWorkItem(await fetchWorkItemWithFormats(config, id)) };
}
