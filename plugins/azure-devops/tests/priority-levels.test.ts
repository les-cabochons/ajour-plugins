import { describe, expect, it } from "vitest";
import { parsePriorityValue } from "../src/azure-devops.ts";
import {
  DEFAULT_PRIORITY_LEVEL_VALUES,
  parsePriorityLevelRanges,
  priorityLevelForValue,
  priorityValueForLevel,
} from "../src/priority-levels.ts";

describe("priority level ranges", () => {
  it("maps Azure DevOps' standard priorities 1 to 4 by default", () => {
    const ranges = parsePriorityLevelRanges(DEFAULT_PRIORITY_LEVEL_VALUES);

    expect([1, 2, 3, 4].map((value) => priorityLevelForValue(ranges, value))).toEqual([
      "urgent",
      "high",
      "medium",
      "low",
    ]);
  });

  it("maps a value inside an inclusive range and gives no level outside every range", () => {
    const ranges = parsePriorityLevelRanges({ urgent: "1-3", high: " 4 - 6 ", low: "" });

    expect(priorityLevelForValue(ranges, 1)).toBe("urgent");
    expect(priorityLevelForValue(ranges, 3)).toBe("urgent");
    expect(priorityLevelForValue(ranges, 6)).toBe("high");
    expect(priorityLevelForValue(ranges, 7)).toBeUndefined();
    expect(priorityLevelForValue(ranges, undefined)).toBeUndefined();
  });

  it("writes the lowest value of a level's range, and nothing for a level without values", () => {
    const ranges = parsePriorityLevelRanges({ urgent: "1-3", high: "4-6" });

    expect(priorityValueForLevel(ranges, "high")).toBe(4);
    expect(priorityValueForLevel(ranges, "low")).toBeUndefined();
  });

  it.each([
    [{ high: "two" }, 'High priority "two" must be a whole number'],
    [{ medium: "-1" }, 'Medium priority "-1" must be a whole number'],
    [{ low: "1.5" }, 'Low priority "1.5" must be a whole number'],
    [{ urgent: "5-2" }, 'Urgent priority "5-2" starts above where it ends'],
    [{ urgent: "1-3", high: "3-5" }, 'High priority "3-5" overlaps Urgent priority'],
    [{ urgent: "10", low: "1-20" }, 'Low priority "1-20" overlaps Urgent priority'],
    [{ low: "1-99999999999999999999" }, 'Low priority "1-99999999999999999999" is too large'],
  ])("rejects %j", (texts, message) => {
    expect(() => parsePriorityLevelRanges(texts)).toThrow(message);
  });
});

describe("priority field values", () => {
  it("keeps whole numbers, from numbers or picklist text, and drops fractions", () => {
    expect(parsePriorityValue(2)).toBe(2);
    expect(parsePriorityValue(" 3 ")).toBe(3);
    expect(parsePriorityValue(1.5)).toBeUndefined();
    expect(parsePriorityValue("1.5")).toBeUndefined();
    expect(parsePriorityValue("")).toBeUndefined();
  });
});
