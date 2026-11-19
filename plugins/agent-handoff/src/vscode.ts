// Hands backlog items off to VS Code's chat, in agent mode, with `code chat`
// started detached in the repository folder. VS Code 1.146 sends the words
// after `chat` as the prompt, opens the folder code runs in, and saves stdin
// to a temporary file it attaches to the chat. Ajour refuses line breaks in an
// argument, so the command line carries one line that points at the
// attachment, and the whole prompt goes on stdin.
//
// VS Code has no command that reports or lists its chats, so plugin.json sets
// `followsState: false` and `listsThreads: false`: Ajour shows these handoffs
// as Started and never asks the plugin about them again.
import type {
  DetectToolsResult,
  StartHandoffRequest,
  StartHandoffResult,
} from "@ajour/plugin-sdk";
import {
  START_DEADLINE_MS,
  ToolError,
  before,
  capture,
  firstLine,
  launch,
  oneLineTitle,
  reasonOf,
  refusalsFor,
  type Tool,
} from "./shared.ts";

export const VSCODE_TOOL = "vscode";
// The most stdin Ajour writes to a command, in characters.
export const PROMPT_LIMIT = 1024 * 1024;
export const NO_STATE = "VS Code doesn't report a chat's state.";
export const NO_LIST =
  "VS Code's code command doesn't list its chats, so Ajour can't list them.";

const vscode: Tool = {
  name: "VS Code",
  exe: "code",
  refusals: refusalsFor("VS Code", "code", {
    invalid_request:
      "Ajour refused a value for code. Check this handoff's title and the repository folder path.",
    output_limit: "VS Code printed more than Ajour accepts.",
    stdin_failed:
      "VS Code didn't read the prompt: code stopped first, or took more than 10 seconds to start. Run code in the repository folder to check that it opens, then hand off again.",
  }),
  late: "VS Code took too long. Try again.",
  failureLine: firstLine,
  explain(message) {
    return message;
  },
};

/**
 * The one line `code chat` sends. It starts with a word, so it never starts
 * with the `-` Ajour refuses, and the title tells the chats apart.
 */
export function chatLine(title: string): string {
  return `Follow the handoff in the attached file: ${oneLineTitle(title)}`;
}

export async function detectVsCode(): Promise<
  DetectToolsResult["tools"][number]
> {
  try {
    // `1.146.0`, then the commit and the architecture, each on its own line.
    const version = firstLine(await capture(vscode, "vscode-version", {}));
    if (!version || version.length > 200)
      throw new ToolError("code returned no version.");
    return { id: VSCODE_TOOL, available: true, version };
  } catch (error) {
    return {
      id: VSCODE_TOOL,
      available: false,
      reason: reasonOf(vscode, error),
    };
  }
}

export async function startVsCode(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const deadline = Date.now() + START_DEADLINE_MS;
  const { prompt } = request;
  if (!prompt.trim())
    throw new ToolError("The prompt is empty. Check the handoff template.");
  if (prompt.length > PROMPT_LIMIT)
    throw new ToolError(
      `The prompt has ${prompt.length.toLocaleString("en-US")} characters, and Ajour gives VS Code at most ${PROMPT_LIMIT.toLocaleString("en-US")}. Shorten the prompt.`,
    );
  try {
    // code reads stdin to its end before it opens VS Code, and Ajour returns
    // once it has, so the start never waits for the chat itself.
    await before(vscode, deadline, () =>
      launch(
        vscode,
        "vscode-chat",
        { folder: request.folder.id, request: chatLine(request.title) },
        prompt,
      ),
    );
  } catch (error) {
    throw new ToolError(
      reasonOf(vscode, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  return {
    // VS Code names no chat, so the plugin chooses an id for the record.
    threadId: crypto.randomUUID(),
    // No state, link or resume: VS Code is already open on the chat.
    native: { label: "Started" },
  };
}
