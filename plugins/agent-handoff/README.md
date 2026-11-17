# Ajour agent handoff

An Ajour plugin that hands a backlog item off to a coding agent and follows its work. Its tools are [T3 Code](https://t3.codes), [Claude Code](https://code.claude.com), [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), [OpenCode](https://opencode.ai) and [Codex](https://developers.openai.com/codex). Ajour fills the prompt, title and branch, then the plugin starts a T3 Code thread with the `t3` CLI, a Claude Code background session with `claude`, a Copilot CLI session with `copilot`, an OpenCode session on the server `opencode serve` runs, or a Codex thread through `codex app-server`, and reads its state back where the tool reports it: working, waiting for you, ready for review, settled.

The plugin runs only the commands it declares, through Ajour's process broker, after you approve them in Access. Its only network access is OpenCode's server, at the address of a connection you add, through Ajour's credential broker: the plugin names a path such as `/session/status`, never a URL.

Ajour ends a plugin operation after 30 seconds, so a refresh stops waiting for a tool after 20. The handoffs it hasn't read by then, or whose command Ajour timed out or cut short, keep their last state, with the reason "T3 Code took too long; refreshing again later." (or Claude Code, OpenCode or Codex). A start stops waiting for what it started 27 seconds in. When Ajour stops a start command before its output is whole, the plugin says the tool may have started the work, so the user checks before handing off again. When Ajour refuses a command, the plugin says what to do, such as allowing the plugin in its Access section in Settings › Plugins.

## Threads you started

Ajour also offers to link a thread you started yourself when its title names a backlog item's key in brackets, such as `[PAY-12] Fix login redirect` (les-cabochons/ajour#724). For that, a tool that can list its threads in one repository folder, with their titles, answers `listThreads` and sets `listsThreads` in the manifest: T3 Code, Claude Code, OpenCode and Codex. Copilot CLI can't: 1.0.112 lists sessions only in its interactive picker (`copilot --resume`), and `copilot sessions` only imports one. So Copilot CLI leaves `listsThreads` off, and Ajour never asks it.

A listing answers each thread once, newest first, at most as many as Ajour asks for (it asks for 50), with what a start would have answered for that thread: the same thread id, link, resume command and native state. Open and refreshes then work on a linked thread as on one Ajour started. Ajour shows a linked thread as Unknown until its first refresh, which runs right after you link it. A listing that fails throws the reason, which Ajour keeps in the operation's event; the item gets no offer.

| Tool        | How it lists the folder's threads                                                                                                                                                                                                                          | Title                                                                        | `since`                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| T3 Code     | `t3 thread list --project <folder> --json`, the refresh's command. Top-level threads only, not a subagent's.                                                                                                                                               | T3's title                                                                   | Keeps threads whose `updatedAt` is later                |
| Claude Code | `claude agents --json --all --cwd <folder>`: the background sessions, and the interactive ones still open, started in the folder or under it.                                                                                                              | The session's name, from `--name` or `/rename`                               | Ignored: Claude Code doesn't say when a session changed |
| OpenCode    | `GET /path` for the folder the server runs in, then `GET /session` with `roots=true`, `directory=<that folder>` and `limit`. Top-level sessions only.                                                                                                      | The session's title                                                          | OpenCode's `start`, the first time it keeps             |
| Codex       | An app-server session in the folder, closed after: `hooks/list` reports the folder it runs in, then `thread/list` for that exact folder, by last update, for threads a person started (`cli`, `vscode`, `exec` and `appServer` sources), not a subagent's. | The thread's name, else the first line of its first prompt, as the app shows | Keeps threads whose `updatedAt` is later                |

Ajour never gives the plugin a folder's path. `claude` gets it in the `--cwd` argument, which Ajour fills. Codex and OpenCode report the folder they run in themselves, and the plugin uses it only to ask for that folder's threads; it never stores it.

- **Claude Code.** A background job opens with `claude attach`, as a started one does. An interactive session has no job to attach to, and is open in its terminal already, so its thread has no resume. Once you close it, Claude Code stops listing it, and its handoff keeps its last state with how to resume it.
- **OpenCode.** The server lists the sessions of the folder it runs in, for whichever folder Ajour asks about, just as a start hands off to the connection's server whatever the folder. Run one server per repository, as for starts. A session with no message yet reads as Starting, as a start's does before its prompt arrives.
- **Codex.** A listing holds one of the plugin's two sessions for a moment. While two handoffs run, it fails with "Both of Ajour's Codex sessions are running handoffs, so Ajour can't list Codex's threads until one is free." A listing has no settings, so a linked thread opens in the Codex app, the Open setting's default.

## T3 Code

### Commands it runs

| Command                                             | What for                                                                                                                                                                                                                                              |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 thread start <folder> - --title <title> --json` | Starts the thread. The prompt goes on stdin, and the title on one line. With a worktree, adds `--worktree <base> --branch <branch>`; with a provider, adds `--provider <provider>`; with a model, adds `--model <model>`. Times out after 20 seconds. |
| `t3 thread list --project <folder> --json`          | Reads every thread of a repository folder, once per folder on each refresh, and lists them for [linking](#threads-you-started). Times out after 10 seconds.                                                                                           |
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
| `claude agents --json --all --cwd <folder>`     | Lists the sessions started in the folder or under it, for [linking](#threads-you-started). Times out after 10 seconds.                                                                                                              |
| `claude attach <job> <folder>` in a terminal    | Opens the session: Open on the handoff, and right after a start in the terminal start mode. It also wakes a stopped job.                                                                                                            |
| `claude --version`                              | Detects Claude Code. Times out after 10 seconds.                                                                                                                                                                                    |

`--bg` chooses the session id and prints only the job's short id, so a start reads `claude agents` to find the full id, up to three times, a second apart, until 27 seconds. The full id is the handoff's thread id. If the list never shows the job, the start fails and names the job, so the user opens it with `claude attach <job>` instead of handing off again.

`claude --resume <id>` would also open a session, but it refuses one that still runs in the background once it is given any option, and a terminal command must name its folder: Ajour opens the terminal in the command's first folder argument. So Open uses `claude attach`, and the folder rides as an extra argument that `claude attach` ignores with a warning.

### Trust and where the start runs

Claude Code starts a background session only in a folder the user trusted. The plugin never accepts the trust prompt: an untrusted folder fails with "Trust this folder in Claude Code first: run claude in the repository folder once and accept the trust prompt, then hand off again."

`claude --bg` works in the folder it starts in; `--add-dir` only adds the folder. Ajour runs a capture command in its first folder argument since les-cabochons/ajour#746. An older Ajour starts it at the system root, which Claude Code refuses as an untrusted folder, and the plugin says so: "Ajour started Claude Code at the system root instead of the repository folder, so Claude Code refused it. This needs an Ajour update."

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

The plugin chooses each session's id, a new UUID, and starts `copilot` detached in the repository folder with the prompt on stdin. Without a terminal, `copilot` reads the prompt from piped stdin, works on it and exits when the task is done, which takes longer than a plugin operation. Ajour stops a capture command, and the work with it, at its timeout, so the start is a detached command that declares `stdin: "text"` (les-cabochons/ajour#748). The prompt reaches `copilot` whole: line breaks stay, it never shows in the process list, and the only limit is Ajour's 1,048,576 characters of stdin. A longer prompt is refused before `copilot` runs, with "Shorten the prompt."

Ajour writes the prompt, closes stdin, and returns the start once `copilot` has read it all. `copilot` 1.0.112 reads it as it starts, about a second on Windows (5 seconds on the first launch after install). If it stops first, or hasn't read it within Ajour's 10 seconds, Ajour stops it and the start fails with "Copilot CLI didn't read the prompt: it stopped first, or took more than 10 seconds to start. Run copilot in the repository folder to check that it starts, then hand off again."

### Commands it runs

| Command                                                                   | What for                                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `copilot -C <folder> --session-id <uuid> -n <title>`, the prompt on stdin | Starts the session, detached, in the folder. `-n` names it, which Copilot CLI allows only for a new session. With a model, adds `--model <model>` after the title. Returns once `copilot` has read the prompt. |
| The same with `--allow-all-tools` after the title or model                | The start when Tools is Allow all tools. It is a separate command, so Access shows it on its own.                                                                                                              |
| `copilot -C <folder> --resume <uuid>` in a terminal                       | Opens the session: Open on the handoff. It shows the session's work, and takes another turn. Without a terminal, `copilot --resume` refuses: "No prompt provided."                                             |
| `copilot --version`                                                       | Detects Copilot CLI. Times out after 10 seconds.                                                                                                                                                               |

The UUID is the handoff's thread id. A detached command gives no output and no exit code, so a start that `copilot` fails after it read the prompt still leaves the handoff, and Open resumes the session it wrote. A copilot that isn't signed in either does that or stops before it reads the prompt, which fails the start with "didn't read the prompt"; only the first was recorded, with the earlier argument start. Sign in with `copilot` and `/login` before handing off.

### Tools

Without a terminal, Copilot can't ask before it edits a file or runs a command. It runs only what is already allowed: read-only commands, and what you allowed with "Yes, and don't ask again" in this repository. It skips the rest. Open the session to allow them and continue. Allow all tools adds `--allow-all-tools`, so the session edits files and runs commands without asking.

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

## OpenCode

OpenCode runs its sessions on a server you start, `opencode serve`, which the plugin reaches over HTTP. Its tool uses a connection: add one on the plugin's page with the server's address, mark it on-premises (the address is on this computer), and pick it in OpenCode's settings. Ajour checks that the address answers as OpenCode when you save the connection.

Start the server in the repository folder, without a password, on 127.0.0.1:

```sh
opencode serve --hostname 127.0.0.1 --port 4096
```

Sessions work in the folder the server started in: Ajour never gives the plugin a folder's path, so it can't send one to OpenCode. For another repository, run another server on another port and add a connection for it. A server started with `OPENCODE_SERVER_PASSWORD` refuses the plugin's requests, which carry no password, and the plugin says so.

The plugin talks to OpenCode's v1 API, tested on OpenCode 1.19.5. It refuses an older server with "Run opencode upgrade, then restart opencode serve.", a 2.x one as not supported yet, and a server without the v1 routes by name.

### Requests it sends

| Request                               | What for                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /global/health`                  | Detects OpenCode and its version, checks a connection before Ajour saves it, and comes first in a start.                                                                                                                                          |
| `GET /path`                           | For [linking](#threads-you-started): the folder the server runs in. The plugin keeps only `directory`, and only for the listing.                                                                                                                  |
| `GET /session`                        | For linking: that folder's top-level sessions, newest first, with `roots=true`, `directory`, `limit` and, when Ajour gives `since`, `start`.                                                                                                      |
| `POST /session` with the title        | Creates the session, titled on one line.                                                                                                                                                                                                          |
| `POST /session/<id>/prompt_async`     | Sends the prompt, whole, in the body: `parts: [{ type: "text", text }]`, with the Model and Agent settings when set. OpenCode answers 204 once it has taken the prompt, not once the work is done.                                                |
| `DELETE /session/<id>`                | Removes a session the plugin just created when OpenCode refused its prompt, so no empty session stays. A prompt that times out may have been taken, so its session stays.                                                                         |
| `GET /session/status`                 | Once per refresh: the status of every busy session. Idle sessions aren't in it.                                                                                                                                                                   |
| `GET /permission` and `GET /question` | Once per refresh each: the pending permissions and questions of every session.                                                                                                                                                                    |
| `GET /session/<id>`                   | For each idle session without a pending request, whether it still exists and when it last changed (`time.updated`). Also for a pending request's session that isn't a handoff's, to find the handoff a subagent works for, up to three levels up. |
| `GET /session/<id>/message?limit=1`   | For a session that just stopped, or that changed since the plugin last read it, its last message, to tell an answer from an error. The plugin keeps only the error's name and message, never the conversation.                                    |

### Commands it runs

| Command                                                               | What for                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode attach <address> -s <session> --dir <folder>` in a terminal | Opens the session on the same server: Open on the handoff. Ajour fills `<address>` from the handoff's connection; the plugin passes only the session and the folder. Needs an Ajour build that includes les-cabochons/ajour#741, which passes the handoff's connection to Open. |
| `opencode --version`                                                  | Detects the `opencode` command, which Open needs. Times out after 10 seconds.                                                                                                                                                                                                   |

Detection reports OpenCode available when the server answers with a version the plugin supports and `opencode` is on PATH, and gives the server's version.

### States

One status, one permission and one question read per refresh, for every handoff of a connection, then one read for each session that isn't busy.

| OpenCode                                                                                                              | Ajour                                                                         |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A pending permission or question for the session, or for a subagent's session under it                                | Waiting for you (`needs-you`), labeled Asks for permission or Asks a question |
| `busy`                                                                                                                | Working                                                                       |
| `retry`                                                                                                               | Working, labeled Retrying, with OpenCode's reason                             |
| Idle or missing from the status map, just stopped, and its last message is an answer                                  | Ready for review                                                              |
| The same, and the last answer was stopped (`MessageAbortedError`)                                                     | Ready, labeled Stopped                                                        |
| The same, and the last answer has an error, such as `APIError`                                                        | Failed, with the error's name and message                                     |
| The same, and the last message is still the prompt a minute after it was sent, such as for a model OpenCode can't use | Failed: "OpenCode stopped without answering."                                 |
| The same, and the prompt is less than a minute old: OpenCode hasn't marked the session busy yet                       | Working, labeled Starting                                                     |
| Read as ready or failed before, still stopped, and its `time.updated` unchanged                                       | Keeps that state, label and reason, without reading its messages              |
| `GET /session/<id>` answers 404                                                                                       | Gone, labeled Not on this OpenCode server                                     |
| The server doesn't answer, refuses, or isn't OpenCode                                                                 | Unknown, with the reason. Never gone.                                         |
| Ajour refuses an answer it can't take, such as one larger than its 8 MB response cap                                  | Unknown, with Ajour's reason. Never gone.                                     |
| A handoff whose session id isn't an OpenCode one (`ses_…`)                                                            | Unknown, and no request goes out with it                                      |
| No answer before the refresh deadline, Ajour's request timed out, or Ajour is rate limiting the plugin's requests     | Keeps its last state, with the reason                                         |
| No connection                                                                                                         | Unknown, with "OpenCode needs a connection to its server."                    |

OpenCode has no settled state, and a stopped session can take another turn when you open it, so the plugin reports it as ready for review, never done. A session the server answers 404 for, such as one deleted in OpenCode, is gone. A later turn, such as one you take after Open, changes the session's `time.updated`, so the plugin reads its last message again and the state follows it. A refresh that keeps the last state with another reason, or makes it unknown, forgets `time.updated`, so the next read takes the label and reason from the last message again.

The native state keeps the last state, the label, OpenCode's status, the session's `time.updated`, the counts of pending permissions and questions, the retry attempt and the error's name. Messages, paths and the server's address are never stored, and a handoff has no web link.

### Settings

The server's address is the connection's. The tool's settings:

| Setting | Default | What it does                                                                                                       |
| ------- | ------- | ------------------------------------------------------------------------------------------------------------------ |
| Model   | Empty   | A provider and model as `provider/model`, such as `anthropic/claude-sonnet-4-5`. Empty uses your OpenCode default. |
| Agent   | Empty   | An OpenCode agent, such as `build` or `plan`. Empty uses your OpenCode default.                                    |

The terminal follows the same rules as Claude Code's: Windows Terminal takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path.

## Codex

Every handoff is a Codex thread that `codex app-server` starts and runs. The app-server is Codex's JSON-RPC server on stdio, and it owns a turn: the turn stops if the app-server ends before the turn is done. So the plugin doesn't run it as a command that returns. It runs it as an Ajour process session, which Ajour keeps running between plugin operations. The prompt and the title go to the app-server's stdin as JSON (`turn/start` and `thread/name/set`), never on a command line.

**A running turn ends when Ajour quits.** Ajour also ends the session, and the turn with it, when the plugin is turned off, updated or suspended, or after 30 minutes without a refresh. Codex then records the turn as interrupted, and the handoff shows Failed, labeled Stopped. Open the thread in Codex to go on.

**At most two Codex handoffs run at once**, because Ajour keeps at most two sessions for a plugin (see [Sessions](#sessions)).

**Removing a handoff leaves its turn running.** Ajour doesn't tell a plugin when a handoff is removed, and nothing refreshes it after, so its session keeps the turn running, and holds one of the two places, until the 30-minute idle timeout ends both. les-cabochons/ajour#755 asks Ajour to tell the plugin.

### Commands it runs

| Command                                           | What for                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex -C <folder> app-server` as a session       | Runs the thread's turn, reads threads, and lists them for linking. Ajour starts it in `<folder>`, the repository folder, which becomes the thread's working folder; the app-server itself ignores `-C`. It ends after 30 minutes without a send or read. |
| `codex resume -C <folder> <thread>` in a terminal | Opens the thread: Open on the handoff, when Open is set to a terminal.                                                                                                                                                                                   |
| `codex --version`                                 | Detects Codex. Times out after 10 seconds.                                                                                                                                                                                                               |

The plugin also declares the `codex` link scheme. Open on a handoff opens `codex://threads/<thread>` in the Codex app.

### Sessions

Each handoff gets its own session, opened by its start. A plugin operation can't find a session another operation opened, except through the handoff that keeps its id in its native state. Ajour keeps at most two sessions for a plugin, so **at most two Codex handoffs run at once**. One session for every handoff would have no such limit, but a start couldn't reach it.

A refresh may hold one of the two for a moment to read threads (see below), and so may a listing. So a start that finds both taken waits 3 seconds and tries once more. If both are still taken, it fails with "Ajour runs at most two Codex handoffs at once, and two are running. Hand off again when one finishes or waits for you." A refresh that can't open a session to read keeps every state, with "Both of Ajour's Codex sessions are running handoffs; refreshing again once one is free."

A start opens the session, sends `initialize`, `initialized`, `thread/start` (with the model, if set), then `thread/name/set` and `turn/start`. The thread's id is the handoff's thread id. The app-server uses your Codex settings, such as its approval policy, sandbox and MCP servers; the plugin sets none of them. When `thread/start` answers but `turn/start` doesn't by 27 seconds, the handoff is kept with "Codex may have started the thread. Check Codex before handing off again.", and the session keeps running for a refresh to read.

A refresh reads each live thread in its own session, with `thread/read` and `thread/turns/list` (the last turn, without its items), batched and within 20 seconds. The refresh closes the session once the turn has ended, Codex waits for you, Codex has no such thread, or the thread isn't `active` and its turns can't be read. That frees one of the two places and lets go of the thread. Every refresh resets the session's idle timeout, so a session kept for a turn that ended would never close. While a session holds a thread, the Codex app shows it with "This is open in another app" and can't continue it.

Threads without a live session are read the same way through one other app-server for the whole batch: a session of the batch that still runs a turn, else a new one that the refresh closes. A refresh with less than 2 seconds left opens none, and those threads keep their last state with the late reason. A thread that no app-server has loaded reads as `notLoaded`, and its last turn says what happened.

A new app-server starts no MCP servers to read: Codex starts them when it loads a thread to run it, with `thread/start`. With codex-cli 0.169.0 and a dummy MCP server in an isolated `CODEX_HOME`, `initialize`, `thread/read` and `thread/turns/list` of a thread on disk never started it, and `thread/start` did. So a refresh's reader costs one `codex` process for a few seconds, and nothing more.

### Questions and approvals

Codex can ask before it runs a command or edits a file, as your approval policy says, or ask you a question. The plugin can't answer, and while Ajour's session holds the thread, the Codex app can't either. So a refresh that sees one closes the session and reports Waiting for you, with "Codex asked for your approval or an answer, which Ajour can't give. Ajour let go of the thread, which stopped the turn: open it in Codex and tell it to go on." The handoff stays Waiting for you until another turn runs. A request whose method the plugin doesn't name counts as a question too when it ends in `Approval` (an approval) or has `/request` in it (a question), so a newer Codex's question never gets an error that would stop the turn. Other requests Codex makes of its client get a JSON-RPC error, so Codex never waits for them.

### States

| Codex                                                                                   | Ajour                                                                     |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Thread `active` with `waitingOnApproval` or `waitingOnUserInput`, or a question asked   | Waiting for you (`needs-you`), and the session closes                     |
| Thread `active`, or the session's own turn not recorded yet                             | Working                                                                   |
| A live thread `idle` with no turn, and no turn id from the start                        | Failed: "Codex didn't start the turn"                                     |
| Last turn `completed`                                                                   | Ready, labeled Completed                                                  |
| Last turn `interrupted` with an end time, such as when you stopped it                   | Ready, labeled Interrupted                                                |
| Last turn `failed`                                                                      | Failed, with Codex's error, such as an unsupported model                  |
| The plugin's turn `interrupted` without an end time, its session gone                   | Failed, labeled Stopped: the session ended mid-turn                       |
| Another turn `interrupted` without an end time                                          | Unknown: it may run in another Codex window, which reads the same way     |
| No turn recorded, though the plugin started one                                         | Failed, labeled Stopped: the session ended before Codex recorded the turn |
| Archived (its rollout is in `archived_sessions`)                                        | Done, labeled Archived                                                    |
| `thread/read` answers `thread not loaded: <id>`, as for a thread `codex delete` removed | Gone, and the live session closes                                         |
| A live thread not `active` whose turns can't be read                                    | Keeps its last state, with the reason, and the session closes             |
| Codex has no `thread/read` or `thread/turns/list` method                                | Keeps its last state, with the reason, and a live session closes          |
| Another read failure, a refusal from Ajour, or the session can't open                   | Keeps its last state, with the reason. Never gone.                        |
| No answer before the refresh deadline                                                   | Keeps its last state and its session, with the reason                     |

A session id Ajour no longer knows, after a quit or the idle timeout, is no evidence about the thread: the refresh reads it from Codex's files. The native state keeps the last state read, the label, the Open setting, the turn the plugin started, the session id while the turn runs, Codex's thread status, active flags and last turn status. The reason may hold the first line of one of Codex's own error messages, such as a failed turn's. Chat messages and paths are never stored.

### Settings

| Setting | Default          | What it does                                                                                                                                                           |
| ------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open    | In the Codex app | Or in a terminal. The app opens the handoff's `codex://threads/<id>` link; the terminal runs `codex resume` in the folder. A handoff keeps the choice it started with. |
| Model   | Empty            | A model name for the thread. Codex checks it when the turn starts, so an unknown one fails the handoff with Codex's error.                                             |

The terminal follows the same rules as Claude Code's: Windows Terminal takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path.

Open in a terminal while the handoff is Working runs `codex resume` beside Ajour's session, which still holds the thread and runs its turn. Two app-servers then work on one thread, and their turns may conflict. Wait until the handoff leaves Working, which closes the session, before opening it in a terminal. The Codex app refuses to continue a thread another app holds, so it can't conflict.

## Default prompt

The manifest declares the default prompt in `capabilities.handoff.promptTemplate` (les-cabochons/ajour#739). Ajour's template editor starts from it, and every tool gets the prompt it fills:

```text
[{{item.key}}] {{item.title}}

Work on this {{item.type}} in the {{repo.name}} repository, from the folder you start in. Work on the branch you are on, and open a pull request when you are done.

Link: {{item.url}}
Parent, if any: {{item.parent.key}} {{item.parent.title}}

{{item.description}}
```

It opens with the thread's name, `[KEY] title`, the same as Ajour's default title template. It uses only the slots Ajour fills for a handoff, and Ajour fills a missing parent or description with nothing. `tests/prompt-template.test.mjs` checks it with Ajour's template rules: known slots, the `slug` filter only, and at most 16 KB.

Templates saved in Ajour's template editor win over this default, so someone who saved templates with an earlier version keeps their own prompt.

## Development

Requirements: Node.js 24, Corepack with pnpm 10.7.0, and `just`.

```sh
just install
just test
just typecheck
```

The tests run the plugin against outputs recorded from the real CLIs: `t3` in `tests/fixtures` (version in `version.txt`), `claude` 2.1.325 on Windows in `tests/fixtures/claude`, `copilot` 1.0.112 on Windows, signed out with its own `COPILOT_HOME`, in `tests/fixtures/copilot` (the `stdin-` files from a start whose prompt was piped to a local model through Copilot CLI's BYOK variables), OpenCode 1.19.5's server on Windows, with its own XDG folders, in `tests/fixtures/opencode`, and JSON-RPC exchanges with `codex app-server` 0.169.0 on Windows in `tests/fixtures/codex` (see its README), each from a throwaway repository with home paths replaced. The OpenCode answers a live server gives only while a model works, such as a pending permission, are written from its `/doc` OpenAPI schema, in `tests/fixtures/opencode/schema`. The listing fixtures (`list-threads*.json`, `claude/agents-folder*.json`, `codex/list.jsonl` and `opencode/path.json` with `opencode/sessions*.json`) were recorded on this machine's own tools with read-only list commands, then had their titles, prompts and paths replaced, since the real ones are private; OpenCode's come from a throwaway server whose sessions were created with titles only, never a prompt. `tests/codex-replay.mjs` replays a Codex exchange through the SDK fake's process sessions. `tests/fake-broker.mjs` expands each request into argv from `plugin.json` the way the broker does, with its refusals and the Windows Terminal character check. The SDK's fake `ajour.http` answers OpenCode's requests and refuses one `plugin.json` doesn't declare. `tests/sdk-manifest.test.mjs` checks `plugin.json` against the SDK's `PluginManifest` type.
