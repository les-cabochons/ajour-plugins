// Hands backlog items off to coding agents and reads back the state of their
// work: T3 Code threads through the `t3` CLI, Claude Code background
// sessions through `claude`, opened in a terminal or in the Claude desktop
// app, Copilot CLI sessions through `copilot`, OpenCode 2 sessions through
// `opencode`, Codex threads through `codex app-server`, which Ajour keeps
// running as a process session while a turn runs, and VS Code chats through
// `code chat`. Every command runs through Ajour's process broker, as declared
// in plugin.json's `processes` block. No tool uses a connection.
import type {
  DetectToolsResult,
  HandoffArguments,
  ListThreadsRequest,
  ListThreadsResult,
  PluginModule,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
  StartHandoffRequest,
  StartHandoffResult,
} from "@ajour/plugin-sdk";
import {
  CLAUDE_DESKTOP_TOOL,
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
} from "./opencode.ts";
import { T3_TOOL, detectT3, listT3, readT3, startT3 } from "./t3.ts";
import {
  NO_LIST as VSCODE_NO_LIST,
  NO_STATE as VSCODE_NO_STATE,
  VSCODE_TOOL,
  detectVsCode,
  startVsCode,
} from "./vscode.ts";

/** Claude Code and Claude Code desktop run the same sessions. */
function isClaude(tool: string): boolean {
  return tool === CLAUDE_TOOL || tool === CLAUDE_DESKTOP_TOOL;
}

function unknownTool(id: string): never {
  throw new Error(`This plugin has no handoff tool "${id}".`);
}

/**
 * The request. Ajour passes a connection before it only for a tool that uses
 * one, and none of this plugin's tools does.
 */
function requestOf<Request>(args: HandoffArguments<Request>): Request {
  return args.length === 2 ? args[1] : args[0];
}

/** Ajour detects the tools together, in plugin.json's order. */
export async function detectTools(): Promise<DetectToolsResult> {
  const [t3, claude, copilot, opencode, codex, vscode] = await Promise.all([
    detectT3(),
    detectClaude(),
    detectCopilot(),
    detectOpenCode(),
    detectCodex(),
    detectVsCode(),
  ]);
  return { tools: [t3, ...claude, copilot, opencode, codex, vscode] };
}

export async function startHandoff(
  ...args: HandoffArguments<StartHandoffRequest>
): Promise<StartHandoffResult> {
  const request = requestOf(args);
  if (request.tool === OPENCODE_TOOL) return startOpenCode(request);
  if (request.tool === T3_TOOL) return startT3(request);
  if (isClaude(request.tool)) return startClaude(request);
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
  const request = requestOf(args);
  if (request.tool === OPENCODE_TOOL) return readOpenCode(request);
  if (request.tool === T3_TOOL) return readT3(request);
  if (isClaude(request.tool)) return readClaude(request);
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
  const request = requestOf(args);
  if (request.tool === OPENCODE_TOOL) return listOpenCode(request);
  if (request.tool === T3_TOOL) return listT3(request);
  if (isClaude(request.tool)) return listClaude(request);
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
  startHandoff,
  readHandoffStates,
  listThreads,
} satisfies PluginModule;
