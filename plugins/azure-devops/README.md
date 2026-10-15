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
