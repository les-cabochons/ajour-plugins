import type { ConnectorPriorityLevel } from "./contract.js";

/**
 * Maps the numbers of the connection's priority field to Ajour's priority
 * levels. Each level holds one value ("1") or an inclusive range ("1-3").
 */

export const PRIORITY_LEVELS = ["urgent", "high", "medium", "low"] as const satisfies readonly ConnectorPriorityLevel[];

/** The connection field id that holds each level's values. */
export const PRIORITY_LEVEL_FIELD_IDS: Record<ConnectorPriorityLevel, string> = {
  urgent: "priorityUrgent",
  high: "priorityHigh",
  medium: "priorityMedium",
  low: "priorityLow",
};

/** Azure DevOps' standard priorities, 1 to 4. Matches plugin.json. */
export const DEFAULT_PRIORITY_LEVEL_VALUES: Record<ConnectorPriorityLevel, string> = {
  urgent: "1",
  high: "2",
  medium: "3",
  low: "4",
};

const LEVEL_LABELS: Record<ConnectorPriorityLevel, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

export interface PriorityRange {
  min: number;
  max: number;
}

/** A level without a range gets no source value. */
export type PriorityLevelRanges = Partial<Record<ConnectorPriorityLevel, PriorityRange>>;

const RANGE_PATTERN = /^(\d+)(?:\s*-\s*(\d+))?$/;

/**
 * Parses each level's text. An empty text leaves the level without a range.
 * Throws an error naming the level when a text is not a whole number or a
 * range, when min is above max, or when two levels overlap.
 */
export function parsePriorityLevelRanges(
  texts: Partial<Record<ConnectorPriorityLevel, string>>,
): PriorityLevelRanges {
  const ranges: PriorityLevelRanges = {};
  for (const level of PRIORITY_LEVELS) {
    const text = texts[level]?.trim();
    if (!text) {
      continue;
    }

    const match = RANGE_PATTERN.exec(text);
    if (!match) {
      throw new Error(
        `${LEVEL_LABELS[level]} priority "${text}" must be a whole number such as "1" or a range such as "1-3".`,
      );
    }

    const min = Number(match[1]);
    const max = match[2] === undefined ? min : Number(match[2]);
    if (min > max) {
      throw new Error(`${LEVEL_LABELS[level]} priority "${text}" starts above where it ends.`);
    }

    const overlapping = PRIORITY_LEVELS.find((other) => {
      const range = ranges[other];
      return range !== undefined && min <= range.max && range.min <= max;
    });
    if (overlapping) {
      throw new Error(
        `${LEVEL_LABELS[level]} priority "${text}" overlaps ${LEVEL_LABELS[overlapping]} priority.`,
      );
    }

    ranges[level] = { min, max };
  }
  return ranges;
}

/** The level whose range holds the value, or undefined. */
export function priorityLevelForValue(
  ranges: PriorityLevelRanges,
  value: number | undefined,
): ConnectorPriorityLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  return PRIORITY_LEVELS.find((level) => {
    const range = ranges[level];
    return range !== undefined && range.min <= value && value <= range.max;
  });
}

/** The lowest value of the level's range, the one a settle writes. */
export function priorityValueForLevel(
  ranges: PriorityLevelRanges,
  level: ConnectorPriorityLevel,
): number | undefined {
  return ranges[level]?.min;
}

export function priorityLevelLabel(level: ConnectorPriorityLevel) {
  return LEVEL_LABELS[level];
}
