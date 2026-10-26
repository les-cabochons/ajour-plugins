# Ajour Project Data - Workday

This Ajour schema plugin imports a project and its tasks from Workday's Excel
exports, in French. It only imports, and never connects to Workday.

- **Project export** ("Afficher un projet", one file per project). Imported in
  Settings › Projects. The `Récapitulatif` sheet gives the project's name
  ("Nom du projet") and code ("Identifiant du projet"), and "Inactif" archives
  it. `Ressources des tâches` gives one task per line.
- **Project plan** ("View Project Planner Composite View"). It doesn't name
  its project, so Ajour imports it with Import tasks… on the project. "Fermé"
  archives a task, "Non facturable" makes it non-billable, and "Heures
  estimatives" above 0 is its budget.

In both, a task named `Regular`, Workday's task with no name of its own, takes
its phase's name. Two tasks with the same name become one, and the open one
wins.

Ajour reads the Excel file and hands this plugin every sheet as rows of cells.

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and optionally `just`.

```sh
just verify
```

Ajour imports `src/plugin.mjs` directly, so there is nothing to build. The
plugin depends on no Ajour source code.

## Plugin API 4

The plugin runs on **plugin API 4**, in a dedicated worker inside a sandboxed
renderer. It declares no network and no connection fields, loads when needed
(`runtime.start`), and its source is pure: no import, no Node built-in or
global, no `fetch`. A test fails on any of them. Ajour admits an API 4 package
in development builds only, until the release that switches every plugin to
API 4 (les-cabochons/ajour#403). The import contract is unchanged.

`types.check.ts` holds `plugin.json` to the API 4 manifest type of
`@ajour/plugin-sdk`. The SDK is not on npm yet, so the packed package is
vendored in `vendor/ajour-plugin-sdk-0.1.0.tgz` and installed as a `file:`
dev dependency. It was built from Ajour commit
`13e1c1c0` (`packages/plugin-sdk`, version 0.1.0). To refresh it:

```sh
# in an Ajour checkout
corepack pnpm install --frozen-lockfile
corepack pnpm --filter @ajour/plugin-sdk build
cd packages/plugin-sdk && npm pack
# copy ajour-plugin-sdk-<version>.tgz to vendor/, point package.json at it,
# run `just install`, and update the commit above
```

Once the SDK is published, swap the `file:` dependency for a version range and
delete `vendor/`.

The official plugin source lists it as coming soon, without files. To try it,
run `just package workday-project-data` from the repository root and install
`plugins/workday-project-data/package/workday-project-data-<version>.ajour-connector`
with Install from file.

## License

[MIT](LICENSE)
