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
  'friday_remember',
  // The owner's decision of 2026-10-22 for the testing phase: whether these two cost more than
  // they save is measured there (ADR-0038 §1, ADR-0039 §5).
  'friday_blast_radius',
  'friday_symbolic_patch',
] as const;
export type SpawnedAgentTool = (typeof SPAWNED_AGENT_TOOLS)[number];

/**
 * What a spawned session is told about each tool (plan M13.5): one line, and only the fields an
 * agent needs. Every call of the session carries these definitions, so each word costs as many
 * times as the session calls its model; the daemon checks every argument again behind the tool.
 */
const SPAWNED_FORM: Record<
  SpawnedAgentTool,
  {
    description: string;
    shape: z.ZodRawShape;
    rule: string;
    /** Fixed arguments the spawned form adds to every call. */
    fixed?: Record<string, unknown>;
  }
> = {
  friday_request_context: {
    description:
      'More context: "scope_files" (your files and related code), "file" (query: path) and "history" come alone; "task", "decision" and "learnings" (more checked project learnings) come with the task.',
    shape: {
      kind: z.enum(['task', 'scope_files', 'file', 'history', 'decision', 'learnings']).optional(),
      query: z.string().optional(),
    },
    rule: 'friday_request_context gives more context',
  },
  friday_communicate: {
    description:
      'Message another agent or a human through Friday. to: an agent key, "role:<role>", "task:<task_id>", "dependencies", "dependents", "master" or "human". Answer a message with mode "response" and response_to. Checkable statements go in facts.',
    shape: {
      to: z.string(),
      mode: z.enum(['request', 'response', 'notification']),
      content: z.string(),
      response_to: z.string().optional(),
      blocking: z.boolean().optional(),
      facts: z.array(z.object({ fact: z.string() })).optional(),
    },
    rule: 'friday_communicate reaches the agents whose work relates to yours, and answers them',
  },
  friday_request_permission: {
    description:
      'Ask for what Friday refused. action_class: "file.write" with resource (the path), a shell capability such as "shell.git.push" with command, or "network.read" with resource (the URL). reuse "run" or "task" when you will need it again.',
    shape: {
      action_class: z.string(),
      resource: z.string().optional(),
      command: z.string().optional(),
      justification: z.string(),
      reuse: z.enum(['once', 'run', 'task']).optional(),
    },
    rule: "friday_request_permission asks for what Friday's policy blocks",
  },
  friday_run_operation: {
    description:
      'Have Friday run an operation the project declares, with a secret you never see. No arguments: list them; name and reason: run one; operation_run_id: wait for it.',
    shape: {
      name: z.string().optional(),
      reason: z.string().optional(),
      operation_run_id: z.string().optional(),
      reuse: z.enum(['once', 'run', 'task']).optional(),
    },
    rule: 'friday_run_operation has Friday run work that needs a secret',
  },
  friday_remember: {
    description:
      'Propose a lesson for the whole project (a bug pattern, convention, runbook, risk). It reaches other agents only after your task passes verification or a human approves it. paths: what it is about.',
    shape: {
      kind: z.enum([
        'decision',
        'architecture',
        'constraint',
        'convention',
        'bug-pattern',
        'dependency',
        'operational-runbook',
        'human-preference',
        'learned-risk',
      ]),
      subject: z.string(),
      content: z.string(),
      paths: z.array(z.string()).optional(),
    },
    rule: 'friday_remember proposes what the project should learn from your work',
    fixed: { share: 'project' },
  },
  friday_blast_radius: {
    description:
      'Before changing a shared symbol or file: what depends on it, with a confidence (high, medium, low). Seed it with paths, symbols as "file#name", or diff: true for the files you changed. It lists; it judges nothing.',
    shape: {
      paths: z.array(z.string()).optional(),
      symbols: z.array(z.string()).optional(),
      diff: z.boolean().optional(),
      depth: z.number().int().min(1).max(5).optional(),
    },
    rule: 'friday_blast_radius says what a change would reach',
  },
  friday_symbolic_patch: {
    description:
      'Replace one declaration by name (Parent.member for a member) without rewriting the file; body: the whole new declaration. Refused with the reason unless exactly one matches and the file still parses; dry_run: true previews. When refused, edit the file.',
    shape: {
      path: z.string(),
      symbol: z.string(),
      body: z.string(),
      kind: z.string().optional(),
      line: z.number().int().optional(),
      dry_run: z.boolean().optional(),
    },
    rule: 'friday_symbolic_patch replaces one declaration by name',
  },
};

/**
 * Those tools for one run attempt, in their spawned form. `operations: false` leaves out
 * `friday_run_operation`, for a project that declares none (`spawnedAgentToolsFor`).
 */
export function spawnedAgentTools(
  attempt: {
    /** The adapter's current registration (a reconnect replaces it). */
    client: () => GenericHarnessClient;
    agentKey: string;
    taskId: string;
    runId: string;
  },
  opts: { operations?: boolean } = {},
): FridayTool[] {
  const me = {
    agent: { agent_key: attempt.agentKey },
    current_task: { task_id: attempt.taskId },
    current_run: { run_id: attempt.runId },
  } as unknown as MeView;
  // The tools ask their session for a client and for what it holds; nothing else of it is used.
  const session = { ready: async () => attempt.client(), me: async () => me } as unknown as FridaySession;
  const names: readonly string[] = SPAWNED_AGENT_TOOLS.filter(
    (n) => n !== 'friday_run_operation' || opts.operations !== false,
  );
  // In the declared order, so every adapter lists them the same way whatever order they are defined in.
  return createFridayTools(session, { relaysMessages: true })
    .filter((t) => names.includes(t.name))
    .sort((a, b) => names.indexOf(a.name) - names.indexOf(b.name))
    .map((t) => {
      const form = SPAWNED_FORM[t.name as SpawnedAgentTool];
      const fixed = form.fixed;
      return {
        ...t,
        description: form.description,
        shape: form.shape,
        ...(fixed ? { handler: (a: Record<string, unknown>) => t.handler({ ...a, ...fixed }) } : {}),
      };
    });
}

/**
 * The tools of an attempt, with `friday_run_operation` only when the project declares an operation
 * the agent may run (plan M13.5). The list is Friday's own answer, no model call; when it cannot be
 * read, the tool is given, since an agent without it could not run what the project declares.
 */
export async function spawnedAgentToolsFor(attempt: Parameters<typeof spawnedAgentTools>[0]): Promise<FridayTool[]> {
  let operations = true;
  try {
    operations = (await attempt.client().call('operation.list', {})).operations.length > 0;
  } catch {
    // unknown: keep the tool
  }
  return spawnedAgentTools(attempt, { operations });
}

/** The line of a spawned session's rules that names the Friday tools it has, and only those. */
export function spawnedToolsRule(tools: readonly { name: string }[]): string {
  const rules = tools.map((t) => SPAWNED_FORM[t.name as SpawnedAgentTool]?.rule).filter((r): r is string => Boolean(r));
  return rules.length ? `- Friday's tools are yours to use: ${rules.join('; ')}.` : '';
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
