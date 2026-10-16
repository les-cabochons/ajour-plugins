import ICAL from "ical.js";
import {
  MAX_CALENDAR_EVENTS,
  MAX_CALENDAR_EVENT_TITLE_LENGTH,
  type CalendarEventFacts,
  type CalendarEventResponse,
  type CalendarEventStatus,
  type CalendarListEventsRequest,
} from "./contract.js";
import {
  addDays,
  isTimeZone,
  parseLocalDate,
  startOfDay,
  wallClockToEpoch,
} from "./zones.js";

type Component = InstanceType<typeof ICAL.Component>;
type IcalEvent = InstanceType<typeof ICAL.Event>;
type IcalTime = InstanceType<typeof ICAL.Time>;

/** Stops a runaway rule, such as one that repeats every minute for years. */
const MAX_OCCURRENCES_PER_SERIES = 100_000;

/**
 * Windows time zone names some Outlook and Exchange feeds use as TZID without
 * a VTIMEZONE. Feeds normally define their zones, so this list only covers
 * the common ones.
 */
const WINDOWS_ZONES: Record<string, string> = {
  "utc": "UTC",
  "gmt standard time": "Europe/London",
  "greenwich standard time": "Atlantic/Reykjavik",
  "w. europe standard time": "Europe/Berlin",
  "romance standard time": "Europe/Paris",
  "central europe standard time": "Europe/Budapest",
  "central european standard time": "Europe/Warsaw",
  "e. europe standard time": "Europe/Chisinau",
  "fle standard time": "Europe/Kiev",
  "eastern standard time": "America/New_York",
  "central standard time": "America/Chicago",
  "mountain standard time": "America/Denver",
  "us mountain standard time": "America/Phoenix",
  "pacific standard time": "America/Los_Angeles",
  "atlantic standard time": "America/Halifax",
  "newfoundland standard time": "America/St_Johns",
  "alaskan standard time": "America/Anchorage",
  "hawaiian standard time": "Pacific/Honolulu",
  "india standard time": "Asia/Kolkata",
  "china standard time": "Asia/Shanghai",
  "tokyo standard time": "Asia/Tokyo",
  "aus eastern standard time": "Australia/Sydney",
};

export interface ListEventsOptions extends CalendarListEventsRequest {
  /** The user's address, to find their reply and whether they organize. */
  email?: string;
}

export interface CalendarInfo {
  name?: string;
  timeZone?: string;
  eventCount: number;
}

export function parseCalendar(text: string): Component {
  let jcal: unknown;
  try {
    jcal = ICAL.parse(text);
  } catch {
    throw new Error("The calendar could not be read. It is not valid iCalendar data.");
  }
  const root = new ICAL.Component(jcal as never);
  if (root.name !== "vcalendar") {
    throw new Error("The address did not return a calendar.");
  }
  return root;
}

export function describeCalendar(root: Component): CalendarInfo {
  const name = stringValue(root.getFirstPropertyValue("x-wr-calname"));
  const timeZone = stringValue(root.getFirstPropertyValue("x-wr-timezone"));
  return {
    name: name || undefined,
    timeZone: timeZone || undefined,
    eventCount: root.getAllSubcomponents("vevent").length,
  };
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

/** A TZID as an IANA zone, when it names one. */
function resolveZoneName(tzid: unknown): string | undefined {
  if (typeof tzid !== "string" || !tzid.trim()) return undefined;
  const value = tzid.trim().replace(/^"|"$/g, "");
  // Cast so the type guard does not narrow `value` for the fallbacks below.
  if (isTimeZone(value as unknown)) return value;
  const windows = WINDOWS_ZONES[value.toLowerCase()];
  if (windows) return windows;
  // Prefixed forms such as "/mozilla.org/20050126_1/America/New_York".
  const segments = value.split("/").filter(Boolean);
  for (let start = 1; start < segments.length; start += 1) {
    const candidate = segments.slice(start).join("/");
    if (isTimeZone(candidate)) return candidate;
  }
  return undefined;
}

function propertyZone(component: Component, name: string) {
  return component.getFirstProperty(name)?.getParameter("tzid");
}

class Converter {
  constructor(
    /** The zone for floating times and all-day dates. */
    readonly requestZone: string,
    /** The calendar's own zone, X-WR-TIMEZONE, for floating times. */
    readonly calendarZone: string | undefined,
  ) {}

  /** A date-time to Unix milliseconds. `tzid` is the property's TZID. */
  dateTime(time: IcalTime, tzid: unknown): number {
    const zone = time.zone;
    if (zone && zone.tzid !== "floating") {
      // UTC, or a zone the feed defines in a VTIMEZONE.
      return time.toUnixTime() * 1000;
    }
    const name =
      resolveZoneName(tzid) ?? this.calendarZone ?? this.requestZone;
    return wallClockToEpoch(
      {
        year: time.year,
        month: time.month,
        day: time.day,
        hour: time.hour,
        minute: time.minute,
        second: time.second,
      },
      name,
    );
  }

  /** An all-day date to midnight in the user's zone. */
  date(time: IcalTime): number {
    return startOfDay(
      { year: time.year, month: time.month, day: time.day },
      this.requestZone,
    );
  }

  span(
    start: IcalTime,
    end: IcalTime | undefined,
    zones: { start: unknown; end: unknown },
  ) {
    if (start.isDate) {
      const startsAt = this.date(start);
      const endsAt = end?.isDate ? this.date(end) : undefined;
      return {
        allDay: true,
        startsAt,
        endsAt:
          endsAt !== undefined && endsAt > startsAt
            ? endsAt
            : startOfDay(
                addDays({ year: start.year, month: start.month, day: start.day }, 1),
                this.requestZone,
              ),
      };
    }
    const startsAt = this.dateTime(start, zones.start);
    const endsAt = end ? this.dateTime(end, zones.end ?? zones.start) : startsAt;
    return { allDay: false, startsAt, endsAt: Math.max(endsAt, startsAt) };
  }
}

function mailAddress(value: unknown) {
  return stringValue(value).replace(/^mailto:/i, "").toLowerCase();
}

function looksLikeEmail(value: string | undefined) {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

const RESPONSES: Record<string, CalendarEventResponse> = {
  ACCEPTED: "accepted",
  TENTATIVE: "tentative",
  DECLINED: "declined",
  "NEEDS-ACTION": "needsAction",
};

function attendance(component: Component, email: string | undefined) {
  const attendees = component.getAllProperties("attendee");
  const organizer = mailAddress(component.getFirstPropertyValue("organizer"));
  if (!email) {
    // Without attendees, the event is the user's own.
    return {
      response: (attendees.length === 0 ? "accepted" : "unknown") as CalendarEventResponse,
      isOrganizer: undefined,
    };
  }
  const isOrganizer = organizer === email;
  const own = attendees.find(
    (attendee) => mailAddress(attendee.getFirstValue()) === email,
  );
  const partstat = stringValue(own?.getParameter("partstat")).toUpperCase();
  let response: CalendarEventResponse;
  if (own) {
    response = RESPONSES[partstat] ?? (isOrganizer ? "accepted" : "needsAction");
  } else if (isOrganizer || attendees.length === 0) {
    response = "accepted";
  } else {
    response = "unknown";
  }
  return { response, isOrganizer };
}

function eventStatus(component: Component): CalendarEventStatus {
  const status = stringValue(component.getFirstPropertyValue("status")).toUpperCase();
  if (status === "CANCELLED") return "cancelled";
  if (status === "TENTATIVE") return "tentative";
  return "confirmed";
}

function isBusy(component: Component) {
  const transparency = stringValue(component.getFirstPropertyValue("transp")).toUpperCase();
  if (transparency === "TRANSPARENT") return false;
  const outlook = stringValue(
    component.getFirstPropertyValue("x-microsoft-cdo-busystatus"),
  ).toUpperCase();
  return outlook !== "FREE";
}

function eventTitle(component: Component) {
  const title = stringValue(component.getFirstPropertyValue("summary"))
    .replace(/\s+/g, " ")
    .trim();
  return title.length > MAX_CALENDAR_EVENT_TITLE_LENGTH
    ? `${title.slice(0, MAX_CALENDAR_EVENT_TITLE_LENGTH - 1)}…`
    : title;
}

/**
 * Every occurrence that overlaps the request's range, as facts. Cancelled
 * occurrences are included. Attendees, descriptions, locations and links are
 * never read into the result.
 */
export function listEvents(
  root: Component,
  options: ListEventsOptions,
): CalendarEventFacts[] {
  if (!isTimeZone(options.timeZone)) {
    throw new Error(`"${options.timeZone}" is not an IANA time zone.`);
  }
  const info = describeCalendar(root);
  const converter = new Converter(
    options.timeZone,
    isTimeZone(info.timeZone) ? info.timeZone : undefined,
  );
  const email = options.email?.trim().toLowerCase() ||
    (looksLikeEmail(info.name) ? info.name!.toLowerCase() : undefined);
  const rangeStart = startOfDay(parseLocalDate(options.from), options.timeZone);
  const rangeEnd = startOfDay(
    addDays(parseLocalDate(options.to), 1),
    options.timeZone,
  );
  const overlaps = (startsAt: number, endsAt: number) =>
    startsAt < rangeEnd && (endsAt > rangeStart || (endsAt === startsAt && startsAt >= rangeStart));

  const masters = new Map<string, IcalEvent>();
  const exceptions: IcalEvent[] = [];
  for (const component of root.getAllSubcomponents("vevent")) {
    try {
      const event = new ICAL.Event(component);
      if (!event.uid || !component.hasProperty("dtstart")) continue;
      if (event.isRecurrenceException()) {
        exceptions.push(event);
      } else if (!masters.has(event.uid)) {
        masters.set(event.uid, event);
      }
    } catch {
      // One malformed event must not hide the rest of the calendar.
    }
  }
  for (const exception of exceptions) {
    const master = masters.get(exception.uid);
    if (master?.isRecurring()) master.relateException(exception);
  }

  const facts: CalendarEventFacts[] = [];
  const add = (
    component: Component,
    uid: string,
    seriesId: string | undefined,
    span: { allDay: boolean; startsAt: number; endsAt: number },
    statusSource: Component = component,
  ) => {
    if (!overlaps(span.startsAt, span.endsAt)) return;
    facts.push({
      eventId: uid,
      ...(seriesId ? { seriesId } : {}),
      startsAt: span.startsAt,
      endsAt: span.endsAt,
      allDay: span.allDay,
      title: eventTitle(component),
      status:
        eventStatus(statusSource) === "cancelled"
          ? "cancelled"
          : eventStatus(component),
      ...attendance(component, email),
      busy: isBusy(component),
    });
  };
  const zonesOf = (component: Component) => ({
    start: propertyZone(component, "dtstart"),
    end: propertyZone(component, "dtend") ?? propertyZone(component, "dtstart"),
  });

  for (const master of masters.values()) {
    try {
      const component = master.component;
      if (!master.isRecurring()) {
        add(
          component,
          master.uid,
          undefined,
          converter.span(master.startDate, master.endDate, zonesOf(component)),
        );
        continue;
      }
      const zones = zonesOf(component);
      const iterator = master.iterator();
      for (let count = 0; count < MAX_OCCURRENCES_PER_SERIES; count += 1) {
        const next = iterator.next();
        if (!next) break;
        const details = master.getOccurrenceDetails(next);
        // Moved and changed occurrences are added from their own component below.
        if (details.item !== master) continue;
        const span = converter.span(details.startDate, details.endDate, zones);
        if (span.startsAt >= rangeEnd) break;
        add(component, master.uid, master.uid, span);
      }
    } catch {
      // Skip a series ical.js cannot expand rather than fail the calendar.
    }
  }

  for (const exception of exceptions) {
    try {
      const master = masters.get(exception.uid);
      add(
        exception.component,
        exception.uid,
        exception.uid,
        converter.span(
          exception.startDate,
          exception.endDate,
          zonesOf(exception.component),
        ),
        master?.component ?? exception.component,
      );
    } catch {
      // Same as above.
    }
  }

  return facts
    .sort((left, right) => left.startsAt - right.startsAt || left.eventId.localeCompare(right.eventId))
    .slice(0, MAX_CALENDAR_EVENTS);
}
