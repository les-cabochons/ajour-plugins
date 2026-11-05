import type {} from "@ajour/plugin-sdk/globals";
import type { PluginConnection, PluginModule } from "@ajour/plugin-sdk";
import { parseConnectorFieldValues } from "./contract.ts";
import { describeCalendar, listEvents, parseCalendar } from "./events.ts";
import { fetchCalendarFeed } from "./feed.ts";

/*
 * The plugin's entrypoint, loaded as an ES module in Ajour's sandboxed worker
 * (plugin API 4). Each export is one operation. The connection an operation
 * receives holds no secret: the calendar address stays with Ajour's broker,
 * which fetches it when the plugin asks `ajour.http` for the connection with an
 * empty path. The address never reaches this code.
 */

/** The optional email, lowercased. The calendar address is not here: it is secret. */
function readEmail(connection: PluginConnection) {
  const parsed = parseConnectorFieldValues(connection.config);
  const email =
    typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Your email is not a valid email address.");
  }
  return email;
}

/**
 * Fetches the calendar once, so a wrong address fails when it is saved. Ajour
 * keeps the address the user entered, so `normalizedConfig` holds the email
 * only.
 */
export const validateConnection: NonNullable<
  PluginModule["validateConnection"]
> = async (connection) => {
  const email = readEmail(connection);
  const root = parseCalendar(await fetchCalendarFeed(connection.id));
  const info = describeCalendar(root);
  const connectionSummary: Record<string, string | number> = {
    Events: info.eventCount,
  };
  if (info.name) connectionSummary.Calendar = info.name;
  if (info.timeZone) connectionSummary["Time zone"] = info.timeZone;
  const normalizedConfig: Record<string, string> = email ? { email } : {};
  return {
    normalizedConfig,
    connectionSummary,
  };
};

export const listCalendarEvents: NonNullable<
  PluginModule["listCalendarEvents"]
> = async (connection, request) => {
  const email = readEmail(connection);
  const root = parseCalendar(await fetchCalendarFeed(connection.id));
  return {
    events: listEvents(root, {
      ...request,
      email: email || undefined,
    }),
  };
};
