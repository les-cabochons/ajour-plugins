// Hands backlog items off to coding agents and reads back the state of their
// work: T3 Code threads through the `t3` CLI, Claude Code background
// sessions through `claude`, Copilot CLI sessions through `copilot`, and
// OpenCode sessions through the `opencode serve` HTTP server. Every command
// runs through Ajour's process broker, as declared in plugin.json's
// `processes` block, and every request to OpenCode through its credential
// broker, to the address of the connection the user picked.
import type {
  DetectToolsResult,
  HandoffArguments,
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
  readClaude,
  startClaude,
} from "./claude.ts";
import {
  COPILOT_TOOL,
  detectCopilot,
  readCopilot,
  startCopilot,
} from "./copilot.ts";
import {
  OPENCODE_TOOL,
  detectOpenCode,
  readOpenCode,
  startOpenCode,
  validateOpenCode,
} from "./opencode.ts";
import { T3_TOOL, detectT3, readT3, startT3 } from "./t3.ts";

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
  return unknownTool(request.tool);
}

export async function readHandoffStates(
  ...args: HandoffArguments<ReadHandoffStatesRequest>
): Promise<ReadHandoffStatesResult> {
  const [connection, request] = split(args);
  if (request.tool === OPENCODE_TOOL) return readOpenCode(connection, request);
  if (request.tool === T3_TOOL) return readT3(request);
  if (request.tool === CLAUDE_TOOL) return readClaude(request);
  if (request.tool === COPILOT_TOOL) return readCopilot(request);
  return unknownTool(request.tool);
}

// Keep the exported operations checked against the host's contract.
const _module = {
  detectTools,
  validateConnection,
  startHandoff,
  readHandoffStates,
} satisfies PluginModule;
