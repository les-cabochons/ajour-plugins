# Ajour agent handoff

An Ajour plugin that hands a backlog item off to a coding agent and follows its work. Its tools are [T3 Code](https://t3.codes), [Claude Code](https://code.claude.com), [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli) and [Codex](https://developers.openai.com/codex). Ajour fills the prompt, title and branch, then the plugin starts a T3 Code thread with the `t3` CLI, a Claude Code background session with `claude`, a Copilot CLI session with `copilot`, or a Codex thread through `codex app-server`, and reads its state back where the tool reports it: working, waiting for you, ready for review, settled.

The plugin has no network access. It runs only the commands it declares, through Ajour's process broker, after you approve them in Access.

Ajour ends a plugin operation after 30 seconds, so a refresh stops waiting for a tool after 20. The handoffs it hasn't read by then, or whose command Ajour timed out or cut short, keep their last state, with the reason "T3 Code took too long; refreshing again later." (or Claude Code, or Codex). A start stops waiting for what it started 27 seconds in. When Ajour stops a start command before its output is whole, the plugin says the tool may have started the work, so the user checks before handing off again. When Ajour refuses a command, the plugin says what to do, such as allowing the plugin in its Access section in Settings › Plugins.

## T3 Code

### Commands it runs

| Command                                             | What for                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 thread start <folder> - --title <title> --json` | Starts the thread. The prompt goes on stdin, and the title on one line. With a worktree, adds `--worktree <base> --branch <branch>`; with a provider, adds `--provider <provider>`; with a model, adds `--model <model>`. Times out after 20 seconds. |
| `t3 thread list --project <folder> --json`          | Reads every thread of a repository folder, once per folder on each refresh. Times out after 10 seconds.                                                                                                                                               |
| `t3 thread show <thread> --json --messages 0`       | Reads a live thread's pending requests, a new thread's link, and the state of a thread missing from the list. `--messages 0` keeps the conversation out of the plugin. Times out after 10 seconds.                                                    |
| `t3 --version`                                      | Detects T3 Code. Times out after 10 seconds.                                                                                                                                                                                                          |

`<folder>` is one of the project's repository folders, which Ajour resolves. The folder must already be a T3 Code project. A start stops waiting for the new thread's link 27 seconds in and keeps the thread.

### States

| T3 Code                                                                           | Ajour                                                                     |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| A pending request, such as a question or an approval, even while `running`        | Waiting for you (`needs-you`)                                             |
| `preparing`, `queued`, `starting`, `running`, `waiting`                           | Working                                                                   |
| `idle`, `completed`, `interrupted`, `cancelled`, `rolled_back`, while not settled | Ready                                                                     |
| Settled or archived                                                               | Done, labeled Settled or Archived. Ajour stops refreshing it a day later. |
| `failed`                                                                          | Failed                                                                    |
| `thread show` says the thread is no longer available                              | Gone                                                                      |
| Missing from the list, such as when archived                                      | Read with `thread show`, with `missing: true`                             |
| No T3 Code server answers                                                         | Unknown, with the reason. Never gone.                                     |
| No answer before the refresh deadline                                             | Keeps its last state, with the reason                                     |

The native state keeps T3's `status`, `settled`, `snoozed`, `snoozedUntil`, `archived`, `pendingRequestCount` and `projectId`, plus the last state read. Only HTTPS pull request links are kept; one without a title is named `repository#number`. Messages and worktree paths are never stored.

### Settings

| Setting           | Default | What it does                                                                                                                  |
| ----------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Create a worktree | On      | Runs the thread in a new git worktree on the handoff branch. Off runs it in the project folder.                               |
| Worktree base     | `main`  | The branch, tag or commit the worktree starts from.                                                                           |
| Provider          | Empty   | A T3 Code provider instance ID, such as `claudeAgent`. A provider needs a model. Leave both empty for the project's defaults. |
| Model             | Empty   | A model slug, such as `claude-opus-5-5` or one with slashes. It can be set without a provider.                                |

## Claude Code

Every handoff is a Claude Code background session (`claude --bg`), the only start that takes a prompt on stdin. A prompt never goes on the command line, where Ajour refuses line breaks and other processes can read it. The session works in the repository folder, keeps its own permission settings, and shows in `claude agents`.

### Commands it runs

| Command                                         | What for                                                                                                                                                                                                                            |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude --bg --name <title> --add-dir <folder>` | Starts the session with the prompt on stdin and the title on one line. With a model, adds `--model <model>` before `--add-dir`. Prints the job's short id, such as `backgrounded · e2cf2a01 · <title>`. Times out after 20 seconds. |
| `claude agents --json --all`                    | Lists every session, once per refresh for all folders, and once after a start to read the new job's full session id. Times out after 10 seconds.                                                                                    |
| `claude attach <job> <folder>` in a terminal    | Opens the session: Open on the handoff, and right after a start in the terminal start mode. It also wakes a stopped job.                                                                                                            |
| `claude --version`                              | Detects Claude Code. Times out after 10 seconds.                                                                                                                                                                                    |

`--bg` chooses the session id and prints only the job's short id, so a start reads `claude agents` to find the full id, up to three times, a second apart, until 27 seconds. The full id is the handoff's thread id. If the list never shows the job, the start fails and names the job, so the user opens it with `claude attach <job>` instead of handing off again.

`claude --resume <id>` would also open a session, but it refuses one that still runs in the background once it is given any option, and a terminal command must name its folder: Ajour opens the terminal in the command's first folder argument. So Open uses `claude attach`, and the folder rides as an extra argument that `claude attach` ignores with a warning.

### Trust and where the start runs

Claude Code starts a background session only in a folder the user trusted. The plugin never accepts the trust prompt: an untrusted folder fails with "Trust this folder in Claude Code first: run claude in the repository folder once and accept the trust prompt, then hand off again."

`claude --bg` works in the folder it starts in; `--add-dir` only adds the folder. Ajour's broker starts capture commands at the system root today, and only a capture command takes stdin. Claude Code refuses the root as an untrusted folder, and the plugin says so: "Ajour started Claude Code at the system root instead of the repository folder, so Claude Code refused it. This needs an Ajour update." Starts work once Ajour runs a capture command in its first folder argument, as it does for terminal and detached commands.

### States

One `claude agents --json --all` per refresh. `state` is a background job's lifecycle; `status` and `waitingFor` are a running process's live detail, and the only fields of an interactive session.

| Claude Code                                                                                    | Ajour                                                                        |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `failed`                                                                                       | Failed                                                                       |
| `stopped`                                                                                      | Ready, labeled Stopped                                                       |
| `blocked`, any `waitingFor` such as `permission prompt` or `input needed`, or status `waiting` | Waiting for you (`needs-you`), labeled with `waitingFor`                     |
| `working`, or status `busy`                                                                    | Working                                                                      |
| `done`, or status `idle`                                                                       | Ready, labeled Done                                                          |
| Another value                                                                                  | Unknown                                                                      |
| Missing from the list, such as after `claude rm`                                               | Keeps its last state, with `missing: true` and how to resume it. Never gone. |
| `claude` fails, or prints a list Ajour can't read                                              | Unknown, with the reason. Never gone.                                        |
| No answer before the refresh deadline                                                          | Keeps its last state, with the reason                                        |

Claude Code has no settled state, and a done or stopped session can take another turn when you open it, so the plugin reports it as ready for review, never done. A session listed twice, such as a stopped job you resumed in a terminal, reads from the entry with a live process. The label is Claude Code's own word: what it waits for, else its state or status.

The native state keeps the last state read, the label, and Claude's `kind`, `state` (as `claudeState`), `status`, `waitingFor` and job id. The folder path and process id are never stored. Claude Code gives a local session no web link, so a handoff has none.

### Settings

| Setting | Default           | What it does                                                                                                        |
| ------- | ----------------- | ------------------------------------------------------------------------------------------------------------------- |
| Start   | In the background | In the background, or in the background and open it in a terminal. Either way the session gets the prompt on stdin. |
| Model   | Empty             | A model alias such as `opus` or `sonnet`, or a full model name. Empty uses your Claude Code default.                |

A terminal is Windows Terminal on Windows and Terminal on macOS, set in Settings › General › Terminal. On Windows it takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path; with others, the session still starts and the handoff says the terminal couldn't open.

## Copilot CLI

The plugin chooses each session's id, a new UUID, and starts `copilot -p` detached in the repository folder. `-p` works on the prompt and exits when the task is done, which takes longer than a plugin operation. Ajour stops a capture command, and the work with it, at its timeout, and only a capture command takes stdin. So the prompt is one command-line argument: line breaks become spaces, a leading `-` is dropped, and a prompt over 12,000 characters is refused before `copilot` runs, with "Shorten the handoff template, such as by leaving out the item's description." Ajour passes the argument straight to the executable, never through a shell.

### Commands it runs

| Command                                                          | What for                                                                                                                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilot -C <folder> --session-id <uuid> -n <title> -p <prompt>` | Starts the session, detached, in the folder. `-n` names it, which Copilot CLI allows only for a new session. With a model, adds `--model <model>` after the title. Returns once started. |
| The same with `--allow-all-tools` before `-p`                    | The start when Tools is Allow all tools. It is a separate command, so Access shows it on its own.                                                                                        |
| `copilot -C <folder> --resume <uuid>` in a terminal              | Opens the session: Open on the handoff. It shows the session's work, and takes another turn. Without a terminal, `copilot --resume` refuses: "No prompt provided."                       |
| `copilot --version`                                              | Detects Copilot CLI. Times out after 10 seconds.                                                                                                                                         |

The UUID is the handoff's thread id. A detached command gives no output and no exit code, so a start that `copilot` fails, such as when it isn't signed in, still leaves the handoff: Copilot CLI writes the session with its id and name before it signs in, without the prompt, and Open resumes that empty session. Sign in with `copilot` and `/login` before handing off.

### Tools

`-p` can't ask before Copilot edits a file or runs a command. It runs only what is already allowed: read-only commands, and what you allowed with "Yes, and don't ask again" in this repository. It skips the rest. Open the session to allow them and continue. Allow all tools adds `--allow-all-tools`, so the session edits files and runs commands without asking.

### States

Copilot CLI has no command that reports a session's state. It keeps each session's events in `session-state/<uuid>/events.jsonl` under `COPILOT_HOME`, but no declared command can read them, and an event log alone can't tell a finished task from one that waits for you or failed. So every refresh reports Unknown with "Copilot CLI doesn't report a session's state.", runs no command, keeps the last state read in the native state, and never says gone.

The native state keeps the last state, the label and the Tools setting. Nothing else about the session is read, so a handoff has no web link.

The VS Code link `vscode://agents/agent-host-session/copilotcli/<uuid>` has the format VS Code builds, but nobody has seen VS Code adopt a session the standalone CLI started. Until that is tested, the plugin declares no `vscode` scheme and Open uses the terminal.

### Settings

| Setting | Default                           | What it does                                                                        |
| ------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Tools   | Only the ones you already allowed | Or Allow all tools, which adds `--allow-all-tools` to the start.                    |
| Model   | Empty                             | A model name, or `auto` to let Copilot choose. Empty uses your Copilot CLI default. |

The terminal follows the same rules as Claude Code's: Windows Terminal takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path.

## Codex

Every handoff is a Codex thread that `codex app-server` starts and runs. The app-server is Codex's JSON-RPC server on stdio, and it owns a turn: the turn stops if the app-server ends before the turn is done. So the plugin doesn't run it as a command that returns. It runs it as an Ajour process session, which Ajour keeps running between plugin operations. The prompt and the title go to the app-server's stdin as JSON (`turn/start` and `thread/name/set`), never on a command line.

**A running turn ends when Ajour quits.** Ajour also ends the session, and the turn with it, when the plugin is turned off, updated or suspended, or after 30 minutes without a refresh. Codex then records the turn as interrupted, and the handoff shows Failed, labeled Stopped. Open the thread in Codex to go on.

### Commands it runs

| Command                                           | What for                                                                                                                                                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex -C <folder> app-server` as a session       | Runs the thread's turn, and reads threads. Ajour starts it in `<folder>`, the repository folder, which becomes the thread's working folder; the app-server itself ignores `-C`. It ends after 30 minutes without a send or read. |
| `codex resume -C <folder> <thread>` in a terminal | Opens the thread: Open on the handoff, when Open is set to a terminal.                                                                                                                                                           |
| `codex --version`                                 | Detects Codex. Times out after 10 seconds.                                                                                                                                                                                       |

The plugin also declares the `codex` link scheme. Open on a handoff opens `codex://threads/<thread>` in the Codex app.

### Sessions

Each handoff gets its own session, opened by its start. A plugin operation can't find a session another operation opened, except through the handoff that keeps its id in its native state. Ajour keeps at most two sessions for a plugin, so **at most two Codex handoffs run at once**. A third start fails with "Ajour keeps at most two Codex sessions running for this plugin, and both are busy with other handoffs. Hand off again once one of them is ready." One session for every handoff would have no such limit, but a start couldn't reach it.

A start opens the session, sends `initialize`, `initialized`, `thread/start` (with the model, if set), then `thread/name/set` and `turn/start`. The thread's id is the handoff's thread id. The app-server uses your Codex settings, such as its approval policy, sandbox and MCP servers; the plugin sets none of them. When `thread/start` answers but `turn/start` doesn't by 27 seconds, the handoff is kept with "Codex may have started the thread. Check Codex before handing off again.", and the session keeps running for a refresh to read.

A refresh reads each live thread in its own session, with `thread/read` and `thread/turns/list` (the last turn, without its items), batched and within 20 seconds. Once the turn has ended, or Codex waits for you, the refresh closes the session. That frees one of the two places and lets go of the thread. While a session holds a thread, the Codex app shows it with "This is open in another app" and can't continue it.

Threads without a live session are read the same way through one other app-server for the whole batch: a session of the batch that still runs a turn, else a new one that the refresh closes. A thread that no app-server has loaded reads as `notLoaded`, and its last turn says what happened.

### Questions and approvals

Codex can ask before it runs a command or edits a file, as your approval policy says, or ask you a question. The plugin can't answer, and while Ajour's session holds the thread, the Codex app can't either. So a refresh that sees one closes the session and reports Waiting for you, with "Codex asked for your approval or an answer, which Ajour can't give. Ajour let go of the thread, which stopped the turn: open it in Codex and tell it to go on." The handoff stays Waiting for you until another turn runs. Other requests Codex makes of its client get a JSON-RPC error, so Codex never waits for them.

### States

| Codex                                                                                   | Ajour                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Thread `active` with `waitingOnApproval` or `waitingOnUserInput`, or a question asked   | Waiting for you (`needs-you`), and the session closes                     |
| Thread `active`, or the session's own turn not recorded yet                             | Working                                                                   |
| Last turn `completed`                                                                   | Ready, labeled Completed                                                  |
| Last turn `interrupted` with an end time, such as when you stopped it                   | Ready, labeled Interrupted                                                |
| Last turn `failed`                                                                      | Failed, with Codex's error, such as an unsupported model                  |
| The plugin's turn `interrupted` without an end time, its session gone                   | Failed, labeled Stopped: the session ended mid-turn                       |
| Another turn `interrupted` without an end time                                          | Unknown: it may run in another Codex window, which reads the same way     |
| No turn recorded, though the plugin started one                                         | Failed, labeled Stopped: the session ended before Codex recorded the turn |
| Archived (its rollout is in `archived_sessions`)                                        | Done, labeled Archived                                                    |
| `thread/read` answers `thread not loaded: <id>`, as for a thread `codex delete` removed | Gone                                                                      |
| Another read failure, or the session can't open                                         | Keeps its last state, with the reason. Never gone.                        |
| No answer before the refresh deadline                                                   | Keeps its last state and its session, with the reason                     |

A session id Ajour no longer knows, after a quit or the idle timeout, is no evidence about the thread: the refresh reads it from Codex's files. The native state keeps the last state read, the label, the Open setting, the turn the plugin started, the session id while the turn runs, Codex's thread status, active flags and last turn status. Messages and paths are never stored.

### Settings

| Setting | Default          | What it does                                                                                                                                                           |
| ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open    | In the Codex app | Or in a terminal. The app opens the handoff's `codex://threads/<id>` link; the terminal runs `codex resume` in the folder. A handoff keeps the choice it started with. |
| Model   | Empty            | A model name for the thread. Codex checks it when the turn starts, so an unknown one fails the handoff with Codex's error.                                             |

The terminal follows the same rules as Claude Code's: Windows Terminal takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path.

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

The tests run the plugin against outputs recorded from the real CLIs: `t3` in `tests/fixtures` (version in `version.txt`), `claude` 2.1.325 on Windows in `tests/fixtures/claude`, `copilot` 1.0.112 on Windows, signed out with its own `COPILOT_HOME`, in `tests/fixtures/copilot`, and JSON-RPC exchanges with `codex app-server` 0.169.0 on Windows in `tests/fixtures/codex` (see its README), each from a throwaway repository with home paths replaced. `tests/codex-replay.mjs` replays a Codex exchange through the SDK fake's process sessions. `tests/fake-broker.mjs` expands each request into argv from `plugin.json` the way the broker does, with its refusals and the Windows Terminal character check. `tests/sdk-manifest.test.mjs` checks `plugin.json` against the SDK's `PluginManifest` type.
