/**
 * The Friday tools a session Friday starts itself gets (review M8-R06, ADR-0032 §8): it reaches
 * other agents and answers them, asks Friday for context, asks for what Friday's policy blocks, and
 * has a declared operation run, as an attached session does. Its task, its inbox and how it ends
 * are its adapter's: messages for it reach its session as they arrive, and its final answer is its
 * claim. The tools act through the adapter's own registration, for the attempt's task and run only.
 */
import type { GenericHarnessClient } from '@friday/adapter-generic';
import { isFridayError } from '@friday/protocol';
import { FRIDAY_VERSION } from '@friday/sdk';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { FridaySession, MeView } from './session.js';
import { createFridayTools, type FridayTool } from './tools.js';

export const SPAWNED_AGENT_TOOLS = [
  'friday_request_context',
  'friday_communicate',
  'friday_request_permission',
  'friday_run_operation',
] as const;

/** Those tools for one run attempt. */
export function spawnedAgentTools(attempt: {
  /** The adapter's current registration (a reconnect replaces it). */
  client: () => GenericHarnessClient;
  agentKey: string;
  taskId: string;
  runId: string;
}): FridayTool[] {
  const me = {
    agent: { agent_key: attempt.agentKey },
    current_task: { task_id: attempt.taskId },
    current_run: { run_id: attempt.runId },
  } as unknown as MeView;
  // The tools ask their session for a client and for what it holds; nothing else of it is used.
  const session = { ready: async () => attempt.client(), me: async () => me } as unknown as FridaySession;
  const names: readonly string[] = SPAWNED_AGENT_TOOLS;
  return createFridayTools(session, { relaysMessages: true }).filter((t) => names.includes(t.name));
}

/** A tool's input as JSON Schema, for hosts that take tools that way (Codex's dynamic tools). */
export function toolInputSchema(tool: FridayTool): Record<string, unknown> {
  const { $schema: _, ...schema } = z.toJSONSchema(z.object(tool.shape)) as Record<string, unknown>;
  return schema;
}

/** Runs a tool for a host that is not an MCP client: its arguments are checked against its schema first. */
export async function callTool(tool: FridayTool, args: unknown): Promise<{ ok: boolean; text: string }> {
  const parsed = z.object(tool.shape).safeParse(args ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      text: `COS-1001: the arguments of ${tool.name} do not fit its schema: ${parsed.error.message}`,
    };
  }
  try {
    return { ok: true, text: (await tool.handler(parsed.data)).text };
  } catch (e) {
    return { ok: false, text: `${isFridayError(e) ? e.code : 'COS-9000'}: ${(e as Error).message}` };
  }
}

/** An MCP server with exactly these tools, nothing else (a spawned Claude Code session's). */
export function createToolServer(tools: FridayTool[]): McpServer {
  const server = new McpServer({ name: 'friday', version: FRIDAY_VERSION }, { capabilities: { tools: {} } });
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const r = await callTool(tool, args);
        return { content: [{ type: 'text' as const, text: r.text }], ...(r.ok ? {} : { isError: true }) };
      },
    );
  }
  return server;
}
