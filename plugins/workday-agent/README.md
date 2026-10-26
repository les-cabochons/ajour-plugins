# Ajour Workday (agent)

An unofficial Ajour plugin that commits your Ajour week changes to the Workday timesheet and submits the week. It has no code and does not use a Workday API. Ajour starts a coding agent, Claude Code or Codex, with the prompt in [`prompts/commit-week.md`](prompts/commit-week.md) or [`prompts/submit-week.md`](prompts/submit-week.md). The agent reads the week from Ajour and types it in Workday's web page in a Chrome window.

It drives Workday's page, so it breaks when Workday changes that page. A plugin that uses Workday's API would replace it.

It never types a password or a code. With the optional "Sign-in username" setting, it clicks the SSO button and types your username, so sign-in finishes alone while Chrome still has your company session. When the page asks for a password, a code or an approval, the agent asks you to sign in in the Chrome window.

## What the agent does

The plugin has two tasks, each with its own settings.

### Commit to Workday

On the Commit page.

1. Reads the week's changes from Ajour: entries added, updated or deleted since the last commit.
2. Opens the timesheet URL from the plugin settings and goes to the week.
3. Adds, updates or deletes one Workday entry per Ajour entry. Each entry's comment ends with an ID, such as `Fix login · ajour:1a2b3c4d`, so a second run finds what is already done. It marks each change as committed in Ajour once Workday saved it.

### Check Workday and submit

Replaces Submit week once the week is committed.

1. Reads the week's status from Ajour and checks the pace. A week under its pace asks before going on.
2. Opens the timesheet and compares Workday with what Ajour committed, day by day.
3. Fixes the differences or asks you, then submits the week in Ajour, which locks it.

It never presses a Submit button in Workday.

## Install

1. In Ajour, Settings > Plugins, install Workday (agent) from the official plugin source. To try a local copy instead, run `just package workday-agent` from the repository root, then choose Install from file and select `plugins/workday-agent/package/workday-agent-<version>.ajour-connector`.
2. In Settings > Agents, pick an agent. In Settings > Plugins > Workday (agent), fill "Workday timesheet URL" and, if you want, "Sign-in username".
3. If a project has another name or code in Workday, set them in Ajour: open the project, then the Workday section of its properties.
4. On the Commit page, click "Commit to Workday". Once the week is committed, click "Check Workday and submit".

Requires an Ajour build with plugin API 4 agent tasks, which declare their MCP tools and get only those. Version 0.6.0 is the first on API 4; Ajour admits API 4 packages only in development builds until the release that switches every plugin to API 4, and earlier versions (API 3) keep working on the builds that still run API 3. Version 0.4.1 needs an Ajour whose `mark_entries_committed` takes `changes` with versions. Version 0.5.0 also needs an Ajour with `get_week_status`, `submit_week` and the `submit-week` placement.

## Plugin API 4 and the tools each task gets

The manifest declares `apiVersion: 4`. It has no `entrypoint`, no `runtime`, no `network` and no connection fields: the plugin has no code, so there is no sandboxed renderer to start, and the agent reaches Workday through the browser, not through Ajour's broker. Each task lists, in `tools`, the Ajour MCP tools its run may call. A run's MCP client gets only those, plus the session tools that every run has (`begin_session`, `update_session`, `end_session`, `ask` and `wait_for_answer`). A call to any other tool is refused.

| Task | Declared tools | Why |
| --- | --- | --- |
| Commit to Workday | `get_week_changes` | Reads the added, updated and deleted entries of the week. |
| | `mark_entries_committed` | Marks each change once Workday saved it. |
| | `list_time_entries` | Looks up an entry after Ajour refuses a mark, to make Workday match it. |
| Check Workday and submit | `get_week_status` | Reads the pace, the committed entries and the week's version. |
| | `submit_week` | Submits and locks the week in Ajour. |

Check Workday and submit declares no write tool for entries: its prompt never marks changes. `tests/manifest.test.mjs` fails when a prompt names an Ajour tool its task does not declare, or a declared tool it never uses.

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and `just`.

```sh
just install
just verify
```

The plugin has no code: Ajour reads `plugin.json` and the prompts as they are, and `just verify` checks them. `tests/manifest.test.mjs` also checks that it publishes only the manifest and the prompts, and declares no entrypoint, network or credential.

`tests/sdk-manifest.test.mjs` checks `plugin.json` against the `PluginManifest` type of `@ajour/plugin-sdk` with TypeScript. The SDK is not on npm yet, so the repository vendors it at `vendor/ajour-plugin-sdk-0.1.0.tgz` (see [`vendor/README.md`](../../vendor/README.md)) and `package.json` depends on it with `file:`. Refresh the vendored copy whenever Ajour's MCP tools or manifest contract change, or this test checks against a stale list. It is released through the repository's `ajour.json`. When you change it, bump the version in `plugin.json` and `package.json`. See [Releases](../../README.md#releases).

## License

[MIT](LICENSE)
