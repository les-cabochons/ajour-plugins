// The plugin's view of Ajour's calendar contract, taken from the Ajour plugin
// SDK so a change to the contract fails the type check here instead of at
// runtime. See Ajour's developer docs, "Calendar API" page.
import type { CalendarOperations } from "@ajour/plugin-sdk";

export type ConnectorFieldValue = string | number | boolean;
export type ConnectorFieldValues = Record<string, ConnectorFieldValue>;

export type CalendarListEventsRequest =
  CalendarOperations["listCalendarEvents"]["request"];
export type CalendarEventFacts =
  CalendarOperations["listCalendarEvents"]["result"]["events"][number];
export type CalendarEventStatus = CalendarEventFacts["status"];
export type CalendarEventResponse = CalendarEventFacts["response"];

export const MAX_CALENDAR_EVENTS = 1_000;
export const MAX_CALENDAR_EVENT_TITLE_LENGTH = 200;

export function parseConnectorFieldValues(value: unknown): ConnectorFieldValues {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("The connection settings are invalid.");
  }
  const values: ConnectorFieldValues = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      values[key] = entry;
    }
  }
  return values;
}
