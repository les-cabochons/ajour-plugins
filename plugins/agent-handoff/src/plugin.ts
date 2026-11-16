// Hands backlog items off to coding agents and reads back the state of their
// work: T3 Code threads through the `t3` CLI, and Claude Code background
// sessions through `claude`. Every command runs through Ajour's process
// broker, as declared in plugin.json's `processes` block.
import type {
  DetectToolsResult,
  PluginModule,
  ReadHandoffStatesRequest,
  ReadHandoffStatesResult,
  StartHandoffRequest,
  StartHandoffResult,
} from "@ajour/plugin-sdk";
import {
  CLAUDE_TOOL,
  detectClaude,
  readClaude,
  startClaude,
} from "./claude.ts";
import { T3_TOOL, detectT3, readT3, startT3 } from "./t3.ts";

function unknownTool(id: string): never {
  throw new Error(`This plugin has no handoff tool "${id}".`);
}

export async function detectTools(): Promise<DetectToolsResult> {
  const tools = await Promise.all([detectT3(), detectClaude()]);
  return { tools };
}

export async function startHandoff(
  request: StartHandoffRequest,
): Promise<StartHandoffResult> {
  if (request.tool === T3_TOOL) return startT3(request);
  if (request.tool === CLAUDE_TOOL) return startClaude(request);
  return unknownTool(request.tool);
}

export async function readHandoffStates(
  request: ReadHandoffStatesRequest,
): Promise<ReadHandoffStatesResult> {
  if (request.tool === T3_TOOL) return readT3(request);
  if (request.tool === CLAUDE_TOOL) return readClaude(request);
  return unknownTool(request.tool);
}

// Keep the exported operations checked against the host's contract.
const _module = {
  detectTools,
  startHandoff,
  readHandoffStates,
} satisfies PluginModule;
