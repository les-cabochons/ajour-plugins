// A copy of the parts of Ajour's plugin contract this plugin uses. Ajour has
// no SDK package, so plugins keep their own copy and never import Ajour code.
// Reference: Ajour developer docs, "Calendar API" and "Connector API" pages.

export type ConnectorFieldValue = string | number | boolean;
export type ConnectorFieldValues = Record<string, ConnectorFieldValue>;
export type ConnectorSummaryValues = Record<string, string | number | boolean>;

export interface ConnectorPluginConnection {
  id: string;
  pluginId: string;
  label: string;
  tenantLabel: string;
  autoSync: boolean;
  autoSyncIntervalMinutes: number;
  connectedAt: number;
  lastSyncAt?: number;
  lastError?: string;
  config: ConnectorFieldValues;
}

export interface ConnectorPluginValidationResult {
  normalizedConfig: ConnectorFieldValues;
  connectionSummary: ConnectorSummaryValues;
}

export interface CalendarListEventsRequest {
  /** The first local date of the range, YYYY-MM-DD. */
  from: string;
  /** The last local date of the range, included. */
  to: string;
  /** The user's IANA time zone, for floating times and all-day dates. */
  timeZone: string;
}

export type CalendarEventStatus = "confirmed" | "tentative" | "cancelled";
export type CalendarEventResponse =
  | "accepted"
  | "tentative"
  | "declined"
  | "needsAction"
  | "unknown";

export interface CalendarEventFacts {
  eventId: string;
  seriesId?: string;
  /** Unix milliseconds. */
  startsAt: number;
  /** Unix milliseconds, not before `startsAt`. */
  endsAt: number;
  allDay: boolean;
  title: string;
  status: CalendarEventStatus;
  response: CalendarEventResponse;
  busy: boolean;
  isOrganizer?: boolean;
}

export interface CalendarListEventsResult {
  events: CalendarEventFacts[];
}

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
