import type { ContextPacket, TaskView } from '@friday/protocol';
import { isFridayError } from '@friday/protocol';
import { FRIDAY_VERSION, renderContextMarkdown } from '@friday/sdk';
import { McpServer, type RegisteredTool, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import type { FridaySession } from './session.js';
import { SURFACE_TOOL_CAPABILITY } from './surfaces.js';
import { createFridayTools, type HostUi } from './tools.js';

function errorResult(e: unknown) {
  const code = isFridayError(e) ? e.code : ((e as { code?: string }).code ?? 'COS-9000');
  const message = (e as Error).message ?? String(e);
  return {
    isError: true,
    content: [{ type: 'text' as const, text: `${code}: ${message}` }],
    structuredContent: { ok: false, code, message, retryable: isFridayError(e) ? e.retryable : false },
  };
}

function taskMarkdown(t: TaskView): string {
  return [
    `# ${t.summary}`,
    `${t.task_id} · ${t.status}${t.waiting_reason ? ` (${t.waiting_reason})` : ''} · priority ${t.priority}`,
    t.description ?? '',
    t.acceptance_criteria.length ? `## Acceptance\n${t.acceptance_criteria.map((c) => `- ${c}`).join('\n')}` : '',
    t.scope ? `## Scope\nwrite: ${t.scope.write.join(', ') || '-'}\nread: ${t.scope.read.join(', ') || '-'}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** The `friday` MCP server: 24 tools, resources and prompts (plan M1.9, memory tools M4d, operations M6c, peers and receipts M12.4, the handoff's surfaces ADR-0038). */

interface IntentResource {
  project: {
    version: number;
    objective: string;
    constraints: { text: string }[];
    outcomes: { text: string }[];
    non_goals: { text: string }[];
    definition_of_done: { text: string }[];
  } | null;
  goal: {
    goal_id: string;
    objective: string;
    intent_revision: number;
    constraints: string[];
    outcomes: string[];
    non_goals: string[];
    definition_of_done: string[];
    inferred_constraints: string[];
    inferred_outcomes: string[];
    inferred_non_goals: string[];
    inferred_definition_of_done: string[];
  } | null;
}

/** The project intent and the goal intent as an agent reads them (ADR-0034 §5). */
export function intentMarkdown(r: IntentResource): string {
  const out: string[] = ['# Project intent'];
  if (r.project) {
    out.push(`Version ${r.project.version} (approved by a human): ${r.project.objective}`);
    for (const [label, items] of [
      ['Constraint', r.project.constraints],
      ['Outcome', r.project.outcomes],
      ['Not a goal', r.project.non_goals],
      ['Done when', r.project.definition_of_done],
    ] as const) {
      for (const i of items) out.push(`- ${label}: ${i.text}`);
    }
  } else {
    out.push('No approved project intent yet.');
  }
  out.push('', '# Goal intent');
  if (r.goal) {
    const g = r.goal;
    out.push(`Goal ${g.goal_id} (revision ${g.intent_revision}): ${g.objective}`);
    for (const [label, own, inferred] of [
      ['Constraint', g.constraints, g.inferred_constraints],
      ['Outcome', g.outcomes, g.inferred_outcomes],
      ['Not a goal', g.non_goals, g.inferred_non_goals],
      ['Done when', g.definition_of_done, g.inferred_definition_of_done],
    ] as const) {
      for (const x of own) out.push(`- ${label}: ${x}`);
      for (const x of inferred) out.push(`- ${label} (suggested by the planner): ${x}`);
    }
  } else {
    out.push('You hold no task of a goal.');
  }
  return out.join('\n');
}

export function createFridayMcpServer(session: FridaySession): McpServer {
  const server = new McpServer(
    { name: 'friday', version: FRIDAY_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
    },
  );

  // Approvals in the host (ADR-0030 §5): asked through MCP form elicitation when the host offers it.
  const host: HostUi = {
    ask: async (message) => {
      if (!server.server.getClientCapabilities()?.elicitation?.form) return null;
      const r = await server.server.elicitInput(
        {
          message,
          requestedSchema: {
            type: 'object',
            properties: {
              decision: {
                type: 'string',
                title: 'Decision',
                enum: ['approve', 'reject'],
                description: 'approve covers one use',
              },
            },
            required: ['decision'],
          },
        },
        { timeout: 300_000 },
      );
      // Only a filled-in form is the human's answer. A host may decline a form without showing it
      // (the VS Code panel does, at once), so a decline, like a dismissal, leaves the request
      // pending for the CLI and the status page (LESSONS CC-25, D-42).
      if (r.action !== 'accept') return null;
      const decision = r.content?.decision;
      return decision === 'approve' || decision === 'reject' ? decision : null;
    },
  };
  const registered = new Map<string, RegisteredTool>();
  for (const tool of createFridayTools(session, host)) {
    const handle = server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.shape,
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
        ...(tool.alwaysLoad ? { _meta: { 'anthropic/alwaysLoad': true } } : {}),
      },
      async (args: Record<string, unknown>) => {
        try {
          const res = await tool.handler(args ?? {});
          return { content: [{ type: 'text' as const, text: res.text }], structuredContent: res.structured };
        } catch (e) {
          return errorResult(e);
        }
      },
    );
    registered.set(tool.name, handle);
  }
  // A tool whose capability this daemon lacks is not listed (ADR-0038 §2): decided once the session
  // is registered, from what the daemon says of itself; the host hears the list changed.
  session.onRegistered(() => {
    void session
      .me()
      .then((me) => {
        const caps = me.capabilities;
        if (!caps) return;
        for (const [name, cap] of Object.entries(SURFACE_TOOL_CAPABILITY)) {
          const t = registered.get(name);
          if (!t) continue;
          if (caps[cap] === false) t.disable();
          else t.enable();
        }
      })
      .catch(() => undefined);
  });

  const json = (uri: URL, value: unknown) => ({
    contents: [{ uri: uri.href, mimeType: 'application/json', text: JSON.stringify(value, null, 2) }],
  });
  const md = (uri: URL, text: string) => ({ contents: [{ uri: uri.href, mimeType: 'text/markdown', text }] });

  server.registerResource(
    'session',
    'friday://session/me',
    { title: 'This Friday session', mimeType: 'application/json' },
    async (uri) => json(uri, await session.me()),
  );
  server.registerResource(
    'current-task',
    'friday://task/current',
    { title: 'Your current task', mimeType: 'text/markdown' },
    async (uri) => {
      const me = await session.me();
      return md(uri, me.current_task ? taskMarkdown(me.current_task) : 'You hold no task.');
    },
  );
  server.registerResource(
    'task',
    new ResourceTemplate('friday://task/{task_id}', {
      list: async () => {
        const me = await session.me().catch(() => undefined);
        const tasks = [...(me?.current_task ? [me.current_task] : []), ...(me?.claimable ?? [])];
        return {
          resources: tasks.map((t) => ({
            uri: `friday://task/${t.task_id}`,
            name: t.summary,
            mimeType: 'text/markdown',
          })),
        };
      },
    }),
    { title: 'A task you hold or can claim', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const res = await session.rest<{ task: TaskView }>('GET', `/tasks/${String(vars.task_id)}`);
      return md(uri, taskMarkdown(res.task));
    },
  );
  server.registerResource(
    'context',
    new ResourceTemplate('friday://context/{context_id}', { list: undefined }),
    { title: 'A compiled context packet', mimeType: 'text/markdown' },
    async (uri, vars) => {
      const id = String(vars.context_id).replace(/\/json$/, '');
      const packet = await session.rest<ContextPacket>('GET', `/context/${id}`);
      return String(vars.context_id).endsWith('/json')
        ? json(uri, packet)
        : md(uri, renderContextMarkdown(packet, 20_000));
    },
  );
  server.registerResource(
    'plan',
    'friday://plan/current',
    { title: 'Current plan (M1: your task and the ready ones)', mimeType: 'text/markdown' },
    async (uri) => {
      const me = await session.me();
      const lines = [
        me.current_task ? `Current: ${me.current_task.task_id} ${me.current_task.summary}` : 'No current task.',
        ...me.claimable.map((t) => `Ready: ${t.task_id} ${t.summary}`),
      ];
      return md(uri, lines.join('\n'));
    },
  );
  server.registerResource(
    'intent',
    'friday://intent',
    { title: 'What the project and your goal are for', mimeType: 'text/markdown' },
    async (uri) => md(uri, intentMarkdown(await session.rest<IntentResource>('GET', '/me/intent'))),
  );
  server.registerResource(
    'inbox',
    'friday://inbox',
    { title: 'Your inbox (peek)', mimeType: 'application/json' },
    async (uri) => json(uri, (await session.me()).inbox),
  );

  server.registerPrompt(
    'start_task',
    {
      title: 'Start Friday work',
      description: 'Claim a task and begin',
      argsSchema: { task_id: z.string().optional() },
    },
    ({ task_id }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Call friday_whoami. Then claim ${task_id ? `task ${task_id}` : 'the next ready task'} with friday_task_claim and read the context it returns before touching files. Work only inside the task's write scope. Report progress with friday_report_progress after each meaningful step. When done, run the checks you can and finish with friday_claim_done listing the exact changed paths and each check's real outcome.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt(
    'handoff',
    {
      title: 'Hand off the task',
      description: 'Release your task to another agent',
      argsSchema: { to_agent: z.string(), summary: z.string() },
    },
    ({ to_agent, summary }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Record where you are with friday_report_progress, then friday_task_release with reason "handoff" and the note "${summary}", then tell ${to_agent} with friday_communicate (mode notification). Do not edit files afterwards.`,
          },
        },
      ],
    }),
  );
  server.registerPrompt('status', { title: 'Friday status', description: 'Summarize your Friday state' }, () => ({
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: 'Call friday_whoami and friday_check_inbox, then summarize for the human in at most 8 lines.',
        },
      },
    ],
  }));

  return server;
}
