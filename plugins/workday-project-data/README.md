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

`just build` writes the runnable entrypoint to `dist/plugin.mjs`. Ajour loads
the compiled directory containing `plugin.json` and `dist/`; this repository has
no dependency on Ajour source code.

## License

[MIT](LICENSE)
