# Vendored packages

`ajour-plugin-sdk-0.1.0.tgz` is `@ajour/plugin-sdk` 0.1.0, packed from
`packages/plugin-sdk` in `les-cabochons/ajour` at commit
`33c0a326401ac42ed44dcc5a8bd6efd0ebcd9725` (origin/main on 2026-11-04, after #566).
This includes #566's assignee contracts, #572's sync viewer and assignee facts,
task properties, and the optional source IDs on `syncConnection`. The SDK's
upstream version is still 0.1.0, so the filename stays the same and the lockfile
integrity changes.

`ajour-plugin-sdk-0.2.0.tgz` is `@ajour/plugin-sdk` 0.2.0, packed at commit
`436b146e5fbc8ce4a36fc4a61ec722fa8831880f` (origin/main on 2026-11-16, after
#747): `tsc -p tsconfig.build.json` in `packages/plugin-sdk`, then
`npm pack --ignore-scripts`. It adds the `processes` block, `ajour.process.run`,
`ajour.open`, the handoff capability, handoff tools that use a connection, and
process sessions (`mode: "session"`, `ajour.process.session` and the fake's
`processSession`). The SDK's version is still 0.2.0, so the filename stays the
same and the lockfile integrity changes. Only `agent-handoff` uses it so far.

The SDK is not on npm yet. Plugins install it as a
`file:../../vendor/ajour-plugin-sdk-<version>.tgz` dev dependency.

To refresh it, from an Ajour checkout:

```sh
corepack pnpm install --frozen-lockfile
cd packages/plugin-sdk
corepack pnpm pack --pack-destination <this repository>/vendor
```

Then point each plugin's `package.json` at the new file, run `just install`,
and update the commit above. Once the SDK is published, swap the `file:`
dependencies for a version range and delete this folder.
