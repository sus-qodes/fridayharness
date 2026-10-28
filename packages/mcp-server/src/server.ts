import type { ContextPacket, TaskView } from '@friday/protocol';
import { isFridayError } from '@friday/protocol';
import { FRIDAY_VERSION, renderContextMarkdown } from '@friday/sdk';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { SERVER_INSTRUCTIONS } from './instructions.js';
import type { FridaySession } from './session.js';
import { createFridayTools } from './tools.js';

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

/** The `friday` MCP server: 14 tools, resources and prompts (plan M1.9). */
export function createFridayMcpServer(session: FridaySession): McpServer {
  const server = new McpServer(
    { name: 'friday', version: FRIDAY_VERSION },
    {
      instructions: SERVER_INSTRUCTIONS,
      capabilities: { tools: { listChanged: true }, resources: { listChanged: true }, prompts: {}, logging: {} },
    },
  );

  for (const tool of createFridayTools(session)) {
    server.registerTool(
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
  }

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
