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
just build
```

`just dev` rebuilds the bundle on every change. To try it in a development
build of Ajour, point Settings, Debug, at this folder.

The build bundles the plugin and [ical.js](https://github.com/kewisch/ical.js)
into `dist/plugin.js` with esbuild, because Ajour installs only `plugin.json`
and `dist/`.

## Build an installable plugin

```sh
just package
```

The archive is written to `package/ics-<version>.ajour-connector`. Its version
comes from `plugin.json`; keep it aligned with `package.json`.

Every push to `main` that changes this folder runs the tests and type
checks, stamps a prerelease version such as `0.1.0-main.130.9aac30e`, packages
the archive, keeps it as a GitHub Actions artifact for 30 days and publishes it
as a prerelease of this repository tagged `v0.1.0-ics.main.130.9aac30e`. See
[Releases](../../README.md#releases).

## Install in Ajour

In the desktop app, open **Settings, Plugins**, choose **Install plugin** and
select the `.ajour-connector` archive. Then add a connection with your
calendar's address.

## License

MIT. The bundle includes ical.js, under the Mozilla Public License 2.0; its
license notice and source link are at the top of `dist/plugin.js`.
