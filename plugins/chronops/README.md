# Ajour - ChronOps

Brings a person's ChronOps projects, tasks, assignments and budgets into
Ajour, read-only, through MineHunter's ChronOps Forwarder. Plugin API 4,
capability `projectSource` (les-cabochons/ajour#502). Ajour keeps the
projects in step with ChronOps and shows the budget next to the hours it
knows. Time still goes to the timesheet tool as before.

## Connection

| Field | What it is |
| --- | --- |
| Forwarder URL | MineHunter's ChronOps Forwarder. The default is production. |
| Personal token | A token from your ChronOps profile, with the read scope. Ajour's broker sends it as `X-ChronOps-Token` and the plugin never sees it. |

Saving the connection calls `GET /integration/me` and shows the token's
email, scope and expiry date. A read-write token works but gets a warning,
since Ajour only reads.

## What Ajour gets

Every sync calls `GET /integration/ajour/snapshot` with the last `ETag` in
`If-None-Match`, so an unchanged snapshot costs one 304. The plugin maps
MineHunter's answer to Ajour's generic snapshot:

| ChronOps | Ajour |
| --- | --- |
| project `code` | `remoteId` and `code`, and the link to the project in ChronOps |
| `contractStart`, `contractEnd` | `startsOn`, `endsOn` |
| monthly budget | hours, `capHours` consumed and remaining |
| annual budget | money, `maxBudget` and `spentBudget`, or hours when ChronOps has no money figures |
| budget `status` Unconfigured | no budget |
| task `id`, `phase`, `assignedToMe` | `remoteId`, `group`, `assigned` |
| `reportAt` | `asOf`, the moment the figures are from |
| `me.workerLinked` | whether Ajour can compare your hours, with a note on linking your Workday name otherwise |

A name, client or phase longer than Ajour accepts is cut, with an
ellipsis. A project code or task id longer than 100 characters, more than
200 projects or more than 10,000 tasks fail the sync with a message, since
Ajour would refuse the snapshot.

Each failure is one message on the connection page, with no retry: a
revoked or expired token (401), a forbidden request (403, with the
Forwarder's reason), the Forwarder's limit of 10 requests a second (429), a
snapshot of a version the plugin does not read, and a Forwarder that cannot
be reached.

## Contract

MineHunter's `GET /integration/ajour/snapshot` (PBI 337547) returns the
shape in [`contract/snapshot.schema.json`](contract/snapshot.schema.json).
MineHunter implements that file. A change to the shape bumps its `version`,
and the plugin refuses a version it does not know.

The contract is between the plugin and MineHunter only. Ajour never sees it.
The plugin maps it to Ajour's generic project source snapshot.

What the plugin expects of MineHunter's Forwarder, from its ADR-0030:

- Every request carries `X-ChronOps-Token: <personal token>` and
  `X-ChronOps-Source: ajour`. A missing, revoked or expired token gets 401.
- `GET /integration/me` returns `{ email, login, scope, expiresAt }`, with
  `scope` either `read` or `read-write` and `expiresAt` an ISO date or null.
- `GET /integration/ajour/snapshot` returns the snapshot with an `ETag`, and
  304 when `If-None-Match` matches.
- A read token gets 403 on anything but `GET`.
- The Forwarder limits each caller to 10 requests a second.

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
fixture the way MineHunter will, for the plugin's tests and for trying the
plugin against Ajour before MineHunter ships the route. It refuses a request
without `X-ChronOps-Token` with 401, as it does one past the expiry you
choose, answers 403 to a write with a read token, serves `/integration/me`
with the scope and expiry you choose, and answers 304 to a matching
`If-None-Match`.

```sh
just fake
just fake --scope read-write --expires-at 2026-12-01T00:00:00Z
node contract/fake-minehunter.mjs --port 8787
```

It does not check `X-ChronOps-Source` and does not rate limit.

To try the plugin in a development build of Ajour, point
`AJOUR_DEV_PLUGIN_DIRS` at this folder, run `just fake`, and add a
connection with `http://127.0.0.1:8787` as the Forwarder URL, marked
on-premises, and any text as the token.

A live check against MineHunter's real route is still to do, once the route
ships.

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
`node --test`. [`src/contract.ts`](src/contract.ts) is the plugin's copy of
the parts of Ajour's plugin API 4 it uses, as the other plugins keep theirs.

## License

[MIT](LICENSE)
