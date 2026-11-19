# Ajour - ChronOps

Brings a person's ChronOps projects, tasks, assignments and budgets into
Ajour through MineHunter's ChronOps Forwarder. Plugin API 4, capabilities
`projectSource` (les-cabochons/ajour#502) and `timeSync`
(les-cabochons/ajour#685). Ajour keeps the projects in step with ChronOps
and shows the budget next to the hours it knows. With the connection's Time
entries switch on, Ajour also sends the person's time entries to ChronOps
Time Entries and reads back the ones logged elsewhere. Time still goes to
the timesheet tool only through Commit and Submit week.

## Connection

| Field | What it is |
| --- | --- |
| Forwarder URL | MineHunter's ChronOps Forwarder. The default is production. |
| Personal token | A token from your ChronOps profile. The read scope is enough for projects and budgets. Time entries need the read-write scope. Ajour's broker sends it as `X-ChronOps-Token` and the plugin never sees it. |

Saving the connection calls `GET /integration/me` and shows the token's
email, scope and expiry date. While Time entries is on, or being turned on,
a read token is refused with a sentence that asks for a read-write token,
and the switch stays off.

## What Ajour gets

Every sync calls `GET /integration/snapshot` with the last `ETag` in
`If-None-Match`, so an unchanged snapshot costs one 304. ChronOps builds the
snapshot from its copies of Chronops' answers. A sync you ask for, Sync now
or opening a ChronOps project in Ajour, adds `sync=true`, so ChronOps asks
Chronops again and a project you were just added to shows. The 15-minute
sync uses the copies and lets Chronops sleep. Ajour sends whether you asked
since les-cabochons/ajour#686; an older Ajour never adds `sync=true`.

The plugin maps MineHunter's answer to Ajour's generic snapshot:

| ChronOps | Ajour |
| --- | --- |
| project `code` | `remoteId` and `code`, and the link to the project in ChronOps |
| `contractStart`, `contractEnd` | `startsOn`, `endsOn` |
| `complete` | `complete`, and not complete when ChronOps cannot tell |
| monthly budget | hours, `capHours` consumed and remaining |
| annual budget | money, `maxBudget` and `spentBudget`, or hours when ChronOps has no money figures |
| no cap (`capHours` null, status Unconfigured) | no budget |
| task `id`, `assignedToMe` | `remoteId`, `assigned` |
| task `budgetHours`, else `estimateHours` over 0 | `estimateHours`, the task's budget, as ChronOps shows it (its ADR-0047) |
| task `workedHours` plus `workedHoursAdjustment` | `workedHours`, everyone's hours on the task, all time, never below 0. Ajour adds your hours it doesn't have yet and your own adjustment |
| `myHours` | `myHours`, the current month only, with `me.hoursSince` the first of the report's month |
| monthly budget period | `budget.since`, the first of the report's month; an annual budget has none, since ChronOps gives no start |
| `reportAt` | `asOf`, the moment the figures are from |
| `me.workerLinked` | whether Ajour can compare your hours, with a note on linking your Workday name otherwise |

A name or client longer than Ajour accepts is cut, with an
ellipsis. A blank project name falls back to the code, and a blank task
name to the task id. A blank project code or task id fails the sync, since
Ajour links by them. An `ETag` that is empty or longer than 2,000
characters is not kept as the cursor, so the next sync reads everything. A project code or task id longer than 100 characters, more than
200 projects or more than 10,000 tasks fail the sync with a message, since
Ajour would refuse the snapshot.
A project whose ChronOps link would pass Ajour's 500 characters, which only
a long code with accented letters can do, has no link in Ajour.

Each failure is one message on the connection page, with no retry: a
revoked or expired token (401), a forbidden request (403, with the
Forwarder's reason), the Forwarder's limit of 10 requests a second (429), a
snapshot of a version the plugin does not read, and a Forwarder that cannot
be reached.

## Time entries

Time entries starts off. While it is on, each round Ajour runs calls
`syncTimeEntries` with at most 20 changes, a window of local dates and the
user's time zone. The plugin applies the changes in order, then lists the
window.

ChronOps keeps an entry as a start and an end. Ajour keeps a day and whole
minutes, and no start. So:

- **A new entry** is a `POST /integration/entries` with Ajour's sync key as
  `clientRef`. It starts at 09:00 on its day in the user's time zone, or a
  minute before now when that is earlier, since ChronOps refuses a start in
  the future. It lasts its minutes. ChronOps answers 201, or 200 when it
  already holds the entry Ajour created under that key, such as after a lost
  answer. Ajour's values then win: the plugin PATCHes what differs.
- **An edit** is a `PATCH /integration/entries/{id}` with only what differs
  from the values both sides last agreed on: the project, the task, the
  minutes, and a new 09:00 start only when the day changed. So ChronOps keeps
  a real start, such as a timer's, while the day stays the same. An edit
  answered 404 creates the entry again.
- **A delete** is a `DELETE /integration/entries/{id}`. ChronOps deletes for
  good, so a 404 means it is already gone. A delete Ajour has no id for finds
  the entry by its client reference in the window.

Each change gets a result. A ChronOps validation answer, such as an entry
over 24 hours or a task over 200 characters, is `refused` with ChronOps'
message, and Ajour shows it until the entry changes. A 409, which a
concurrent request with the same client reference gets, a 429, a 5xx or a
network error is `failed`, and Ajour sends the change again next round. Once
ChronOps can't be reached, the round's other changes fail without a request.
A refused token (401) or a forbidden request (403) fails the whole round, as
does a listing that fails.

The listing is `GET /integration/entries` from midnight on the window's
first day to midnight after its last, in the user's time zone. It holds the
entries of every source, My time and the Azure DevOps extension included,
and the running timer wherever it started. Each becomes a remote entry: the
local date of its start, whole minutes, the project code as the project's
remote id, the task name, `updatedAt`, and `clientRef` on Ajour's own
entries only. A running timer has the minutes since its start and that start
as `countingSince`. An entry whose project code or task Ajour can't hold is
left out. The description, the owner's email and the work item never leave
the plugin, and Ajour never sends a note. ChronOps lists at most 2,000
entries, the newest first. A listing that long fails the round, since the
entries it leaves out would look deleted to Ajour.

A round stays under the Forwarder's limit of 10 requests a second with a
burst of 20: it sends 10 requests at once, then 8 a second. A full round of
20 changes needs at most 62 requests, about 7 seconds.

Running entries, Stop and Continue come in a later version
(les-cabochons/ajour-plugins#37). Until then a change for a running entry is
`failed`, and Ajour doesn't send one.

## Contract

MineHunter's `GET /integration/snapshot` (PBI 337547) returns the
shape in [`contract/snapshot.schema.json`](contract/snapshot.schema.json).
MineHunter owns the contract and serves the same snapshot to every
integration: the route has no consumer in its path, and
`X-ChronOps-Source: ajour` only says who asks. The file here is the plugin's
copy of MineHunter's `plugins/chronops/contract/snapshot.schema.json`. A
change to the shape bumps its `version`, and the plugin refuses a version it
does not know. It reads versions 2 and 3, so it works before and after
MineHunter moves to version 3: a version 2 task has no budget of its own and
no worked hours, so Ajour shows Workday's estimate and its own time.

Ajour never sees the contract. The plugin maps it to Ajour's generic project
source snapshot.

What the plugin expects of MineHunter's Forwarder, from its ADR-0030:

- Every request carries `X-ChronOps-Token: <personal token>` and
  `X-ChronOps-Source: ajour`. A missing, revoked or expired token gets 401.
- `GET /integration/me` returns `{ email, login, scope, expiresAt }`, with
  `scope` either `read` or `read-write` and `expiresAt` an ISO date or null.
- `GET /integration/snapshot` returns the snapshot with an `ETag`, and
  304 when `If-None-Match` matches.
- A read token gets 403 on anything but `GET`.
- The Forwarder limits each address to 10 requests a second, with a burst of
  20.

For Time entries, MineHunter's Time Entry routes since its client reference
change, under `/integration`:

- `GET /entries?from=&to=` lists the person's entries started in
  `[from, to)`, newest first, at most 2,000, and their running timer
  wherever it started. The range is at most 93 days.
- `POST /entries` adds a finished entry: `workdayProject`, `task`,
  `startedAt`, `minutes` (1 to 1,440) and `clientRef`. It answers 201, or 200
  with the stored entry, unchanged, for a client reference the same source
  already used. A concurrent request with the same reference gets 409.
- `PATCH /entries/{id}` changes the project, task, start or minutes. Moving
  the start keeps the length. A start after ChronOps' clock is refused.
- `DELETE /entries/{id}` deletes for good and frees the client reference.
- Every entry carries `clientRef`, null when none, and `updatedAt`. A
  refusal is 400 with `{ "error": "..." }`. `workdayProject` is the code the
  snapshot gives the project.

[`contract/fixture.json`](contract/fixture.json) is a valid snapshot: three
projects, monthly, annual and one without a cap, with assigned, unassigned
and closed tasks. The tests check it against the schema.

### Version history

- Version 2. `complete`, `capHours` and `remainingHours` became nullable,
  for what ChronOps cannot tell. `myHours` is the current month only, and
  `assignedToMe` no longer depends on the worker link.
- Version 1. First shape.

## Fake MineHunter

[`contract/fake-minehunter.mjs`](contract/fake-minehunter.mjs) serves the
fixture the way MineHunter does, for the plugin's tests and for trying the
plugin against Ajour without MineHunter. It refuses a request without
`X-ChronOps-Source` with 400 and one without `X-ChronOps-Token` with 401, as
it does one past the expiry you choose, answers 403 to a write with a read
token, serves `/integration/me` with the scope and expiry you choose, and
answers 304 to a matching `If-None-Match`. It keeps Time Entries in memory
and serves the Time Entry routes above with MineHunter's validation and
messages. The tests can seed its entries and turn on the Forwarder's rate
limit.

```sh
just fake
just fake --scope read-write --expires-at 2026-12-01T00:00:00Z
node contract/fake-minehunter.mjs --port 8787
```

It has no timer routes, and limits the rate only when a test asks.

To try the plugin in a development build of Ajour, point
`AJOUR_DEV_PLUGIN_DIRS` at this folder, run `just fake`, and add a
connection with `http://127.0.0.1:8787` as the Forwarder URL, marked
on-premises, and any text as the token.

A live check against MineHunter's real routes is still to do, once they
ship. The Time Entry routes with `clientRef` and `updatedAt` come with
MineHunter's client reference change, which Time entries needs.

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and optionally `just`.

```sh
just install
just test
just typecheck
just verify
```

`just test` runs the plugin's vitest suites, which stub Ajour's `ajour`
global and talk to the fake MineHunter over HTTP, then the contract tests on
`node --test`. The plugin takes Ajour's types from `@ajour/plugin-sdk` 0.2.0,
vendored in the repository's [`vendor/`](../../vendor), as types only, since
Ajour installs no dependencies. [`src/contract.ts`](src/contract.ts) keeps the
few values of Ajour's contract the plugin needs at run time, such as its
bounds.

## License

[MIT](LICENSE)
