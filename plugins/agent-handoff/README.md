# Ajour agent handoff

An Ajour plugin that hands a backlog item off to a coding agent and follows its thread. Its first tool is [T3 Code](https://t3.codes). Ajour fills the prompt, title and branch, then the plugin starts a T3 Code thread with the `t3` CLI and reads the thread's state back: working, waiting for you, ready for review, settled.

The plugin has no network access. It runs only the four `t3` commands it declares, through Ajour's process broker, after you approve them in Access.

## Commands it runs

| Command                                             | What for                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 thread start <folder> - --title <title> --json` | Starts the thread. The prompt goes on stdin, and the title on one line. With a worktree, adds `--worktree <base> --branch <branch>`; with a provider, adds `--provider <provider>`; with a model, adds `--model <model>`. Times out after 25 seconds. |
| `t3 thread list --project <folder> --json`          | Reads every thread of a repository folder, once per folder on each refresh. Times out after 10 seconds.                                                                                                                                               |
| `t3 thread show <thread> --json --messages 0`       | Reads a live thread's pending requests, a new thread's link, and the state of a thread missing from the list. `--messages 0` keeps the conversation out of the plugin. Times out after 10 seconds.                                                    |
| `t3 --version`                                      | Detects T3 Code. Times out after 10 seconds.                                                                                                                                                                                                          |

`<folder>` is one of the project's repository folders, which Ajour resolves. The folder must already be a T3 Code project.

Ajour ends a plugin operation after 30 seconds, so a refresh stops waiting for T3 Code after 20. The threads it hasn't read by then keep their last state, with the reason "T3 Code took too long; refreshing again later." When Ajour refuses a command, the plugin says what to do, such as approving T3 Code's commands in the plugin's Access tab.

## States

| T3 Code                                                                           | Ajour                                         |
| --------------------------------------------------------------------------------- | --------------------------------------------- |
| A pending request, such as a question or an approval, even while `running`        | Waiting for you (`needs-you`)                 |
| `preparing`, `queued`, `starting`, `running`, `waiting`                           | Working                                       |
| `idle`, `completed`, `interrupted`, `cancelled`, `rolled_back`, while not settled | Ready                                         |
| Settled or archived                                                               | Done. Ajour stops refreshing it a day later.  |
| `failed`                                                                          | Failed                                        |
| `thread show` says the thread is no longer available                              | Gone                                          |
| Missing from the list, such as when archived                                      | Read with `thread show`, with `missing: true` |
| No T3 Code server answers                                                         | Unknown, with the reason. Never gone.         |
| No answer before the refresh deadline                                             | Keeps its last state, with the reason         |

The native state keeps T3's `status`, `settled`, `snoozed`, `snoozedUntil`, `archived`, `pendingRequestCount` and `projectId`, plus the last state read. Only HTTPS pull request links are kept; one without a title is named `repository#number`. Messages and worktree paths are never stored.

## Settings

| Setting           | Default | What it does                                                                                                                  |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Create a worktree | On      | Runs the thread in a new git worktree on the handoff branch. Off runs it in the project folder.                               |
| Worktree base     | `main`  | The branch, tag or commit the worktree starts from.                                                                           |
| Provider          | Empty   | A T3 Code provider instance ID, such as `claudeAgent`. A provider needs a model. Leave both empty for the project's defaults. |
| Model             | Empty   | A model slug, such as `claude-opus-5-5` or one with slashes. It can be set without a provider.                                |

## Default prompt

The manifest has no default prompt yet: `capabilities.handoff.promptTemplate` arrives with les-cabochons/ajour#739, which isn't on Ajour's main branch. Until then Ajour uses its own fallback. Once it lands, the manifest gets this template:

```text
Work on {{item.key}}: {{item.title}}
{{item.url}}

{{item.description}}

Work on the branch you are on, and open a pull request when you are done.
```

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and `just`.

```sh
just install
just test
just typecheck
```

The tests run the plugin against outputs recorded from the real `t3` CLI (`tests/fixtures`, version in `version.txt`), through a fake `t3` that expands each request into argv from `plugin.json` the way the broker does. `tests/sdk-manifest.test.mjs` checks `plugin.json` against the SDK's `PluginManifest` type.
