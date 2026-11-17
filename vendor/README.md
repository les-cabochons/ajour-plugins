# Vendored packages

`ajour-plugin-sdk-0.1.0.tgz` is `@ajour/plugin-sdk` 0.1.0, packed from
`packages/plugin-sdk` in `les-cabochons/ajour` at commit
`33c0a326401ac42ed44dcc5a8bd6efd0ebcd9725` (origin/main on 2026-11-04, after #566).
This includes #566's assignee contracts, #572's sync viewer and assignee facts,
task properties, and the optional source IDs on `syncConnection`. The SDK's
upstream version is still 0.1.0, so the filename stays the same and the lockfile
integrity changes.

`ajour-plugin-sdk-0.2.0.tgz` is `@ajour/plugin-sdk` 0.2.0, packed at commit
`5350b19c` (origin/main on 2026-11-17, after #764): `tsc -p
tsconfig.build.json` in `packages/plugin-sdk`, then `npm pack
--ignore-scripts`. It contains #750's commit `0988ec75` and #747. It adds the
`processes` block, `ajour.process.run`, `ajour.open`, the handoff capability,
handoff tools that use a connection (`connection`, the `connection-url` slot,
`HandoffArguments` and the fake's `connectionUrl`), process sessions
(`mode: "session"`, `ajour.process.session` and the fake's `processSession`),
thread listing (`listsThreads` and `listThreads`, from #757), and a start's
hook (the `hook-url` argument and the fake's `hookUrl`, from #758), a
declared command's working folder (`cwd`, from #762), and each handoff tool's
features (`followsState` and `hooks`, from #764).
The SDK's version is still 0.2.0, so the filename stays the same and the
lockfile integrity changes. Only `agent-handoff` uses it so far.

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
