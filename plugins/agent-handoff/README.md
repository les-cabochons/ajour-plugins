# Ajour agent handoff

An Ajour plugin that hands a backlog item off to a coding agent and follows its work. Its tools are [T3 Code](https://t3.codes), [Claude Code](https://code.claude.com), Claude Code desktop, [GitHub Copilot CLI](https://docs.github.com/copilot/how-tos/copilot-cli), [OpenCode](https://opencode.ai), [Codex](https://developers.openai.com/codex) and [VS Code](https://code.visualstudio.com). Ajour fills the prompt, title and branch, then the plugin starts a T3 Code thread with the `t3` CLI, a Claude Code background session with `claude`, which Claude Code desktop opens in the Claude desktop app, a Copilot CLI session with `copilot`, an OpenCode session with `opencode run`, a Codex thread through `codex app-server`, or a VS Code chat with `code chat`, and reads its state back where the tool reports it: working, waiting for you, ready for review, settled. Claude Code, Claude Code desktop and Codex also close a thread and keep its conversation, and OpenCode deletes one: see [Closing threads](#closing-threads).

The plugin runs only the commands it declares, through Ajour's process broker, after you approve them in Access. It has no network access and no connection of its own.

Ajour ends a plugin operation after 30 seconds, so a refresh stops waiting for a tool after 20. The handoffs it hasn't read by then, or whose command Ajour timed out or cut short, keep their last state, with the reason "T3 Code took too long; refreshing again later." (or Claude Code, OpenCode or Codex). A start stops waiting for what it started 27 seconds in. When Ajour stops a start command before its output is whole, or the tool exits without JSON the plugin can read, the plugin says the tool may have started the work, so the user checks before handing off again. When Ajour refuses a command, the plugin says what to do, such as allowing the plugin in its Access section in Settings › Plugins. Ajour runs at most 4 of a plugin's commands at once, and detection alone runs 4, so a command refused as `concurrency` is asked again every 250 ms for about 3 seconds before the plugin says Ajour is busy.

## What each tool supports

Each tool declares its features in `plugin.json`, and Ajour uses only those (les-cabochons/ajour#759). The plugin's page in Settings › Plugins lists them for each tool.

| Tool                | Starts threads | Follows state (`followsState`) | Finds threads (`listsThreads`) | Updates within seconds (`hooks`) | Closes threads (`closesThreads`)             |
| ------------------- | -------------- | ------------------------------ | ------------------------------ | -------------------------------- | -------------------------------------------- |
| T3 Code             | Yes            | Yes                            | Yes                            | No                               | No                                           |
| Claude Code         | Yes            | Yes                            | Yes                            | Yes, see [Hooks](#hooks)         | Archives, see [Closing](#closing-threads)    |
| Claude Code desktop | Yes            | Yes                            | Yes                            | Yes, see [Hooks](#hooks)         | Archives, see [Closing](#closing-threads)    |
| Copilot CLI         | Yes            | No, see [States](#states-2)    | No                             | No                               | No                                           |
| OpenCode            | Yes            | Yes                            | Yes                            | No                               | Deletes, see [Closing](#closing-threads)     |
| Codex               | Yes            | Yes                            | Yes                            | No                               | Archives, see [Closing](#closing-threads)    |
| VS Code             | Yes            | No, see [States](#states-5)    | No                             | No                               | No                                           |

Every tool sets the first three keys, even where the value is Ajour's default (`followsState` is true and `hooks` false when absent). Ajour refuses `hooks: true` unless the plugin declares a command with a `hook-url` argument and the tool follows state. A tool that doesn't follow state gets no hook, so none of Copilot CLI's or VS Code's commands takes one. Only a tool that closes threads sets `closesThreads`: absent, Ajour only forgets its own record of a handoff.

T3 Code also sets `ownWorktree` (les-cabochons/ajour#859): when Ajour's Start in is New worktree, it makes its own git worktree on the branch Ajour sends, starting from the source branch Ajour sends with it. With Main folder, Ajour sends neither and the thread runs in the project folder (les-cabochons/ajour#863). T3 Code can't start a thread in a folder outside its registered projects, so it can't run in a worktree Ajour makes. No other tool sets it. Ajour lists it on the plugin's page as "Makes its own worktree".

0.18.0 needs an Ajour that includes les-cabochons/ajour#863, which sends the source branch and lets Start in decide. With an older Ajour that has #859, T3 Code makes a worktree whenever Ajour sends a branch, from main or master. 0.18.0 also opens Claude Code's trust terminal in the repository folder when the start is in a worktree, see [Trust](#trust-and-where-the-start-runs).

0.17.0 needs an Ajour that includes les-cabochons/ajour#859, which adds `ownWorktree`. An older Ajour refuses this manifest.

0.16.0 needs an Ajour that includes les-cabochons/ajour#850, which adds `closesThreads` and `closeThread`. An older Ajour refuses this manifest. It also adds the `claude rm`, `opencode api session.interrupt` and `opencode session delete` commands, so Ajour asks to allow the plugin's new access once.

0.9.0 needs an Ajour that includes les-cabochons/ajour#764, which adds `followsState` and `hooks`. An older Ajour refuses this manifest.

Since 0.14.0, OpenCode means OpenCode 2, through its CLI and without a connection. OpenCode 1's `opencode serve` API isn't supported anymore, and a connection saved for it has no use. See [OpenCode](#opencode).

Since 0.11.1, every tool gets a title of at most 80 characters. A longer one ends in "…" after its last whole word, and keeps its start, where the item's key is. Copilot CLI 1.0.109 exits when a session name passes 100 characters, and its detached start hid that: Ajour showed the handoff as Started, and Open found no session.

Since 0.11.0, each tool's `iconSvg` is its own logo, drawn as a tile in its own colours. Ajour draws a tool's icon as an image, where `currentColor` is black on both themes, so a logo that used it faded on the dark theme. The logos are their owners' trademarks, used here only to name each tool.

## Threads you started

Ajour also offers to link a thread you started yourself when its title names a backlog item's key in brackets, such as `[PAY-12] Fix login redirect` (les-cabochons/ajour#724). For that, a tool that can list its threads in one repository folder, with their titles, answers `listThreads` and sets `listsThreads` in the manifest: T3 Code, Claude Code, Claude Code desktop, OpenCode and Codex. Copilot CLI can't: 1.0.112 lists sessions only in its interactive picker (`copilot --resume`), and `copilot sessions` only imports one. So Copilot CLI leaves `listsThreads` off, and Ajour never asks it. VS Code's `code` command lists no chats either, so VS Code leaves it off too.

A listing answers each thread once, newest first, at most as many as Ajour asks for (it asks for 50), with what a start would have answered for that thread: the same thread id, link, resume command and native state. Open and refreshes then work on a linked thread as on one Ajour started. Ajour shows a linked thread as Unknown until its first refresh, which runs right after you link it. A listing that fails throws the reason, which Ajour keeps in the operation's event; the item gets no offer.

| Tool        | How it lists the folder's threads                                                                                                                                                                                                                          | Title                                                                        | `since`                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------- |
| T3 Code     | `t3 thread list --project <folder> --json`, the refresh's command. Top-level threads only, not a subagent's.                                                                                                                                               | T3's title                                                                   | Keeps threads whose `updatedAt` is later                |
| Claude Code | `claude agents --json --all --cwd <folder>`: the background sessions, and the interactive ones still open, started in the folder or under it.                                                                                                              | The session's name, from `--name` or `/rename`                               | Ignored: Claude Code doesn't say when a session changed |
| OpenCode    | `opencode session list --format json -n <limit>` in the folder: the top-level sessions of the folder's project, a subfolder's included.                                                                                                                  | The session's title                                                          | Keeps sessions whose `updated` is later                 |
| Codex       | An app-server session in the folder, closed after: `hooks/list` reports the folder it runs in, then `thread/list` for that exact folder, by last update, for threads a person started (`cli`, `vscode`, `exec` and `appServer` sources), not a subagent's. | The thread's name, else the first line of its first prompt, as the app shows | Keeps threads whose `updatedAt` is later                |

Ajour never gives the plugin a folder's path. `claude` gets it in the `--cwd` argument, which Ajour fills, and `opencode session list` runs in it. Codex reports the folder it runs in itself, and the plugin uses it only to ask for that folder's threads; it never stores it.

- **The same work under each tool you turn on.** Tools that run each other list the same work under each of them. T3 Code runs its Codex and Claude threads as real Codex threads and Claude Code sessions, so with T3 Code, Codex and Claude Code all turned on, one T3 Code thread is offered under T3 Code, Codex and Claude Code. That is intended: you choose which tools Ajour uses.
- **Claude Code.** A background job opens with `claude attach`, as a started one does. A job you resumed in a terminal reads its live state, and still attaches to the job. An interactive session has no job to attach to, and is open in its terminal already, so its thread has no resume. Once you close it, Claude Code stops listing it, and its handoff keeps its last state with how to resume it.
- **Claude Code desktop.** Lists the folder's sessions as Claude Code does, and each background job also gets the Claude app's link. An interactive session gets none: it is open in its terminal.
- **OpenCode.** OpenCode lists by project, which it finds from the folder's git repository, so a session started in a subfolder is listed too.
- **Codex.** A listing holds one of the plugin's two sessions for a moment. While two handoffs run, it fails with "Both of Ajour's Codex sessions are running handoffs, so Ajour can't list Codex's threads until one is free." A listing has no settings, so a linked thread opens in the Codex app, the Open setting's default. `hooks/list` reports the folder Ajour started the app-server in, since the app-server ignores `-C`. If it reports a filesystem root such as `C:\` or `/`, the listing fails rather than list the root's threads.

## Closing threads

Close on the Handoffs card removes a finished or abandoned handoff from the item and closes its thread in the tool (les-cabochons/ajour#850). A tool that can close threads sets `closesThreads` in the manifest: `archive` when the tool keeps the conversation where you can reopen it, `delete` when the tool deletes it for good, which Ajour asks you to confirm first. Ajour calls `closeThread` only for those tools, with the handoff as a state read sends it.

The plugin stops the thread's work first when it runs, then closes the thread. It answers `{}` once the thread is closed, and also when the tool no longer has the thread: a thread already removed, archived or deleted counts as closed. A refusal throws the tool's reason, and the handoff stays on the card. A close stops waiting 27 seconds in and says the thread may still be open; closing again finds it closed.

| Tool                             | `closesThreads` | What it runs                                                                                                                                       | What happens to the conversation                                                                                                                                                  |
| -------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code, Claude Code desktop | `archive`       | `claude agents --json --all` to find the session's job, `claude stop <job>` when the job runs, then `claude rm <job>`                             | Kept. `claude rm` removes the session from `claude agents` and deletes its worktree when that is safe. `claude --resume` lists the conversation, and the Claude app still imports it. |
| Codex                            | `archive`       | Through the app-server: `thread/read`, `turn/interrupt` when a turn runs in the handoff's own session, then `thread/archive`                        | Kept, in Codex's `archived_sessions` folder. `codex unarchive <thread>` brings it back.                                                                                          |
| OpenCode                         | `delete`        | `opencode api session.interrupt --param sessionID=<session>`, then `opencode session delete <session>`                                             | Deleted for good, with its child sessions.                                                                                                                                       |

- **Claude Code.** `claude rm` refuses a session whose worktree holds work it would lose, such as commits on no remote. The plugin passes Claude Code's whole refusal to you, after "Claude Code kept the session:", and never passes `--discard-unpushed` or `--force-remove-worktree`: push the work, or run the command Claude Code names yourself. Only a background job can be removed. A session that a terminal or the Claude app runs, even one that started as a job, fails with "Claude Code runs this session in a terminal or the Claude app, where Ajour can't stop it. Exit it there, then close it again." A job is stopped first when its state is working or blocked, or a process runs it. If `claude stop` fails, nothing is removed.
- **Codex.** A turn that runs in the handoff's own session is interrupted through that session. The plugin then reads the thread every 250 ms, for at most 5 seconds, until the turn stopped, archives the thread, and closes the session. If Codex refuses the interrupt, nothing is archived and the session stays for the next refresh. A thread without a live session is archived through a new app-server in the folder, which takes one of the two session places: while two handoffs run, the close fails with "Both of Ajour's Codex sessions are running handoffs, so Ajour can't close this thread until one is free." Another app-server can't see a turn that runs in another Codex window, such as the Codex app, so the close doesn't stop it.
- **OpenCode.** `session.interrupt` does nothing to an idle session. If OpenCode can't stop the run, nothing is deleted.
- **T3 Code, Copilot CLI and VS Code** set no `closesThreads`, so Close only removes the handoff from the item and the thread stays in the tool. T3 Code's `t3` command can't archive or settle a thread yet (pingdotgg/t3code discussion #27428). Copilot CLI and VS Code's `code` command have no command that closes a session or a chat.

How the tools close was read from `claude rm --help` and `claude stop --help` in Claude Code 2.1.328, `codex archive --help` and the app-server's method names in codex-cli 0.170.0, and `opencode session delete --help` and the `session.interrupt` operation in OpenCode 2.3.2. No real thread was closed to record them, so the tests answer `claude rm`'s refusal, `turn/interrupt`, `thread/archive` and both OpenCode commands with outputs that aren't recorded.

## T3 Code

### Commands it runs

| Command                                             | What for                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3 thread start <folder> - --title <title> --json` | Starts the thread. The prompt goes on stdin, and the title on one line. With a branch from Ajour, adds `--worktree <source> --branch <branch>`, where the source is the one Ajour sends; with a provider, adds `--provider <provider>`; with a model, adds `--model <model>`. Times out after 20 seconds. |
| `t3 thread list --project <folder> --json`          | Reads every thread of a repository folder, once per folder on each refresh, and lists them for [linking](#threads-you-started). Times out after 10 seconds.                                                                                                                                               |
| `t3 thread show <thread> --json --messages 0`       | Reads a live thread's pending requests, a new thread's link, and the state of a thread missing from the list. Runs in the repository folder, which it doesn't take as an argument. `--messages 0` keeps the conversation out of the plugin. Times out after 10 seconds.                                   |
| `t3 --version`                                      | Detects T3 Code: it is available once this answers. Times out after 10 seconds.                                                                                                                                                                                                                           |

`<folder>` is one of the project's repository folders, which Ajour resolves. The folder must already be a T3 Code project. A start stops waiting for the new thread's link 27 seconds in and keeps the thread.

The plugin also declares the `t3code` link scheme. Open on a handoff opens the thread in the T3 Code app, at `t3code://threads/<environment>/<thread>`: the path of T3's web link, `https://app.t3.codes/threads/<environment>/<thread>`, which the app routes to the same page. A link T3 gives for another address stays https. Adding the scheme is new access, so 0.10.1 needs your approval again.

T3 Code 0.1.10 nightly creates the folder it starts in, so every command that reaches the server fails at a root such as `C:\`, with `PermissionDenied: FileSystem.makeDirectory`. Ajour starts a command in its first folder argument, and one without a folder at the system root. `t3 thread show` takes no folder argument, so it declares the repository folder as its working folder instead (`"cwd": "{folder:folder}"`, les-cabochons/ajour#761): Ajour starts it there and never adds the folder to its arguments. Access review says "Runs in the repository folder", so 0.8.0 needs your approval again, and it needs an Ajour that includes les-cabochons/ajour#762; an older Ajour refuses this manifest. `t3 --version` answers at the root, so detection runs only that and never asks whether a server runs; a start or refresh says "T3 Code isn't running. Start T3 Code, then refresh."

The `t3` CLI logs warnings to stdout, before its JSON. A CLI older than the T3 Code app prints `WARN (#20): Database migration history diverges from this build` before every answer (`t3` 0.1.5 against T3 Code 0.1.11). 0.9.0 read none of those answers: a listing failed with "T3 Code returned output Ajour can't read.", and a start that created its thread said it failed, so handing the item off again failed on its existing branch. The plugin now reads the JSON that starts on a later line. Output with no JSON says what `t3` printed first, and a start says T3 Code may have started the thread.

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

| Setting  | Default | What it does                                                                                                                  |
| -------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Provider | Empty   | A T3 Code provider instance ID, such as `claudeAgent`. A provider needs a model. Leave both empty for the project's defaults. |
| Model    | Empty   | A model slug, such as `claude-opus-5-5` or one with slashes. It can be set without a provider.                                |

The tool has no worktree setting. Ajour's Start in decides (les-cabochons/ajour#863). A start with a branch runs in a new T3 Code worktree on that branch, from the source Ajour sends, such as `origin/main`. A start without a branch runs in the project folder. 0.17.0 had the settings "Create a worktree" and "Worktree base"; a value saved for either is ignored.

Ajour checks that a source you picked exists before it calls the plugin. T3 Code still refuses a source that the repository and its remotes don't have before it creates anything, so trying again is safe. The start is then refused with `"<source>" doesn't exist in <folder>, so T3 Code can't start the worktree. Pick another source branch in Ajour.` The refusal names no `setting`, so Ajour shows the message and asks for nothing. A start with a branch and no source comes from an Ajour without #863. It tries `main`, then `master`. When neither exists, it is refused with a message that says to update Ajour.

When the hand-off branch already exists, T3 Code starts nothing and the start is refused with `branchExists: true`. Ajour then offers to link the item's thread, the one whose title names the item's key. An Ajour without #819 shows the reason alone.

## Claude Code

Every handoff is a Claude Code background session (`claude --bg`), the only start that takes a prompt on stdin. A prompt never goes on the command line, where Ajour refuses line breaks and other processes can read it. The session works in the repository folder, keeps its own permission settings, and shows in `claude agents`.

### Commands it runs

| Command                                                            | What for                                                                                                                                                                                                                            |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude --bg --name <title> --add-dir <folder>`                    | Starts the session with the prompt on stdin and the title on one line. With a model, adds `--model <model>` before `--add-dir`. Prints the job's short id, such as `backgrounded · e2cf2a01 · <title>`. Times out after 20 seconds. |
| `claude --bg --name <title> --settings <hooks> --add-dir <folder>` | The same start when Ajour gives it a hook: `<hooks>` is Claude Code settings whose HTTP hooks post to it. See [Hooks](#hooks).                                                                                                      |
| `claude agents --json --all`                                       | Lists every session, once per refresh for all folders, and once after a start to read the new job's full session id. Times out after 10 seconds.                                                                                    |
| `claude agents --json --all --cwd <folder>`                        | Lists the sessions started in the folder or under it, for [linking](#threads-you-started). Times out after 10 seconds.                                                                                                              |
| `claude attach <job> <folder>` in a terminal                       | Opens the session: Open on the handoff, and right after a start in the terminal start mode. It also wakes a stopped job.                                                                                                            |
| `claude --version`                                                 | Detects Claude Code. Times out after 10 seconds.                                                                                                                                                                                    |
| `claude` in a terminal                                             | Opens the trust prompt in the repository folder, when Claude Code refused a start in it or in one of its worktrees as untrusted. See [Trust](#trust-and-where-the-start-runs).                                                      |
| `claude stop <job>`                                                | Stops a job that runs before a [close](#closing-threads). Claude Code desktop also runs it on refresh, see [Claude Code desktop](#claude-code-desktop). Times out after 10 seconds.                                                 |
| `claude rm <job>`                                                  | [Closes](#closing-threads) the session: removes it from `claude agents`, keeping its conversation. Never with `--discard-unpushed` or `--force-remove-worktree`. Times out after 15 seconds.                                       |

`--bg` chooses the session id and prints only the job's short id, so a start reads `claude agents` to find the full id, up to three times, a second apart, until 27 seconds. The full id is the handoff's thread id. If the list never shows the job, the start fails and names the job, so the user opens it with `claude attach <job>` instead of handing off again.

`claude --resume <id>` would also open a session, but it refuses one that still runs in the background once it is given any option, and a terminal command must name its folder: Ajour opens the terminal in the command's first folder argument. So Open uses `claude attach`, and the folder rides as an extra argument that `claude attach` ignores with a warning.

### Trust and where the start runs

Claude Code starts a background session only in a folder the user trusted, and asks only in an interactive session. Claude Code 2.1.327 has no flag or command that trusts a folder. So when `claude --bg` refuses a folder, the plugin opens `claude` in a terminal there and the start fails with "Claude Code doesn't trust this folder yet. Ajour opened Claude Code in a terminal there: accept its trust prompt, then hand off again." The user accepts the prompt, which Claude Code remembers for the folder, closes or keeps that session, and hands off again. The plugin never accepts the prompt itself.

When Ajour starts the session in a worktree it made, the terminal opens in the worktree's repository folder instead, which Ajour sends as `repositoryFolder` (les-cabochons/ajour#857). Ajour deletes the worktree of a start that failed, so a terminal there finds no folder and shows no prompt. Trusting the repository folder is enough, because Claude Code's trust of a folder covers the worktrees under it. The message then names that folder: "Claude Code doesn't trust the repository folder "ajour" yet. Ajour opened Claude Code in a terminal there: accept its trust prompt, then hand off again." The session still starts in the worktree. An Ajour that sends no `repositoryFolder` gets the terminal in the start's folder, as before.

The prompt can't go to that terminal instead: a terminal command takes no stdin, and Ajour refuses an argument with a line break. When Ajour can't open the terminal, such as a Windows folder path with `&`, the start says to run `claude` in the folder, with Ajour's reason. The terminal command came in 0.12.0, so Ajour asks to allow it once in the plugin's Access section.

`claude --bg` works in the folder it starts in; `--add-dir` only adds the folder. Ajour runs a capture command in its first folder argument since les-cabochons/ajour#746. An older Ajour starts it at the system root, which Claude Code refuses as an untrusted folder, and the plugin says so: "Ajour started Claude Code at the system root instead of the repository folder, so Claude Code refused it. This needs an Ajour update."

### Hooks

A start tells Ajour when to read the session again, so the item says Waiting for you within seconds of the session asking for you, instead of at the next refresh (les-cabochons/ajour#726, ADR 0020). Ready still arrives at the next refresh: see the limits below for why `Stop` isn't sent. Claude Code and Claude Code desktop are the only tools that declare `hooks: true`. Ajour gives each start a hook URL, a loopback address with that handoff's own token. When a start has one, the plugin runs `claude-start-hook` instead of `claude-start`, which adds `--settings` and this fixed text, where Ajour writes the URL at each `{url}`:

```json
{
  "hooks": {
    "Notification": [
      { "hooks": [{ "type": "http", "url": "{url}", "timeout": 5 }] }
    ],
    "SessionEnd": [{ "hooks": [{ "type": "http", "url": "{url}" }] }]
  }
}
```

The manifest declares it as a `hook-url` argument with this `template`, on one line. Ajour fills it, only during a start; the plugin never passes the URL, and never passes settings through a `text` argument, since Claude Code settings can declare `command` hooks that run anything. `SessionStart` takes no `http` hook, so it is left out. A post only makes Ajour read the session from `claude agents` again; Ajour never reads its body, and `claude agents` stays the source of the state. A hook that can't reach Ajour, such as while Ajour is closed, loses nothing: refreshes still run on their schedule.

An `http` hook waits 600 seconds for an answer by default, so `Notification` gives up after 5. `SessionEnd` hooks already share a 1.5-second budget, which a longer `timeout` would raise: checked on Claude Code 2.1.326, a signed-out `claude -p` whose `SessionEnd` hook posted to a listener that never answered took about 1.5 seconds longer to exit, and about 5 seconds longer with `"timeout": 5`.

`--settings` is a per-start flag, so your Claude Code settings files are never edited, and its hooks add to yours rather than replace them. Checked on Claude Code 2.1.325 on Windows with its own `CLAUDE_CONFIG_DIR`, signed out so no model turn ran: with a `SessionEnd` command hook in that folder's `settings.json`, `claude -p` with these settings ran both that hook and the HTTP hook, and `claude --bg` with them carried the settings into the background session, which posted `SessionEnd` with the user's hook when `claude stop` ended it. A signed-in `claude -p` posted `SessionEnd` about 4.6 seconds after it started (les-cabochons/ajour-plugins#51).

Limits:

- **A hook's reply can steer the session, so `Stop` isn't sent.** Claude Code reads a 2xx reply with a JSON body as a hook's output. For `Stop`, `{"decision":"block","reason":"…"}` keeps Claude working, with `reason` as its next instruction. Ajour never answers that way, but while Ajour is closed any program can listen on its port and answer for it, and so give the session instructions. `Notification` and `SessionEnd` have no decision control: their reply can't block, add context for Claude or change permissions, and Claude Code discards their `continue` and `systemMessage` (Claude Code's hooks reference, read for 2.1.326). A `Notification` reply can still return `terminalSequence`, which Claude Code writes to the session's terminal. `Stop` can come back once its hook can't be answered, such as a relay that posts to Ajour and ignores the reply (les-cabochons/ajour#765).
- **Only a start gets hooks.** Open gives the session no hook URL, since Ajour keeps only the token's hash, and neither does a thread you started yourself and linked. Those follow refreshes. Whether `claude attach` keeps the start's settings when it wakes a stopped job isn't checked.
- **Both start modes carry them.** The terminal start mode still starts the session with `claude --bg`, a capture command, and the terminal only attaches to it. A terminal command couldn't carry the settings on Windows: Windows Terminal's argument check refuses their braces and quotes.
- **Without a hook, a start runs `claude-start`** and the handoff follows refreshes, as before.
- **Hooks fail without blocking once Ajour stops answering.** Once the handoff has been done or gone for 24 hours, its token is revoked, and while Ajour is closed nothing answers. Either way the post fails without blocking the session, and Claude Code may show "hook error" lines.
- **The settings are part of the command you approve.** Access review shows them with `<hook-url>` in place of the URL, so 0.7.0 needs your approval again. It also needs an Ajour that includes les-cabochons/ajour#758, which adds the `hook-url` argument; an older Ajour refuses this manifest.
- **The token is on the command line and on disk.** While the session runs, it is in the command line of Claude Code's background processes, where other programs running as you can read it. Claude Code also saves the start's flags in its config folder, `CLAUDE_CONFIG_DIR` or `~/.claude`: in `daemon/roster.json` while the session runs, and in `jobs/<job>/state.json` (`respawnFlags`) until `claude rm` removes the job, even after `claude stop`. Checked on Claude Code 2.1.326 on Windows with its own `CLAUDE_CONFIG_DIR`, signed out. With the token, a program can only make Ajour refresh that handoff early, within limits, until the token is revoked. ADR 0020 has the details, including a program that takes Ajour's port while Ajour is closed and so receives what the hook posts.

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

## Claude Code desktop

Claude Code desktop starts the same background session as [Claude Code](#claude-code), with the same commands, [hooks](#hooks) and [states](#states-1), and opens it in the [Claude desktop app](https://claude.ai/download) instead of a terminal. Open goes to `claude://resume?session=<session id>`, a link from which the app imports a CLI session and opens it. The plugin declares the `claude` scheme for it.

| Command             | What it is for                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `claude stop <job>` | Stops the background job once its turn ended or it waits for you, so the Claude app can take the session over. Times out after 10 seconds. |

The Claude app can't take a turn in a session that a background job runs, even a job whose turn ended. It shows "This session is running in the background" with a Try again button. So each refresh of a Claude Code desktop handoff runs `claude stop` on a background job that is done or waits for you. A working job is left alone: Open while it works shows the session in the app, with that message, until the turn ends and a refresh stops the job. `claude stop` keeps the job and its transcript, and prints `stopped <job>` again for a job already stopped.

- **Waiting for you.** A job stopped while it waited for you no longer says so in `claude agents`. The handoff stays Waiting for you, with `released: true` and "Claude Code waits for you. Ajour stopped its background session so the Claude app can take it over: open it there and answer, or tell it to go on.", until a process runs the session again. The question is in the transcript the app shows; a tool call that waited for permission didn't run.
- **Going on in the app.** The app runs the session in its own bundled `claude`, which `claude agents` lists as an interactive session with the same session id, so the handoff follows it, as it follows a job resumed in a terminal.
- **A stop that fails** keeps the state read, with "Ajour couldn't stop Claude Code's background session, so the Claude app can't go on with it yet. Ajour tries again at the next refresh." and claude's reason. A job that waited for you stays released: a stop that outlived the refresh deadline can still land, and a job still running is stopped again.
- **Missing from the list.** After `claude rm`, the app still imports the session from its transcript, so the handoff keeps its last state and says Open still opens it.
- **A terminal next to it.** A refresh stops a done job even if you attached to it in a terminal yourself. Use Claude Code to work in a terminal.
- **Detection.** One `claude --version` detects both Claude tools. Whether the Claude app is installed isn't checked: without it, Open fails. The Claude desktop app runs on macOS and Windows.

Checked on Claude 6.6395.1 for macOS with Claude Code 2.1.328: a running session, a stopped one and one `claude rm` removed all imported, and only the stopped one could take a turn. Windows wasn't checked. Anthropic doesn't document the `claude://resume` link, so a later app can change it. 0.15.0 adds the `claude` scheme and the `claude-stop` command, so Ajour asks to allow the plugin's new access once.

### Settings

| Setting | Default | What it does                                                                                         |
| ------- | ------- | ---------------------------------------------------------------------------------------------------- |
| Model   | Empty   | A model alias such as `opus` or `sonnet`, or a full model name. Empty uses your Claude Code default. |

There is no start mode: the app can't open a session until its turn ends.

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

Copilot CLI has no command that reports a session's state, so the tool sets `followsState: false`. Ajour shows each Copilot CLI handoff as Started: it never calls `readHandoffStates` for it, never polls it, gives its start no hook, and offers no Refresh. Open still resumes the session. The plugin answers a `readHandoffStates` for Copilot CLI with an error and runs no command; Ajour never sends one. Copilot CLI handoffs started before 0.9.0 turn Started at Ajour's next check, and lose their Refresh.

Checked on `copilot` 1.0.112 on Windows, signed out with its own `COPILOT_HOME`: `copilot sessions` has only `import`, and `copilot help sessions` names `/session info` as the way to see a session's details, which works only inside an interactive session. `copilot --acp` reports a session's activity only to the editor that runs that session. Copilot CLI keeps each session's events in `session-state/<uuid>/events.jsonl` and its metadata in `workspace.yaml` under `COPILOT_HOME`, but no declared command can read them, and an event log alone can't tell a finished task from one that waits for you or failed.

The native state keeps the label, Started, and the Tools setting. Nothing else about the session is read, so a handoff has no web link.

The VS Code link `vscode://agents/agent-host-session/copilotcli/<uuid>` has the format VS Code builds, but nobody has seen VS Code adopt a session the standalone CLI started. Until that is tested, the plugin declares no `vscode` scheme and Open uses the terminal.

### Settings

| Setting | Default                           | What it does                                                                        |
| ------- | --------------------------------- | ----------------------------------------------------------------------------------- |
| Tools   | Only the ones you already allowed | Or Allow all tools, which adds `--allow-all-tools` to the start.                    |
| Model   | Empty                             | A model name, or `auto` to let Copilot choose. Empty uses your Copilot CLI default. |

The terminal follows the same rules as Claude Code's: Windows Terminal takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path.

## OpenCode

The plugin hands off to OpenCode 2, tested on 2.3.2. OpenCode 2 runs one background service on this computer, which the OpenCode app starts, or `opencode service start`. The `opencode` CLI finds that service and signs in to it by itself, so the plugin goes through the CLI: no connection, address or password. Detection refuses an older version with "Run opencode upgrade." and a 3.x one as not supported yet.

OpenCode 1 isn't supported. Its `opencode serve` HTTP API is gone in OpenCode 2: every path outside `/api/` answers with the web app's page, and `/api/` asks for the service's password. A start over HTTP couldn't choose the session's folder either, since Ajour never gives the plugin a folder's path, and a session created without one runs in the service's default folder, the home folder.

A start runs without a terminal, so nobody can answer OpenCode. `opencode run` rejects each action the agent would ask permission for and cancels a question, and the model goes on without it. OpenCode 2's `build` agent asks only before it reads a `.env` file. So a handoff never waits for you; open it to see what OpenCode skipped.

### Commands it runs

| Command                                                                         | What for                                                                                                                                                                                                                  |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `opencode run -s <session> --title <title>` in the folder, detached             | Starts the handoff. The plugin chooses the session id, in OpenCode's own form, and `opencode run` creates the session under it, in its working folder. The prompt goes on stdin, whole, never on the command line. Adds `--model` and `--agent` when set. It runs one turn and exits. |
| `opencode api session.get --param sessionID=<session>`                          | One read per handoff and refresh: whether the session exists, and its `time` and `outcome`. Times out after 10 seconds.                                                                                                  |
| `opencode api session.message.list --param sessionID=<session> --param limit=1` | For a run that just failed, its newest message, which holds OpenCode's error. The plugin keeps only the error's type and message, never the conversation. Times out after 10 seconds.                                     |
| `opencode session list --format json -n <limit>` in the folder                  | For [linking](#threads-you-started): the sessions of the folder's project, newest first. Times out after 10 seconds.                                                                                                     |
| `opencode api session.interrupt --param sessionID=<session>`                    | Stops the session's run before a [close](#closing-threads). Does nothing to an idle session. Times out after 10 seconds.                                                                                                  |
| `opencode session delete <session>`                                             | [Closes](#closing-threads) the session: deletes it and its child sessions for good. Times out after 10 seconds.                                                                                                           |
| `opencode <folder> -s <session>` in a terminal                                  | Opens the session in OpenCode's terminal interface: Open on the handoff.                                                                                                                                                  |
| `opencode --version`                                                            | Detects OpenCode and its version (`opencode v2.3.2`). Times out after 10 seconds.                                                                                                                                         |

`opencode run` takes its folder from `PWD` before its working directory. Ajour sets `PWD` to the command's folder since les-cabochons/ajour#836; an older Ajour started from a terminal passes its own, and the session would start there.

A slot is a whole argument, so the plugin passes `sessionID=<session>` as one text value. Each `opencode api` command names one fixed operation, and the plugin checks the session id first.

### States

One read per handoff and refresh, four at a time, and one more for a run that just failed. OpenCode records the end of each run on the session: `time.busy` when a run starts, `time.idle` and `outcome` when it ends.

| OpenCode                                                                                       | Ajour                                                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `time.busy` without a later `time.idle`: a run is going                                        | Working                                                                    |
| `outcome` is `succeeded`                                                                       | Ready for review                                                           |
| `outcome` is `interrupted`, such as when you stop it                                           | Ready, labeled Stopped                                                     |
| `outcome` is `failed`                                                                          | Failed, with OpenCode's error, such as "Model unavailable: …"              |
| Read as failed before, and `time.idle` unchanged                                               | Keeps that reason, without reading the messages again                      |
| The session exists without a run, less than a minute old                                      | Working, labeled Starting                                                  |
| The same, older                                                                                | Failed: "OpenCode didn't start on the prompt. Open the session to see why." |
| OpenCode doesn't have the session, less than a minute after the start                          | Working, labeled Starting: `opencode run` hasn't created it yet            |
| The same, later, such as a session deleted in OpenCode, or one from OpenCode 1                 | Gone, labeled Not on OpenCode                                              |
| `opencode` fails, or Ajour refuses it                                                          | Unknown, with the reason. Never gone.                                      |
| A handoff whose session id isn't an OpenCode one (`ses_…`)                                     | Unknown, and no command runs with it                                       |
| No answer before the refresh deadline, Ajour timed the command out, or Ajour is rate limiting  | Keeps its last state, with the reason                                      |

OpenCode has no settled state, and a stopped session can take another turn when you open it, so the plugin reports it as ready for review, never done. A later turn sets `time.busy` again, so the handoff shows Working, then the new outcome.

The native state keeps the last state, the label, `time.idle`, the outcome, the start time until OpenCode has the session, and the error's type and message. Messages and paths are never stored, and a handoff has no web link.

### Settings

| Setting | Default | What it does                                                                                                                       |
| ------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Model   | Empty   | A provider and model as `provider/model`, such as `anthropic/claude-sonnet-4-5`. Empty uses your OpenCode default.                 |
| Agent   | Empty   | An OpenCode agent, such as `build` or `plan`. Empty uses your OpenCode default. Its permission rules decide what OpenCode would ask. |

The terminal follows the same rules as Claude Code's: Windows Terminal takes only letters, digits, spaces and `. _ : \ / @ + = , ~ ( ) -` in the folder path.

## Codex

Every handoff is a Codex thread that `codex app-server` starts and runs. The app-server is Codex's JSON-RPC server on stdio, and it owns a turn: the turn stops if the app-server ends before the turn is done. So the plugin doesn't run it as a command that returns. It runs it as an Ajour process session, which Ajour keeps running between plugin operations. The prompt and the title go to the app-server's stdin as JSON (`turn/start` and `thread/name/set`), never on a command line.

**A running turn ends when Ajour quits.** Ajour also ends the session, and the turn with it, when the plugin is turned off, updated or suspended, or after 30 minutes without a refresh. Codex then records the turn as interrupted, and the handoff shows Failed, labeled Stopped. Open the thread in Codex to go on.

**At most two Codex handoffs run at once**, because Ajour keeps at most two sessions for a plugin (see [Sessions](#sessions)).

**Removing a handoff leaves its turn running.** Ajour doesn't tell a plugin when a handoff is removed, and nothing refreshes it after, so its session keeps the turn running, and holds one of the two places, until the 30-minute idle timeout ends both. les-cabochons/ajour#755 asks Ajour to tell the plugin. Close in Codex interrupts the turn, archives the thread and ends its session instead (see [Closing threads](#closing-threads)).

### Commands it runs

| Command                                           | What for                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `codex -C <folder> app-server` as a session       | Runs the thread's turn, reads threads, lists them for linking, and interrupts and archives one on [close](#closing-threads). Ajour starts it in `<folder>`, the repository folder, which becomes the thread's working folder; the app-server itself ignores `-C`. It ends after 30 minutes without a send or read. |
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

## VS Code

The plugin runs `code chat` detached in the repository folder, in agent mode. VS Code opens the folder, or brings its window forward, and sends the chat at once.

`code chat` takes its prompt only from its arguments, where Ajour refuses line breaks. With `-`, it saves stdin to a file in the system's temporary folder and attaches that file to the chat. So the command line carries one line, "Follow the handoff in the attached file: <title>", and the whole prompt goes on stdin, where it keeps its line breaks and stays out of the process list. The agent reads the item from the attached file. A prompt over Ajour's 1,048,576 characters of stdin is refused before `code` runs.

Checked in VS Code 1.146.0's own code, not in a recorded start, since a start opens VS Code and runs an agent: `code chat` joins the words after `chat` into the prompt and sends it, opens the folder it runs in when neither `-r` nor `-n` is given, and attaches stdin with `--add-file`. VS Code first asks you to trust the folder if you haven't. If you decline, VS Code drops the chat, and the handoff still says Started.

### Commands it runs

| Command                                                                     | What for                                                                           |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `code chat -m agent <line> -` in the repository folder, the prompt on stdin | Starts the chat, detached, in agent mode. Returns once `code` has read the prompt. |
| `code --version`                                                            | Detects VS Code. Times out after 10 seconds.                                       |

The `code` command must be on PATH. On macOS, run Shell Command: Install 'code' command in PATH from VS Code's Command Palette once.

On Windows, `code` is a `.cmd` launcher, and Ajour runs only the launchers it recognises: npm, pnpm, Yarn and T3 Code. Ajour will likely refuse VS Code's, so detection says Ajour couldn't start code safely. This isn't tested on Windows.

### States

VS Code has no command that reports a chat's state or lists its chats, so the tool sets `followsState: false` and `listsThreads: false`. Ajour shows each VS Code handoff as Started and never asks about it again. VS Code names no chat, so the plugin chooses the thread id, a new UUID. A handoff has no link and no resume, so Open says there is nothing to open: the chat is already open in VS Code.

The Agents window (`code --agents`) takes a prompt only from a `vscode://agents/new?prompt=` link. That link fills in the prompt without sending it, and needs the folder's path, which Ajour never gives a plugin. So the tool uses the chat.

### Settings

None. `code chat` has no model option, so the chat uses the model selected in VS Code, and a handoff always runs in agent mode.

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

The tests run the plugin against outputs recorded from the real CLIs: `t3` in `tests/fixtures` (version in `version.txt`), `claude` 2.1.325 on Windows in `tests/fixtures/claude`, `copilot` 1.0.112 on Windows, signed out with its own `COPILOT_HOME`, in `tests/fixtures/copilot` (the `stdin-` files from a start whose prompt was piped to a local model through Copilot CLI's BYOK variables), the `opencode` 2.3.2 CLI on macOS, with its own XDG folders, in `tests/fixtures/opencode` (see its README), and JSON-RPC exchanges with `codex app-server` 0.169.0 on Windows in `tests/fixtures/codex` (see its README), each from a throwaway repository with home paths replaced. The listing fixtures (`list-threads*.json`, `claude/agents-folder*.json`, `codex/list.jsonl`) were recorded on this machine's own tools with read-only list commands, then had their titles, prompts and paths replaced, since the real ones are private. `tests/codex-replay.mjs` replays a Codex exchange through the SDK fake's process sessions. `tests/fake-broker.mjs` expands each request into argv from `plugin.json` the way the broker does, with its refusals and the Windows Terminal character check; a `hook-url` argument gets the SDK fake's `hookUrl`, written into its template. `tests/sdk-manifest.test.mjs` checks `plugin.json` against the SDK's `PluginManifest` type.
