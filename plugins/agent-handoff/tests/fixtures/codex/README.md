# Recorded Codex exchanges

JSON-RPC exchanges with `codex app-server` from codex-cli 0.169.0 on Windows 11,
recorded on 2026-11-16 in a throwaway git repository. Each line is one message:
`{"send": …}` is what the client wrote to the app-server's stdin, and
`{"receive": …}` is a line it wrote to stdout, in order. Home paths read
`C:\Users\user`, the repository `C:\work\repo`. Startup notifications about
the user's configuration, account, remote control and MCP servers are left out.

Turns with the invalid model `ajour-invalid-model-probe` spent no tokens. Three
turns ran a real model, each with a one-line prompt; every thread was archived
afterwards.

| File                       | What it holds                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `start-ok.jsonl`           | The plugin's start of a real turn, its refresh right after (thread still idle, no turn recorded), and one after the turn completed.         |
| `read-ok.jsonl`            | A second app-server reading that completed thread: `notLoaded`, last turn `completed`.                                                      |
| `start-bad.jsonl`          | A start with the invalid model, its refresh, then the turn failing: thread `systemError`, turn `failed` with Codex's message.               |
| `read-bad.jsonl`           | A second app-server reading that failed thread.                                                                                             |
| `start-cut.jsonl`          | A start whose session the harness ended 600 ms later, mid-turn.                                                                             |
| `read-cut.jsonl`           | A second app-server reading that thread: last turn `interrupted`, `completedAt` null.                                                       |
| `approval.jsonl`           | A probe client's real turn under `approvalPolicy: "untrusted"`: `waitingOnApproval`, the `item/fileChange/requestApproval` request, a read. |
| `read-gone-archived.jsonl` | One reader batch: a thread `thread/delete` removed (`thread not loaded`), an archived one, and one cut short.                               |
| `read-unrecorded.jsonl`    | A probe client reading a thread whose session ended before Codex recorded its turn: no turns.                                               |

`start-*` and `read-*` were recorded by running the plugin's own code against
the real app-server, through a stand-in for Ajour's process sessions.
`approval` and `read-unrecorded` come from a probe client with numeric ids.
