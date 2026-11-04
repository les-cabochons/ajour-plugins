# Ajour - ChronOps

This folder will hold the ChronOps plugin, which brings a person's projects,
budgets and tasks from MineHunter's ChronOps Grafana app into Ajour's
backlog. For now it holds the contract the plugin and MineHunter share.

## Contract

MineHunter's `GET /integration/ajour/snapshot` (PBI 337547) returns the
shape in [`contract/snapshot.schema.json`](contract/snapshot.schema.json).
MineHunter implements that file. A change to the shape bumps its `version`,
and the plugin refuses a version it does not know.

The contract is between the plugin and MineHunter only. Ajour never sees it.
the plugin maps it to Ajour's generic project source snapshot.

What the plugin expects of MineHunter's Forwarder, from its ADR-0030:

- Every request carries `X-ChronOps-Token: <personal token>` and
  `X-ChronOps-Source: ajour`. A missing or revoked token gets 401.
- `GET /integration/me` returns `{ email, login, scope, expiresAt }`, with
  `scope` either `read` or `read-write` and `expiresAt` an ISO date or null.
- `GET /integration/ajour/snapshot` returns the snapshot with an `ETag`, and
  304 when `If-None-Match` matches.
- The Forwarder limits each token to 10 requests a second.

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
without `X-ChronOps-Token` with 401, serves `/integration/me` with the scope
and expiry you choose, and answers 304 to a matching `If-None-Match`.

```sh
just fake
just fake --scope read-write --expires-at 2026-12-01T00:00:00Z
node contract/fake-minehunter.mjs --port 8787
```

It does not check `X-ChronOps-Source` and does not rate limit.

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and optionally `just`.

```sh
just verify
```

## License

[MIT](LICENSE)
