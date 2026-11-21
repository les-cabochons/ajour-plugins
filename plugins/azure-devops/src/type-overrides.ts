// A copy of `lib/type-overrides.ts` from @ajour/plugin-sdk 0.3.0, which copies
// `packages/shared/type-overrides.ts` in les-cabochons/ajour. Ajour runs this
// plugin from its own files only, so it cannot import the SDK at run time.
// tests/type-overrides.test.ts checks that this copy reads values as the SDK does.

/*
 * The value of a `typeOverrides` connection field: the text fields an item
 * type uses instead of the connection's own, such as Original Estimate for a
 * Task where the connection names Effort. Ajour stores it as a JSON text
 * under the field's id, `{ "<type name>": { "<field id>": "<text>" } }`,
 * with only the filled inputs.
 */

/** The overrides by item type name, then by the id of the field they replace. */
export type TypeOverrides = Record<string, Record<string, string>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The overrides without blank texts, and without a type left with none. */
function withoutBlanks(overrides: Record<string, Record<string, unknown>>) {
  const result: TypeOverrides = {};
  for (const [typeName, fields] of Object.entries(overrides)) {
    const name = typeName.trim();
    if (!name) continue;
    for (const [fieldId, text] of Object.entries(fields)) {
      const trimmed = typeof text === "string" ? text.trim() : "";
      if (!trimmed) continue;
      result[name] = { ...result[name], [fieldId]: trimmed };
    }
  }
  return result;
}

/**
 * Reads a stored value. No value, or empty text, means no overrides. Throws
 * when the text isn't the JSON shape above, with a message for the user.
 */
export function parseTypeOverrides(value: unknown): TypeOverrides {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") {
    throw new Error("The overrides by type must be text.");
  }
  if (!value.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("The overrides by type are not valid JSON.");
  }
  if (!isRecord(parsed)) {
    throw new Error("The overrides by type must be an object by type name.");
  }
  for (const [typeName, fields] of Object.entries(parsed)) {
    if (!isRecord(fields)) {
      throw new Error(
        `The overrides of "${typeName}" must be an object of field texts.`,
      );
    }
    for (const [fieldId, text] of Object.entries(fields)) {
      if (typeof text !== "string") {
        throw new Error(
          `The override of "${fieldId}" for "${typeName}" must be text.`,
        );
      }
    }
  }
  return withoutBlanks(parsed as Record<string, Record<string, unknown>>);
}

/** The text Ajour stores: trimmed, blanks left out, and `""` when nothing is left. */
export function formatTypeOverrides(overrides: TypeOverrides): string {
  const kept = withoutBlanks(overrides);
  return Object.keys(kept).length > 0 ? JSON.stringify(kept) : "";
}

/**
 * The text a type uses for a field, or undefined when it uses the
 * connection's own. Type names match trimmed, in any case.
 */
export function typeOverrideFor(
  overrides: TypeOverrides,
  typeName: string,
  fieldId: string,
): string | undefined {
  const wanted = typeName.trim().toLowerCase();
  for (const [name, fields] of Object.entries(overrides)) {
    if (name.trim().toLowerCase() === wanted && fields[fieldId]) {
      return fields[fieldId];
    }
  }
  return undefined;
}
