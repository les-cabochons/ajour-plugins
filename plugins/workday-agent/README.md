# Ajour Workday (agent)

An unofficial Ajour plugin that commits your Ajour week changes to the Workday timesheet. It has no code and does not use a Workday API. Ajour starts a coding agent, Claude Code or Codex, with the prompt in [`prompts/commit-week.md`](prompts/commit-week.md). The agent reads the week from Ajour and types it in Workday's web page in a Chrome window.

It drives Workday's page, so it breaks when Workday changes that page. A plugin that uses Workday's API would replace it.

It never types a password or a code. With the optional "Sign-in username" setting, it clicks the SSO button and types your username, so sign-in finishes alone while Chrome still has your company session. When the page asks for a password, a code or an approval, the agent asks you to sign in in the Chrome window.

## What the agent does

1. Reads the week's changes from Ajour: entries added, updated or deleted since the last commit.
2. Opens the timesheet URL from the plugin settings and goes to the week.
3. Adds, updates or deletes one Workday entry per Ajour entry. Each entry's comment ends with an ID, such as `Fix login · ajour:1a2b3c4d`, so a second run finds what is already done. It marks each change as committed in Ajour once Workday saved it.

## Install

1. Download the `.ajour-connector` file from the latest release.
2. In Ajour, Settings > Plugins, install the file.
3. In Settings > Agents, pick an agent. In Settings > Plugins > Workday (agent), fill "Workday timesheet URL" and, if you want, "Sign-in username".
4. If a project has another name or code in Workday, set them in Ajour: open the project, then the Workday section of its properties.
5. On the Commit page, click "Commit to Workday".

Requires an Ajour build with agent tasks, plugin API 3. Version 0.4.0 needs an Ajour with the Commit page.

## Development

Requirements: Node.js 22, Corepack with pnpm 10.7.0, and `just`.

```sh
just install
just verify
```

`just package` writes `package/workday-agent-<version>.ajour-connector`. Each push to `main` publishes a prerelease with that file.

## License

[MIT](LICENSE)
