# Ajour plugins

The official [Ajour](https://github.com/les-cabochons/ajour) plugins, in one
repository. Each plugin keeps its own folder, package, tests and release, and
they share one pnpm workspace, one lockfile and one CI workflow.

| Folder | Plugin ID | Plugin | Capabilities | Formerly |
| --- | --- | --- | --- | --- |
| [`plugins/azure-devops`](plugins/azure-devops) | `azure_devops` | Azure DevOps | Connector, code host | [ajc-azure-devops](https://github.com/les-cabochons/ajc-azure-devops) |
| [`plugins/github`](plugins/github) | `github` | GitHub | Connector, code host | [ajc-github](https://github.com/les-cabochons/ajc-github) |
| [`plugins/jira`](plugins/jira) | `jira` | Jira | Connector | [ajc-jira](https://github.com/les-cabochons/ajc-jira) |
| [`plugins/ics`](plugins/ics) | `ics` | Calendar address (ICS) | Calendar | [ajc-ics](https://github.com/les-cabochons/ajc-ics) |
| [`plugins/workday-agent`](plugins/workday-agent) | `workday-agent` | Workday (agent) | Agent task, project properties | [ajp-workday-agent](https://github.com/les-cabochons/ajp-workday-agent) |
| [`plugins/workday-project-data`](plugins/workday-project-data) | `workday-project-data` | Workday project data shape | Schema | ajp-workday |

Ajour discovers these plugins through the catalog in
[ajour-plugins-index](https://github.com/les-cabochons/ajour-plugins-index),
which stays a separate repository because Ajour reads its `catalog.yaml` from
there.

## Requirements

- Node.js 24, the line Ajour runs plugins on
- Corepack with pnpm 10.7.0
- `just` (optional, but recommended)

## Development

Every recipe runs on all plugins, or on one when you name its folder:

```sh
just install
just test
just test jira
just typecheck
just verify
just package github
just dev azure-devops
```

Each plugin folder still has its own `Justfile`, so `just verify` inside
`plugins/jira` works as it did in the plugin's own repository.

## CI

[`build.yml`](.github/workflows/build.yml) runs on pull requests, on pushes
to `main` and by hand.

1. **Plan.** [`scripts/plan-ci.mjs`](scripts/plan-ci.mjs) compares the change
   with its base. A plugin is built when a file in its folder changed, and
   every plugin is built when a shared file changed, such as the lockfile or
   the workflow. Run `just plan` to see what it would choose for your branch.
2. **Build.** Each chosen plugin runs its tests and checks, then packages its
   archive, or builds when it has no archive.
3. **Publish.** On `main`, each plugin whose own folder changed is published
   as a prerelease. A shared change alone publishes nothing. A manual run
   builds and publishes the plugins named in its input, or `all`.

## Releases

All plugins publish their GitHub prereleases from this repository. A build
of Azure DevOps 1.1.0 from commit `9aac30e`, the 130th commit on `main`, is:

| | |
| --- | --- |
| Version | `1.1.0-main.130.9aac30e`, stamped into `package.json` and `plugin.json` |
| Asset | `azure_devops-1.1.0-main.130.9aac30e.ajour-connector` |
| Tag | `v1.1.0-azure-devops.main.130.9aac30e` |
| Title | `Ajour Connector - Azure DevOps v1.1.0-main.130.9aac30e` |

- The build number counts the commits on `main`. It keeps rising across
  plugins and stays above every build number from the old repositories.
- The tag carries the plugin's folder in its prerelease part, so it stays
  unique per plugin and Ajour still reads it as a semantic version and picks
  the highest one.
- Each release holds one asset. A catalog `assetPattern` must match only its
  own plugin's assets now that they share a release list, so start the
  version part with a digit: `^jira-[0-9][0-9A-Za-z.+-]*\.ajour-connector$`.

A plugin is published when its `package.json` has a `package` script and an
`ajourRelease.title`, and its `scripts/set-build-version.mjs` stamps the
version. The Workday project data plugin has neither yet, so CI only builds
and tests it.

## History

Each plugin's folder holds the full `main` history of its former repository,
merged in unchanged under `plugins/<folder>/`. The old tags keep their names
under the old repository's name, such as `ajc-jira/v1.0.0-main.9.e6802d4`.
The releases published before the move stay in the old repositories.

## Add a plugin

1. Create `plugins/<folder>/`, with a folder name of lowercase letters,
   digits and single hyphens.
2. Give its `package.json` `test` and `verify` scripts, and `typecheck`,
   `build` and `package` where they apply.
3. To publish it, add `ajourRelease.title` and a
   `scripts/set-build-version.mjs` like the other plugins'.
4. Run `just install` and `just verify <folder>`.
5. List it in
   [ajour-plugins-index](https://github.com/les-cabochons/ajour-plugins-index)
   with this repository as its `repository`.

## License

[MIT](LICENSE). Each plugin carries its own license in its folder.
