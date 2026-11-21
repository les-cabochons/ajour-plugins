import {
  formatTypeOverrides as sdkFormat,
  parseTypeOverrides as sdkParse,
  typeOverrideFor as sdkLookup,
} from "@ajour/plugin-sdk";
import { describe, expect, it } from "vitest";
import {
  formatTypeOverrides,
  parseTypeOverrides,
  typeOverrideFor,
} from "../src/type-overrides.ts";

/** The parsed value, or the message it throws. */
function outcome(parse: (value: unknown) => unknown, value: unknown) {
  try {
    return { value: parse(value) };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

describe("the plugin's copy of the SDK's typeOverrides parser", () => {
  it("reads, formats and looks up a stored value as the SDK does", () => {
    const values: unknown[] = [
      undefined,
      "",
      '{" Task ":{"originalEstimateFieldName":" Original Estimate ","completedEstimateFieldName":""}}',
      '{"Bug":{"remainingEstimateFieldName":""}}',
      "[]",
      "{",
      '{"Task":3}',
      '{"Task":{"originalEstimateFieldName":3}}',
      7,
    ];
    for (const value of values) {
      expect(outcome(parseTypeOverrides, value), String(value)).toEqual(
        outcome(sdkParse, value),
      );
    }

    const overrides = parseTypeOverrides(values[2]);
    expect(formatTypeOverrides(overrides)).toBe(sdkFormat(overrides));
    expect(typeOverrideFor(overrides, " task", "originalEstimateFieldName"))
      .toBe("Original Estimate");
    expect(
      typeOverrideFor(overrides, " task", "originalEstimateFieldName"),
    ).toBe(sdkLookup(overrides, " task", "originalEstimateFieldName"));
  });
});
