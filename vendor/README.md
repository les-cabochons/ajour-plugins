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

`ajour-plugin-sdk-0.3.0.tgz` is `@ajour/plugin-sdk` 0.3.0, packed at commit
`82dd6ccd` (origin/main on 2026-11-21, after #855, the last commit before the
SDK became 0.4.0). It adds the `typeOverrides` connection field type and its
reader, `parseTypeOverrides`, `formatTypeOverrides` and `typeOverrideFor`
(#847). `azure-devops` uses it, and copies the reader into its source, since a
plugin runs from its own files. It also has the time sync check rounds of #843
(#845): an optional `cursor` on `syncTimeEntries` requests and answers, and the
`{ unchanged: true, cursor }` answer to a check round (`TimeSyncAnswer`).
`chronops` uses them. The first pack, at `447449a7`, predates #845, so the
filename stays the same and the lockfile integrity changes.

`ajour-plugin-sdk-0.4.0.tgz` is `@ajour/plugin-sdk` 0.4.0, packed from the
`feat/deck-threads-status` branch of `les-cabochons/ajour` at commit
`fd394b66` (les-cabochons/ajour#783, on origin/main `8c393814` of
2026-11-24). It adds the code host's `getChecks` operation and the optional
`approvals` on pull request facts. `github` and `azure-devops` use it. It was
packed again from the `feat/deck-versions` branch of `les-cabochons/ajour`
(les-cabochons/ajour#787), after #883 and #902 merged, adding
`getPullRequestVersions` with each version's commits and `versionName`, and
the optional `baseRef` on pull request facts. It was then packed from the
`feat/deck-summary` branch of `les-cabochons/ajour` (les-cabochons/ajour#789)
at `6283cdb3`, its merge of origin/main `21757219`, which adds the `getLinkedTickets`
operation to those. Pack it again from origin/main once that branch merges;
the SDK's version stays 0.4.0, so only the lockfile integrity changes.

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
