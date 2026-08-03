import type {
  ConnectorFieldValues,
  ConnectorPluginConnection,
  ConnectorSyncWorkItem,
} from "./contract.js";
import { parseConnectorFieldValues } from "./contract.js";
import {
  syncAzureDevOpsConnection,
  type AzureDevOpsConnectionInput,
  validateAzureDevOpsConnection,
} from "./azure-devops.js";

const TASK_ICON_DISPLAY_MODES = new Set(["always", "fallback", "never"]);

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

export async function validateConnection(config: ConnectorFieldValues) {
  const parsed = parseConnectorFieldValues(config);
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
  return await syncAzureDevOpsConnection(azureConfig, workItems);
}
