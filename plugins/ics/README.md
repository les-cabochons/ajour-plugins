# Ajour Plugin - ICS calendar

Shows the meetings in your calendar as suggestions in Ajour's Time view, so you
can add them as time entries. It reads the calendar's private ICS address,
which Google Calendar, Outlook and Exchange all publish, so one plugin covers
the three without signing in. It never writes to the calendar.

The plugin declares Ajour's `calendar` capability and exports
`validateConnection` and `listCalendarEvents`. See the Calendar API page in
Ajour's developer docs.

The plugin runs on **plugin API 4**: it runs in a sandboxed worker with no
network, disk or Node access. The calendar address is a *secret address*, the
connection's whole address. The plugin asks Ajour's broker for the connection
with a GET and an empty path, and the broker fetches the address the user saved,
turns `webcal://` into `https://`, follows up to three https redirects to any
host and hands back the status, the headers and the body. The plugin never sees
the address, the host it ended at, or a redirect.

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
"Unpublish" in Outlook. Ajour keeps it in its vault as a secret connection
value, never passes it to the plugin and keeps it out of logs and error
messages. Ajour refuses an address that holds a user name or a password.

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
  download, is refused. Ajour's broker refuses an answer over 8 MB and a request
  over 20 seconds before the plugin sees them; the plugin refuses a feed over
  5 MB itself.
- The address must be https (or webcal). Ajour's broker refuses a redirect to a
  plain http address, or after the third, and the plugin shows the broker's
  message.
- Time zones come from the calendar's own definitions. A zone named without a
  definition is read as an IANA name, or as one of the common Windows names.
  Times without a zone use the calendar's zone, then yours.

## Development

Requirements: Node.js 24 (for the tests; the plugin itself runs in Ajour's
worker), Corepack with pnpm 10.7.0, and `just` (optional).

```sh
just install
just test
just typecheck
just verify
```

The plugin runs from its TypeScript source. Ajour serves each `.ts` file to
the worker with its types stripped, so there is nothing to build. The source is
erasable TypeScript only, imports types with `import type`, imports its own
files with a relative path and their extension, and imports nothing else at
runtime: nothing resolves a bare import in the worker. `just verify` runs the
tests and the type checks; from the repository root, `just verify ics` also
imports the plugin in plain Node, from only the files it publishes. The import
loads the entrypoint without calling an operation, so it needs no `ajour`
global. To try it in a development build of Ajour, point Settings, Debug, at
this folder.

`just typecheck` checks the source with the rules type stripping sets, and
without Node types, so `Buffer` or `process` in the source fails the type
check. The tests also fail on a `fetch(`, `require(`, `node:` import,
`process`, `Buffer`, `Authorization` or the address field's name in the code,
comments and strings aside. They load `src/plugin.ts` with a frozen `ajour`
global and a stand-in broker, as the worker does.

## The Ajour SDK

The tests use `createFakeAjour` from `@ajour/plugin-sdk`, which refuses what
Ajour's broker would: a request that is not a GET with an empty path, or a
header that `plugin.json` does not list. The SDK is not on npm yet, so the
repository vendors the packed package in [`vendor/`](../../vendor/README.md),
and the plugin installs it as a `file:` dev dependency, for types and the fake
only. Once it is published, swap the dependency for a version range.

Ajour installs no dependencies, so [ical.js](https://github.com/kewisch/ical.js)
2.2.1 is vendored, unchanged, in `src/vendor/ical.js`. It is one plain ES
module with no imports and no Node use, which `events.ts` imports by relative
path; a test checks it. `src/vendor/ical.d.ts`
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

Until the release that switches every plugin to API 4, Ajour admits an API 4
package in development builds only.

## What the plugin may call

`plugin.json` declares the calendar address as a secret address
(`network.auth`: `secretAddress`, field `calendarUrl`) and the `Accept` request
header. It declares no base address, endpoints or hosts: the broker fetches the
connection's address with a GET and an empty path, and nothing else. Ajour shows
this in the plugin's Access section. The plugin loads when needed
(`runtime.start`).

## License

MIT. `src/vendor/ical.js` is ical.js 2.2.1, under the Mozilla Public License
2.0, from https://github.com/kewisch/ical.js. Its license text is in
`src/vendor/ical.js.LICENSE`, which the plugin publishes with it.
