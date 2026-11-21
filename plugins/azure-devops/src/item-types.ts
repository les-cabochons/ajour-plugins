import {
  getProjectName,
  parseAzureWorkItemId,
  requestAzureDevOps,
  sendAzureDevOps,
  type AzureDevOpsConnectionInput,
  type AzureWorkItem,
} from "./azure-devops.ts";
import type {
  ConnectorItemType,
  ConnectorItemTypesRequest,
  ConnectorItemTypesResult,
} from "./contract.ts";

/*
 * What Ajour's connection form shows for each work item type: its icon, its
 * fields, and which field to propose for each estimate field. One read of
 * the project's types gives the names, colours, icon ids and fields; each
 * icon is one more request, on the organization address.
 */

/** Types nobody files by hand: hidden in every process, or for test management. */
const HIDDEN_TYPES = new Set([
  "code review request",
  "code review response",
  "feedback request",
  "feedback response",
  "shared parameter",
  "shared steps",
  "test case",
  "test plan",
  "test suite",
]);

/** The fields to propose for each estimate field, best first, by display name. */
const ESTIMATE_SUGGESTIONS: Record<string, readonly string[]> = {
  originalEstimateFieldName: [
    "Original Estimate",
    "Effort",
    "Story Points",
    "Size",
  ],
  remainingEstimateFieldName: ["Remaining Work"],
  completedEstimateFieldName: ["Completed Work"],
};

/** Ajour's limit for a type's icon, and its limits for the answer's lists. */
const MAX_ICON_LENGTH = 20_000;
const MAX_TYPES = 200;
const MAX_FIELDS = 1000;

/** Azure DevOps' icon: one `<svg>` holding one `<path>`, after an optional XML declaration. */
const ONE_PATH_SVG =
  /^<svg\b[^<>]*>\s*<path\b[^<>]*?(?:\/>|>\s*<\/path>)\s*<\/svg>$/;

interface AzureWorkItemTypeList {
  value?: Array<{
    name?: string;
    color?: string;
    icon?: { id?: string };
    isDisabled?: boolean;
    fields?: Array<{ name?: string; referenceName?: string }>;
  }>;
}

/**
 * Each project's types, kept for the plugin's lifetime, by connection,
 * organization and project. A failed read is dropped, so the next one tries
 * again.
 */
const projectTypes = new Map<string, Promise<ConnectorItemType[]>>();

function typeKey(name: string) {
  return name.trim().toLowerCase();
}

/** The icon's SVG, or undefined when the answer isn't one SVG of one path, or is too long. */
export function oneSvgIcon(text: string): string | undefined {
  const svg = text.trim().replace(/^<\?xml\b[^<>]*\?>\s*/, "");
  if (svg.length > MAX_ICON_LENGTH || !ONE_PATH_SVG.test(svg)) return undefined;
  // Ajour draws it as an image, where scripts don't run; refuse them anyway.
  return /\son[a-z]+\s*=|javascript:/i.test(svg) ? undefined : svg;
}

async function fetchIcon(
  config: AzureDevOpsConnectionInput,
  iconId: string,
  color: string | undefined,
): Promise<string | undefined> {
  try {
    // The organization address, not the icon's `url`, which names another host.
    const response = await sendAzureDevOps(
      config,
      `/_apis/wit/workitemicons/${encodeURIComponent(iconId)}`,
      { query: { ...(color ? { color } : {}), v: 2 }, accept: "image/svg+xml" },
    );
    return response.ok ? oneSvgIcon(await response.text()) : undefined;
  } catch {
    return undefined;
  }
}

/** Each estimate field's proposals among the type's fields, or undefined when there are none. */
function suggestionsFor(fields: { name: string }[]) {
  const names = new Map(fields.map((field) => [typeKey(field.name), field.name]));
  const entries = Object.entries(ESTIMATE_SUGGESTIONS).flatMap(
    ([fieldId, candidates]) => {
      const present = candidates.flatMap((candidate) => {
        const name = names.get(typeKey(candidate));
        return name ? [name] : [];
      });
      return present.length > 0 ? [[fieldId, present] as const] : [];
    },
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

async function readProjectTypes(
  config: AzureDevOpsConnectionInput,
  project: string,
): Promise<ConnectorItemType[]> {
  const response = await requestAzureDevOps<AzureWorkItemTypeList>(
    config,
    `/${encodeURIComponent(project)}/_apis/wit/workitemtypes`,
    { query: { "api-version": "7.1" } },
  );
  const visible = (response.value ?? []).filter(
    (type) =>
      type.name?.trim() && !type.isDisabled && !HIDDEN_TYPES.has(typeKey(type.name)),
  );
  // One request per distinct icon and colour.
  const icons = new Map<string, Promise<string | undefined>>();
  const iconOf = (iconId: string, color: string | undefined) => {
    const key = `${iconId}\n${color ?? ""}`;
    let icon = icons.get(key);
    if (!icon) {
      icon = fetchIcon(config, iconId, color);
      icons.set(key, icon);
    }
    return icon;
  };
  return await Promise.all(
    visible.map(async (type) => {
      const fields = (type.fields ?? [])
        .flatMap((field) => {
          const name = field.name?.trim();
          const id = field.referenceName?.trim();
          return name ? [{ name, ...(id ? { id } : {}) }] : [];
        })
        .slice(0, MAX_FIELDS);
      const iconSvg = type.icon?.id
        ? await iconOf(type.icon.id, type.color?.trim() || undefined)
        : undefined;
      const suggestions = suggestionsFor(fields);
      return {
        name: type.name!.trim(),
        ...(iconSvg ? { iconSvg } : {}),
        fields,
        ...(suggestions ? { suggestions } : {}),
      };
    }),
  );
}

function loadProjectTypes(config: AzureDevOpsConnectionInput, project: string) {
  const key = [config.id, config.organizationUrl, typeKey(project)].join("\n");
  let types = projectTypes.get(key);
  if (!types) {
    types = readProjectTypes(config, project);
    projectTypes.set(key, types);
    types.catch(() => projectTypes.delete(key));
  }
  return types;
}

/** The projects of the request's sample items, in the order the types come, read in one batch. */
async function sampleProjects(
  config: AzureDevOpsConnectionInput,
  types: ConnectorItemTypesRequest["types"],
): Promise<string[]> {
  const ids = types.flatMap((type) => {
    const id = type.sourceId
      ? parseAzureWorkItemId(type.sourceId, config.organizationUrl)
      : null;
    return id === null ? [] : [id];
  });
  if (ids.length === 0) return [];
  const response = await requestAzureDevOps<{ value?: AzureWorkItem[] }>(
    config,
    "/_apis/wit/workitemsbatch",
    {
      method: "POST",
      query: { "api-version": "7.1" },
      body: JSON.stringify({
        ids: [...new Set(ids)].slice(0, 200),
        fields: ["System.TeamProject"],
        errorPolicy: "omit",
      }),
    },
  );
  const projectOf = new Map(
    (response.value ?? []).map((item) => [item.id, getProjectName(item)]),
  );
  return [
    ...new Set(
      ids.flatMap((id) => {
        const project = projectOf.get(id);
        return project ? [project] : [];
      }),
    ),
  ];
}

/**
 * Answers Ajour's `describeItemTypes`: the asked types the sample items'
 * projects have, in the order asked, then those projects' other types for
 * Add a type, leaving out hidden, test and disabled ones. A name two
 * projects share takes the first project's answer. A type no project has
 * is left out.
 */
export async function describeAzureItemTypes(
  config: AzureDevOpsConnectionInput,
  request: ConnectorItemTypesRequest,
): Promise<ConnectorItemTypesResult> {
  const projects = await sampleProjects(config, request.types);
  const known = new Map<string, ConnectorItemType>();
  for (const types of await Promise.all(
    projects.map((project) => loadProjectTypes(config, project)),
  )) {
    for (const type of types) {
      if (!known.has(typeKey(type.name))) known.set(typeKey(type.name), type);
    }
  }
  const asked = new Map<string, ConnectorItemType>();
  for (const { name } of request.types) {
    const type = known.get(typeKey(name));
    if (type) asked.set(typeKey(name), type);
  }
  const others = [...known.entries()]
    .filter(([key]) => !asked.has(key))
    .map(([, type]) => type);
  return { types: [...asked.values(), ...others].slice(0, MAX_TYPES) };
}
