# Ajour Plugin - ICS calendar

Shows the meetings in your calendar as suggestions in Ajour's Time view, so you
can add them as time entries. It reads the calendar's private ICS address,
which Google Calendar, Outlook and Exchange all publish, so one plugin covers
the three without signing in. It never writes to the calendar.

The plugin declares Ajour's `calendar` capability and exports
`validateConnection` and `listCalendarEvents`. See the Calendar API page in
Ajour's developer docs.

## Get your calendar's address

- **Google Calendar.** Settings, then your calendar under "Settings for my
  calendars", then "Integrate calendar". Copy "Secret address in iCal format".
- **Outlook and Microsoft 365.** Settings, Calendar, Shared calendars. Under
  "Publish a calendar", pick the calendar and "Can view all details", then
  publish and copy the ICS link. Your organization may have turned publishing
  off.
- **Exchange in your organization.** In Outlook on the web, the same "Publish a
  calendar" setting, if your administrator allows it.

The address works without a password. Anyone who has it can read your whole
calendar until you reset it: "Reset private URLs" in Google Calendar,
"Unpublish" in Outlook. Ajour stores it as a secret connection value and keeps
it out of logs and error messages.

Add **Your email** to the connection if your calendar lists attendees. The
plugin uses it to find your own reply, so Ajour can hide meetings you declined.
For a Google calendar, the plugin falls back to the calendar's name, which is
your email.

## What reaches Ajour

For each occurrence in the requested days: the event's id, its series id when
it repeats, start, end, whether it is all-day, the title, the status, your
reply, whether it blocks time, and whether you organize it. Nothing else.
Attendees, descriptions, locations and meeting links stay in the plugin.

## Known limits

- Google serves the secret address from a cache. New and changed events can
  take several hours to appear.
- Outlook's published calendars often leave out attendees, so your reply shows
  as unknown.
- A calendar larger than 5 MB, or one that takes more than 20 seconds to
  download, is refused.
- Time zones come from the calendar's own definitions. A zone named without a
  definition is read as an IANA name, or as one of the common Windows names.
  Times without a zone use the calendar's zone, then yours.

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and `just` (optional).

```sh
just install
just test
just typecheck
just verify
```

The plugin runs from its TypeScript source. Ajour imports `src/plugin.ts`
directly, so there is nothing to build. `just verify` runs the tests and the
type checks; from the repository root, `just verify ics` also imports the
plugin in plain Node, from only the files it publishes. To try it in a
development build of Ajour, point Settings, Debug, at this folder.

Ajour installs no dependencies, so [ical.js](https://github.com/kewisch/ical.js)
2.2.1 is vendored, unchanged, in `src/vendor/ical.js`. `src/vendor/ical.d.ts`
takes its types from the `ical.js` devDependency, so keep the two on the same
version. To update it, copy `dist/ical.js` from the new ical.js package over
`src/vendor/ical.js`, and change the version in `package.json` and in
`src/vendor/ical.js.LICENSE`.

The plugin is released through the repository's `ajour.json`. When you
change it, bump the version in `plugin.json` and `package.json`. See
[Releases](../../README.md#releases).

## Install in Ajour

Ajour lists the plugin from the official plugin source. To try a local
change, run `just package ics` from the repository root. Then in Ajour open
**Settings, Plugins**, choose **Install from file** and select
`plugins/ics/package/ics-<version>.ajour-connector`. Then add a connection
with your calendar's address.

## License

MIT. `src/vendor/ical.js` is ical.js 2.2.1, under the Mozilla Public License
2.0, from https://github.com/kewisch/ical.js. Its license text is in
`src/vendor/ical.js.LICENSE`, which the plugin publishes with it.
