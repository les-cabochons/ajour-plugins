# Vendored packages

`ajour-plugin-sdk-0.1.0.tgz` is `@ajour/plugin-sdk` 0.1.0, packed from
`packages/plugin-sdk` in `les-cabochons/ajour` at commit
`33c0a326401ac42ed44dcc5a8bd6efd0ebcd9725` (origin/main on 2026-11-04, after #566).
This includes #566's assignee contracts, #572's sync viewer and assignee facts,
task properties, and the optional source IDs on `syncConnection`. The SDK's
upstream version is still 0.1.0, so the filename stays the same and the lockfile
integrity changes.

`ajour-plugin-sdk-0.2.0.tgz` is `@ajour/plugin-sdk` 0.2.0, packed at commit
`13a1dd3b` (origin/main on 2026-11-19, after #831): `corepack pnpm pack` in
`packages/plugin-sdk`, whose `prepack` runs `tsc -p tsconfig.build.json`. It
has the `processes` block, `ajour.process.run`, `ajour.open`, the handoff
capability, handoff tools that use a connection (`connection`, the
`connection-url` slot, `HandoffArguments` and the fake's `connectionUrl`),
process sessions (`mode: "session"`, `ajour.process.session` and the fake's
`processSession`), thread listing (`listsThreads` and `listThreads`, from
#757), a start's hook (the `hook-url` argument and the fake's `hookUrl`, from
#758), a declared command's working folder (`cwd`, from #762), and each
handoff tool's features (`followsState` and `hooks`, from #764). It also has
the time sync capability (`timeSync` and `syncTimeEntries`, from #691 to
#703) and everyone's hours on a project source task (`workedHours`, from
#815). The SDK's version is still 0.2.0, so the filename stays the same and
the lockfile integrity changes. `agent-handoff` and `chronops` use it.

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
