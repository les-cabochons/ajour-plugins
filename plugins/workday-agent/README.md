# Ajour Workday (agent)

An unofficial Ajour plugin that enters your Ajour week in the Workday timesheet. It has no code and does not use a Workday API. Ajour starts a coding agent, Claude Code or Codex, with the prompt in [`prompts/enter-week.md`](prompts/enter-week.md). The agent reads the week from Ajour and types it in Workday's web page in a Chrome window.

It drives Workday's page, so it breaks when Workday changes that page. A plugin that uses Workday's API would replace it.

It never types a password or a code. With the optional "Sign-in username" setting, it clicks the SSO button and types your username, so sign-in finishes alone while Chrome still has your company session. When the page asks for a password, a code or an approval, the agent asks you to sign in in the Chrome window.

## What the agent does

1. Reads the week's unsubmitted lines and Ajour's pace check. When the week is over or under pace, it asks before entering.
2. Opens the timesheet URL from the plugin settings and goes to the week.
3. Enters each line with its hours and a comment ending with the line's ID, such as `Fix login · ajour:1a2b3c4d`. The ID lets a second run find lines already entered. It marks each line as submitted in Ajour once Workday saved it.
4. Compares the week's totals per day in Ajour and Workday, and asks what to do when they differ.

## Install

1. Download the `.ajour-connector` file from the latest release.
2. In Ajour, Settings > Plugins, install the file.
3. In Settings > Agents, pick an agent. In Settings > Plugins > Workday (agent), fill "Workday timesheet URL" and, if you want, "Sign-in username".
4. On the Submit page, click "Enter in Workday".

Requires an Ajour build with agent tasks, plugin API 3.

## Development

Requirements: Node.js 22, Corepack with pnpm 10.7.0, and `just`.

```sh
just install
just verify
```

`just package` writes `package/workday-agent-<version>.ajour-connector`. Each push to `main` publishes a prerelease with that file.

## License

[MIT](LICENSE)
