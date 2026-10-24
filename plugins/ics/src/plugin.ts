import {
  parseConnectorFieldValues,
  type CalendarListEventsRequest,
  type CalendarListEventsResult,
  type ConnectorFieldValues,
  type ConnectorPluginConnection,
  type ConnectorPluginValidationResult,
  type ConnectorSummaryValues,
} from "./contract.js";
import { describeCalendar, listEvents, parseCalendar } from "./events.js";
import { fetchCalendarFeed, normalizeCalendarAddress } from "./feed.js";

function readConfig(values: ConnectorFieldValues) {
  const parsed = parseConnectorFieldValues(values);
  const calendarUrl = normalizeCalendarAddress(parsed.calendarUrl);
  const email =
    typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Your email is not a valid email address.");
  }
  return { calendarUrl, email };
}

/** Fetches the calendar once, so a wrong address fails when it is saved. */
export async function validateConnection(
  config: ConnectorFieldValues,
): Promise<ConnectorPluginValidationResult> {
  const { calendarUrl, email } = readConfig(config);
  const root = parseCalendar(await fetchCalendarFeed(calendarUrl));
  const info = describeCalendar(root);
  const connectionSummary: ConnectorSummaryValues = {
    Events: info.eventCount,
  };
  if (info.name) connectionSummary.Calendar = info.name;
  if (info.timeZone) connectionSummary["Time zone"] = info.timeZone;
  return {
    normalizedConfig: { calendarUrl, ...(email ? { email } : {}) },
    connectionSummary,
  };
}

export async function listCalendarEvents(
  connection: ConnectorPluginConnection,
  request: CalendarListEventsRequest,
): Promise<CalendarListEventsResult> {
  const { calendarUrl, email } = readConfig(connection.config);
  const root = parseCalendar(await fetchCalendarFeed(calendarUrl));
  return {
    events: listEvents(root, {
      ...request,
      email: email || undefined,
    }),
  };
}
