# OpenCode answers

Recorded on Windows from `opencode serve --hostname 127.0.0.1 --port 41978`,
opencode-ai 1.19.5 installed into a throwaway npm prefix, with its own
`XDG_DATA_HOME`, `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_STATE_HOME`, in
an empty git repository. No provider was signed in to. The repository path is
replaced with `C:\Users\dev\repos\ajour`; nothing else is changed.

| File                       | Request                                                                                                      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `version.txt`              | `opencode --version`                                                                                         |
| `health.json`              | `GET /global/health`                                                                                         |
| `session-created.json`     | `POST /session` with `{"title":"AJ-42 Hand off to OpenCode"}`                                                |
| `status-idle.json`         | `GET /session/status` with no session busy, and right after `prompt_async` answered 204                      |
| `status-busy.json`         | `GET /session/status` while that session worked                                                              |
| `permissions-none.json`    | `GET /permission`                                                                                            |
| `questions-none.json`      | `GET /question`                                                                                              |
| `session.json`             | `GET /session/<id>` after the session answered                                                               |
| `session-not-found.json`   | `GET /session/ses_doesnotexist000000000000`, which answered 404                                              |
| `messages-answered.json`   | `GET /session/<id>/message?limit=1` after OpenCode's free model answered "OK"                                |
| `messages-unanswered.json` | The same for a session whose prompt named `missing-provider/missing-model`: no answer and no error is stored |

`schema/` holds the answers a server gives only while a model works on a
task, written from the server's own `/doc` OpenAPI document (1.19.5):
`SessionStatus` `retry`, `PermissionRequest`, `QuestionRequest`, a subagent's
session with `parentID`, and an assistant message with an `APIError` or a
`MessageAbortedError`.
