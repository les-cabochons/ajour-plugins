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
the optional `baseRef` on pull request facts. It was packed again from a merge
of that branch (`26b4fb47`) with the `feat/deck-draft-review` branch
(les-cabochons/ajour#918), for Deck's writes that name their submission:
`submissionId` and `firstTriedAt` on `submitReview` and `postComment`, and
their `{ uncertain: true }` answer. It was then packed from the
`feat/deck-summary` branch of `les-cabochons/ajour` (les-cabochons/ajour#789)
at `66f15ea4`, its merge of origin/main `3b8ffe65` (after #918), which adds
the `getLinkedTickets` operation to those. It was then packed from the
`feat/deck-replies-resolve` branch of `les-cabochons/ajour`
(les-cabochons/ajour#785) at `3f4de3e0`, its merge of origin/main after #919
and #939, for named replies: `submissionId` and `firstTriedAt` on
`replyToThread` and its `{ uncertain: true }` answer, and the `headSha` a file
is viewed at on `setFileViewed`. It was then packed from the
`feat/deck-asks-read-clone` branch of `les-cabochons/ajour`
(les-cabochons/ajour#917, #795) at `e16de721`, its merge of origin/main after
#938, adding the optional `headRef` and `repositoryIdentity` on pull request
facts. The SDK's version stays 0.4.0, so only the lockfile integrity changes.
Packed again from the `feat/deck-author-actions` branch of
`les-cabochons/ajour` (les-cabochons/ajour#786) at `7551e8d3`, its merge of
origin/main after #917, for the author's actions, `updatePullRequest` and
`mergePullRequest`, which the SDK has declared since #407: that pack is byte
for byte the one above, and the lockfile doesn't change. It was then packed
from the `feat/deck-stacks` branch of `les-cabochons/ajour`
(les-cabochons/ajour#788) at `e2cf6e91`, its merge of origin/main after #917,
adding the optional `baseSha` on pull request facts, and again at `8ee26b6b`,
its merge of origin/main after #948, which is byte for byte that pack.
It was then packed from the `fix/deck-council-r1` branch of
`les-cabochons/ajour` (les-cabochons/ajour#965) at `c9f8497b`, for the
optional `voteWithheld: { reason: "new_commits" }` on `submitReview`'s
result, which `azure-devops` answers when new commits held back a vote after
the threads posted. That pack also brings the chat's writes of #961: the
optional `url` on `submitReview`, `postComment` and `replyToThread` results,
and `deleteComment`.

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
