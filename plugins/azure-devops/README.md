# AJC Azure DevOps

AJC Azure DevOps is the standalone Azure DevOps connector for HarDay. It syncs
Azure DevOps work items into the local backlog and supports estimate updates
through HarDay's connector plugin protocol.

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

Run the complete local CI path with:

```sh
just verify
```

## Build an installable connector

```sh
just package
```

The archive is written to
`package/azure_devops-<version>.harday-connector`. Its version comes from
`plugin.json`; keep that value aligned with `package.json` when preparing a new
release.

Every push to `main` runs tests and type checks, builds the connector, packages
the installable archive, and retains it as a GitHub Actions artifact.

## Install in HarDay

In a production desktop build, open **Settings → Plugins**, choose **Install
plugin**, and select the generated `.harday-connector` archive.

The connector requires an Azure DevOps personal access token with the work-item
permissions appropriate for the enabled read or update operations. Credentials
stay in HarDay's local connector configuration.

## License

[MIT](LICENSE)
