# Ajour Connector - Azure DevOps

Ajour Connector - Azure DevOps syncs
Azure DevOps work items into the local backlog and supports estimate updates
through Ajour's connector plugin protocol.

## Requirements

- Node.js 22
- Corepack with pnpm 10.7.0
- `just` (optional, but recommended)

## Development

```sh
just install
just test
just typecheck
just build
```

To rebuild the development plugin whenever its source changes, keep the watcher
running:

```sh
just dev
```

Run the complete local CI path with:

```sh
just verify
```

## Build an installable connector

```sh
just package
```

The archive is written to
`package/azure_devops-<version>.ajour-connector`. Its version comes from
`plugin.json`; keep that value aligned with `package.json` when preparing a new
release.

Every push to `main` runs tests and type checks, stamps a unique prerelease
version such as `1.0.0-main.3.9aac30e` into the build, packages the installable
archive, retains it as a GitHub Actions artifact for 30 days, and publishes it
as a GitHub prerelease. The base version remains the matching version declared
in `plugin.json` and `package.json` on the branch.

## Install in Ajour

In a production desktop build, open **Settings → Plugins**, choose **Install
plugin**, and select the generated `.ajour-connector` archive.

The connector requires an Azure DevOps personal access token with the work-item
permissions appropriate for the enabled read or update operations. Credentials
stay in Ajour's local connector configuration.

## Settle support

This package uses Ajour plugin API version 3. Its connector capability lists
the item's work item type states and can write state and priority in one
update. Set the connection's priority field to enable priority writes.
Writing requires work-item read and write permissions.

Work item URLs must belong to the configured organization. Completed and
Removed categories count as done. Resolved remains open. Sync reports items
Ajour already tracks that reached a done category, even when the query no
longer returns them.

## Comments

`listItemComments` returns a work item's comments for Ajour's item page,
through the work item Comments API (`7.1-preview.4`). Ajour asks for the
newest page and then earlier ones; the plugin reads Azure DevOps newest first
and returns each page oldest first, with the total and a continuation cursor.

- HTML comments go through the same converter as descriptions. Markdown
  comments stay as written.
- Mentions become `[@Name](mention:<identity id>)`. A Markdown comment's
  `@<id>` takes its name from the rendered text.
- Reactions map to Ajour's names: like, dislike, heart, hooray, smile as
  laugh, and confused.
- The viewer comes from `connectionData`, in the same id space as comment
  authors.

`postItemComment` posts a comment at once, as Markdown, so Ajour's text
reaches Azure DevOps as written. Ajour's mentions go as `@<id>` mentions, which
notify the person.

Reading comments needs Work Items (Read), and posting needs Work Items (Read &
write). Ajour never stores comment text.

## Pull requests

The plugin also declares Ajour's code host capability. `syncPullRequests`
returns provider-neutral facts for active pull requests across the
organization that you created, or where you are a reviewer, directly or through
one of your teams when **Include team review requests** is on. Pull requests
Ajour tracks that left those searches are fetched by id, so Ajour sees them
complete or get abandoned. A repository is reported as `project/repository`.

Microsoft documents the pull request list per project only, though its own
tools list them for the whole organization. The plugin tries the
organization-wide list first. When it answers 404, which Azure DevOps also
returns for something the token cannot see, the plugin searches each project
among the repositories the token can read. Pull requests sync on the interval while **Sync
pull requests automatically** is on, separately from **Auto sync to backlog**.

| Ajour fact              | Azure DevOps source                                                                                                                                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Review requests         | Reviewers who have not voted or declined. A team reviewer includes you when you are a member of the team.                                                      |
| Review request events   | `ReviewersUpdate` system threads: who added which reviewers, and when.                                                                                           |
| Reviews                 | `VoteUpdate` system threads. Approved and approved with suggestions are approvals; waiting for author and rejected request changes; a reset vote is dismissed. |
| Comments                | Text comments in every thread. Mentions are `@<your identity id>`.                                                                                               |
| Last push and its actor | The latest pull request iteration and who pushed it.                                                                                                             |
| Checks                  | Build and Status policy evaluations.                                                                                                                             |
| Mergeability            | The pull request's merge status.                                                                                                                                 |

Comment and review text is never returned to Ajour. Pull requests need the
**Code (Read)** scope, and **Project and Team (Read)** to find your teams.
Teams count, other security groups do not: the plugin never guesses
membership. If a pull request's policy evaluations cannot be read, its checks
read as none.

Ajour lets the user turn work items and pull requests on and off separately.
`validateConnection` receives the capabilities that are on as its second
argument and checks only their access, so a pull-request-only token needs no
work item scope. The fields of each capability declare it, so Ajour hides them
while it is off.

## Priority levels

Ajour has four priority levels: Urgent, High, Medium and Low. The connection
has one field per level that says which values of the priority field mean that
level. Each holds one whole number such as `1` or an inclusive range such as
`1-3`. The defaults are Urgent `1`, High `2`, Medium `3` and Low `4`, the
standard Azure DevOps priorities. For a custom field such as "MS Priority"
that runs from 1 to 100, you could use `1-25`, `26-50`, `51-75` and `76-100`.

On sync, an item gets the level whose range holds its value. A value outside
every range, or an empty priority field, gives the item no priority. When
Ajour writes a priority, the connector sends the lowest value of that level's
range. Leave a level empty to give it no values. Ajour cannot write that level.

Saving the connection rejects a level that is not a whole number or a range, a
range whose start is above its end, and two levels whose ranges overlap.

## License

[MIT](LICENSE)
