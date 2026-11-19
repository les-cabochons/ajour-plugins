# OpenCode answers

Recorded on macOS with the `opencode` 2.3.2 CLI, with its own `XDG_DATA_HOME`,
`XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME`, and `--standalone`
on every command, so each ran its own private server on those folders instead
of the computer's background service. No provider was signed in to; the
successful run used OpenCode's free `opencode/deepseek-v4.1-flash-free`. Each
`opencode run` got its prompt on stdin and a session id made the way the
plugin makes one. The repository path is replaced with
`/Users/dev/repos/ajour`; nothing else is changed.

| File                          | Command                                                                                                                                 |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `version.txt`                 | `opencode --version`                                                                                                                    |
| `session-succeeded.json`      | `opencode api session.get` after `opencode run -s <id> --title "AJ-42 Hand off to OpenCode"`, which the free model answered "OK"         |
| `session-failed.json`         | The same after a run with `--model missing-provider/missing-model`                                                                       |
| `messages-failed.json`        | `opencode api session.message.list --param sessionID=<id> --param limit=2` for that session: the `idle` message with the error, then the prompt |
| `session-interrupted.json`    | `opencode api session.get` after a run stopped with SIGINT six seconds in                                                               |
| `session-created.json`        | `opencode api session.get` for a session made with `opencode api session.create` and an id, never run                                    |
| `session-create-own-id.json`  | `opencode api session.create` without an id, so OpenCode made its own                                                                   |
| `session-not-found.json`      | `opencode api session.get --param sessionID=ses_doesnotexist000000000000`: stdout, which exited 1 with `HTTP 404 Not Found` on stderr     |
| `sessions.json`               | `opencode session list --format json -n 50` in the repository                                                                            |

`sessions.json` comes from its own XDG folders, with two repositories whose
first commits differ: two sessions in the repository, one in its `packages`
subfolder and one in the other repository, each from a run with the missing
model. OpenCode lists the repository's project, so the subfolder's session is
there and the other repository's isn't.

A session with a run going, `time.busy` without a later `time.idle`, isn't
recorded: a `--standalone` read runs its own server, which doesn't see
another process's run. The tests derive it from `session-succeeded.json`.
