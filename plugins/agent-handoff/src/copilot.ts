// Hands backlog items off to GitHub Copilot CLI as sessions with an id the
// plugin chooses (`copilot --session-id <uuid> -p <prompt>`), started detached
// in the repository folder. Copilot CLI has no command that reports a
// session's state, so a refresh reports unknown.
import type {
  DetectToolsResult,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
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
  previousState,
  reasonOf,
  refusalsFor,
  settingText,
  text,
  withNotes,
  type Handoff,
  type Native,
  type Tool,
  type Update,
} from "./shared.ts";

export const COPILOT_TOOL = "copilot";
// Ajour passes a detached command's arguments to Windows in one command line
// of at most 32,767 characters, each counted twice for quoting. The prompt
// leaves room for the executable, the folder, the title and the model.
export const PROMPT_LIMIT = 12_000;
export const NO_STATE = "Copilot CLI doesn't report a session's state.";

const copilot: Tool = {
  name: "Copilot CLI",
  exe: "copilot",
  refusals: refusalsFor("Copilot CLI", "copilot", {
    invalid_request:
      "Ajour refused a value for copilot. Check the model; a terminal also needs a repository folder path without unusual characters.",
    output_limit: "Copilot CLI printed more than Ajour accepts.",
  }),
  late: "Copilot CLI took too long. Try again.",
  failureLine(value) {
    return firstLine(value).replace(/^error:\s*/i, "");
  },
  explain(message) {
    return message;
  },
};

export async function detectCopilot(): Promise<
  DetectToolsResult["tools"][number]
> {
  try {
    // `GitHub Copilot CLI 1.0.112.`, then a line about `copilot update`.
    const output = firstLine(await capture(copilot, "copilot-version", {}));
    const version =
      /^GitHub Copilot CLI v?(\S+?)\.?$/i.exec(output)?.[1] ?? output;
    if (!version || version.length > 200)
      throw new ToolError("copilot returned no version.");
    return { id: COPILOT_TOOL, available: true, version };
  } catch (error) {
    return {
      id: COPILOT_TOOL,
      available: false,
      reason: reasonOf(copilot, error),
    };
  }
}

/**
 * The prompt as one command-line value. Ajour refuses line breaks in a value,
 * and one that starts with "-", which copilot would read as a flag.
 */
export function onePrompt(prompt: string): string {
  return prompt
    .replace(/\0/g, "")
    .replace(/[ \t]*(?:\r\n|\r|\n)+[ \t]*/g, " ")
    .trim()
    .replace(/^[\s-]+/, "");
}

export async function startCopilot(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  const deadline = Date.now() + START_DEADLINE_MS;
  const prompt = onePrompt(request.prompt);
  if (!prompt)
    throw new ToolError("The prompt is empty. Check the handoff template.");
  if (prompt.length > PROMPT_LIMIT)
    throw new ToolError(
      `The prompt has ${prompt.length.toLocaleString("en-US")} characters, and Copilot CLI takes at most ${PROMPT_LIMIT.toLocaleString("en-US")} on its command line. Shorten the handoff template, such as by leaving out the item's description.`,
    );
  // The plugin chooses the session id, so it never reads it back. Copilot
  // names a session only when it creates it.
  const session = crypto.randomUUID();
  const args: Record<string, string> = {
    folder: request.folder.id,
    session,
    title: oneLineTitle(request.title),
    prompt,
  };
  const model = settingText(request.settings.model);
  if (model) args.model = model;
  const tools = request.settings.tools === "allow" ? "allow" : "ask";
  const command = tools === "allow" ? "copilot-start-allow" : "copilot-start";
  try {
    // `-p` runs the whole task and exits when it is done, so it starts
    // detached. Only a capture command takes stdin, and Ajour stops a
    // capture command, and the work with it, after its timeout.
    await before(copilot, deadline, () => launch(copilot, command, args));
  } catch (error) {
    throw new ToolError(
      reasonOf(copilot, error),
      error instanceof ToolError ? error.code : undefined,
    );
  }
  return {
    threadId: session,
    // Open resumes the session in a terminal, for a look or another turn.
    resume: {
      command: "copilot-resume",
      args: { session, folder: request.folder.id },
    },
    native: { state: "working", label: "Started", tools },
  };
}

/** The last state kept, with the reason Copilot CLI can't say more. */
function unknownUpdate(handoff: Handoff): Update {
  const previous = handoff.native;
  const kept: Native = { state: previousState(previous) };
  const tools = text(previous.tools, 16);
  if (tools) kept.tools = tools;
  return {
    id: handoff.id,
    state: "unknown",
    native: withNotes(kept, { label: "Unknown", reason: NO_STATE }),
  };
}

export async function readCopilot(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  // Copilot CLI keeps a session's events under COPILOT_HOME, but no command
  // reports them, and an event log alone can't tell a finished turn from one
  // waiting for you. So no refresh runs a command, and none says gone.
  return request.handoffs.map(unknownUpdate);
}
