// Hands backlog items off to coding agents and reads back the state of their
// work: T3 Code threads through the `t3` CLI, Claude Code background
// sessions through `claude`, Copilot CLI sessions through `copilot`,
// OpenCode sessions through the `opencode serve` HTTP server, Codex threads
// through `codex app-server`, which Ajour keeps running as a process session
// while a turn runs, and VS Code chats through `code chat`. Every command runs through Ajour's process
// broker, as declared in plugin.json's `processes` block, and every request to
// OpenCode through its credential broker, to the address of the connection
// the user picked.
import type {
  DetectToolsResult,
  HandoffArguments,
  ListThreadsRequest,
  ListThreadsResult,
  PluginConnection,
  PluginModule,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
  StartHandoffRequest,
  StartHandoffResult,
  ValidationResult,
} from "@ajour/plugin-sdk";
import {
  CLAUDE_TOOL,
  detectClaude,
  listClaude,
  readClaude,
  startClaude,
} from "./claude.ts";
import {
  CODEX_TOOL,
  detectCodex,
  listCodex,
  readCodex,
  startCodex,
} from "./codex.ts";
import {
  COPILOT_TOOL,
  NO_STATE,
  detectCopilot,
  startCopilot,
} from "./copilot.ts";
import {
  OPENCODE_TOOL,
  detectOpenCode,
  listOpenCode,
  readOpenCode,
  startOpenCode,
  validateOpenCode,
} from "./opencode.ts";
import { T3_TOOL, detectT3, listT3, readT3, startT3 } from "./t3.ts";
import {
  NO_LIST as VSCODE_NO_LIST,
  NO_STATE as VSCODE_NO_STATE,
  VSCODE_TOOL,
  detectVsCode,
  startVsCode,
} from "./vscode.ts";

function unknownTool(id: string): never {
  throw new Error(`This plugin has no handoff tool "${id}".`);
}

/**
 * The connection and the request. Ajour passes the connection first for a
 * tool that uses one (OpenCode), and only the request for the others.
 */
function split<Request>(
  args: HandoffArguments<Request>,
): [PluginConnection | undefined, Request] {
  return args.length === 2 ? [args[0], args[1]] : [undefined, args[0]];
}

/**
 * Ajour detects the tools without a connection together, and OpenCode once
 * for each connection its settings picked.
 */
export async function detectTools(
  connection?: PluginConnection,
): Promise<DetectToolsResult> {
  if (connection) return { tools: [await detectOpenCode(connection)] };
  const tools = await Promise.all([
    detectT3(),
    detectClaude(),
    detectCopilot(),
    detectCodex(),
    detectVsCode(),
  ]);
  return { tools };
}

/** A connection is OpenCode's server: Ajour checks it answers before saving. */
export async function validateConnection(
  connection: PluginConnection,
): Promise<ValidationResult> {
  return validateOpenCode(connection);
}

export async function startHandoff(
  ...args: HandoffArguments<StartHandoffRequest>
): Promise<StartHandoffResult> {
  const [connection, request] = split(args);
  if (request.tool === OPENCODE_TOOL) return startOpenCode(connection, request);
  if (request.tool === T3_TOOL) return startT3(request);
  if (request.tool === CLAUDE_TOOL) return startClaude(request);
  if (request.tool === COPILOT_TOOL) return startCopilot(request);
  if (request.tool === CODEX_TOOL) return startCodex(request);
  if (request.tool === VSCODE_TOOL) return startVsCode(request);
  return unknownTool(request.tool);
}

/**
 * The state of the tools that follow it. Ajour asks only the tools
 * plugin.json doesn't mark `followsState: false`, so never Copilot CLI or
 * VS Code.
 */
export async function readHandoffStates(
  ...args: HandoffArguments<ReadHandoffStatesRequest>
): Promise<ReadHandoffStatesResult> {
  const [connection, request] = split(args);
  if (request.tool === OPENCODE_TOOL) return readOpenCode(connection, request);
  if (request.tool === T3_TOOL) return readT3(request);
  if (request.tool === CLAUDE_TOOL) return readClaude(request);
  if (request.tool === CODEX_TOOL) return readCodex(request);
  if (request.tool === COPILOT_TOOL)
    throw new Error(`${NO_STATE} Open the session to follow it.`);
  if (request.tool === VSCODE_TOOL)
    throw new Error(`${VSCODE_NO_STATE} Open VS Code to follow it.`);
  return unknownTool(request.tool);
}

/**
 * A tool's recent threads in one folder, for Ajour to offer the ones whose
 * title names an item's key. Ajour asks only the tools plugin.json marks
 * `listsThreads`.
 */
export async function listThreads(
  ...args: HandoffArguments<ListThreadsRequest>
): Promise<ListThreadsResult> {
  const [connection, request] = split(args);
  if (request.tool === OPENCODE_TOOL) return listOpenCode(connection, request);
  if (request.tool === T3_TOOL) return listT3(request);
  if (request.tool === CLAUDE_TOOL) return listClaude(request);
  if (request.tool === CODEX_TOOL) return listCodex(request);
  if (request.tool === COPILOT_TOOL)
    throw new Error(
      "Copilot CLI lists its sessions only in its interactive picker, so Ajour can't list them.",
    );
  if (request.tool === VSCODE_TOOL) throw new Error(VSCODE_NO_LIST);
  return unknownTool(request.tool);
}

// Keep the exported operations checked against the host's contract.
const _module = {
  detectTools,
  validateConnection,
  startHandoff,
  readHandoffStates,
  listThreads,
} satisfies PluginModule;
