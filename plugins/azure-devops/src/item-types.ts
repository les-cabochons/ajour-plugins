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
 * icon is one more request, on the organization address. Ajour runs each
 * call in a worker of its own, so nothing is kept between calls.
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
      // Without a field list, Ajour can't tell what the type lacks: send none.
      const fields = Array.isArray(type.fields)
        ? type.fields
            .flatMap((field) => {
              const name = field.name?.trim();
              const id = field.referenceName?.trim();
              return name ? [{ name, ...(id ? { id } : {}) }] : [];
            })
            .slice(0, MAX_FIELDS)
        : undefined;
      const iconSvg = type.icon?.id
        ? await iconOf(type.icon.id, type.color?.trim() || undefined)
        : undefined;
      const suggestions = fields ? suggestionsFor(fields) : undefined;
      return {
        name: type.name!.trim(),
        ...(iconSvg ? { iconSvg } : {}),
        ...(fields ? { fields } : {}),
        ...(suggestions ? { suggestions } : {}),
      };
    }),
  );
}

/**
 * The project of each asked type's sample item, by type key, in the order
 * the types come, read in one batch.
 */
async function sampleProjects(
  config: AzureDevOpsConnectionInput,
  types: ConnectorItemTypesRequest["types"],
): Promise<Map<string, string>> {
  const samples = types.flatMap((type) => {
    const id = type.sourceId
      ? parseAzureWorkItemId(type.sourceId, config.organizationUrl)
      : null;
    return id === null ? [] : [[typeKey(type.name), id] as const];
  });
  const ids = samples.map(([, id]) => id);
  if (ids.length === 0) return new Map();
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
  const projectOfType = new Map<string, string>();
  for (const [key, id] of samples) {
    const project = projectOf.get(id);
    if (project && !projectOfType.has(key)) projectOfType.set(key, project);
  }
  return projectOfType;
}

/**
 * Answers Ajour's `describeItemTypes`: the asked types the sample items'
 * projects have, in the order asked, then those projects' other types for
 * Add a type, leaving out hidden, test and disabled ones. Projects on
 * different processes can share a type name with other fields, so an asked
 * type comes from the project of its own sample item, and a type without
 * one from the first project that has it. A type no project has is left out.
 */
export async function describeAzureItemTypes(
  config: AzureDevOpsConnectionInput,
  request: ConnectorItemTypesRequest,
): Promise<ConnectorItemTypesResult> {
  const projectOfType = await sampleProjects(config, request.types);
  const projects = [...new Set(projectOfType.values())];
  const typesByProject = new Map(
    await Promise.all(
      projects.map(
        async (project) =>
          [
            project,
            new Map(
              (await readProjectTypes(config, project)).map((type) => [
                typeKey(type.name),
                type,
              ]),
            ),
          ] as const,
      ),
    ),
  );
  const firstWith = (key: string) =>
    projects
      .map((project) => typesByProject.get(project)?.get(key))
      .find((type) => type !== undefined);

  const asked = new Map<string, ConnectorItemType>();
  for (const { name } of request.types) {
    const key = typeKey(name);
    if (asked.has(key)) continue;
    const ownProject = projectOfType.get(key);
    const type =
      (ownProject && typesByProject.get(ownProject)?.get(key)) ||
      firstWith(key);
    if (type) asked.set(key, type);
  }
  const others = new Map<string, ConnectorItemType>();
  for (const project of projects) {
    for (const [key, type] of typesByProject.get(project) ?? []) {
      if (!asked.has(key) && !others.has(key)) others.set(key, type);
    }
  }
  return {
    types: [...asked.values(), ...others.values()].slice(0, MAX_TYPES),
  };
}
