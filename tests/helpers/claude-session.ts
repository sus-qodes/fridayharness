import path from 'node:path';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView } from '@friday/protocol';
import type { TestWorkspace } from '@friday/test-support';
import type { TestDaemon } from './daemon.js';
import { decisionOf, postHook, toolHook } from './hooks.js';

let next = 0;

/**
 * An attached Claude Code session whose Friday hooks reached the daemon (L1 `enforcing`, ADR-0016),
 * holding a task assigned to its agent. Needs a daemon started with `extensions: [claudeCodeHooks()]`.
 * `pre` posts a PreToolUse hook as Claude Code would and returns Friday's decision.
 */
export async function claudeSession(
  td: TestDaemon,
  ws: TestWorkspace,
  o: { agent?: string; role?: string; write?: string[]; summary?: string } = {},
) {
  next += 1;
  const pid = 8600 + next;
  const sessionId = `sess-claude-${next}`;
  const agent = o.agent ?? `dev-${next}`;
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.296',
    adapter_version: '0.1.0',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: agent,
    role: o.role ?? 'developer',
    host: { pid, session_id: sessionId, cwd: ws.projectDir },
  });
  await client.register();
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  const vars = { projectDir: ws.projectDir, sessionId };
  const started = await postHook(
    daemon,
    'SessionStart',
    { session_id: sessionId, cwd: vars.projectDir, hook_event_name: 'SessionStart', source: 'startup' },
    { claudePid: pid },
  );
  if (started.status !== 200) throw new Error(`SessionStart failed: ${JSON.stringify(started.body)}`);
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: o.summary ?? `work of ${agent}`,
    scope: { write: o.write ?? ['src/**'], read: [] },
    assign_agent_key: agent,
  });
  const claimed = await client.claim({ task_id: task.task_id });
  const pre = async (tool: string, input: Record<string, unknown>) => {
    const res = await postHook(daemon, 'PreToolUse', toolHook('PreToolUse', tool, input, vars), { claudePid: pid });
    if (res.status !== 200) throw new Error(`PreToolUse failed: ${JSON.stringify(res.body)}`);
    return decisionOf(res.body.hook_output) ?? { decision: 'allow', reason: '' };
  };
  const edit = (target: string) =>
    pre('Edit', {
      file_path: path.isAbsolute(target) ? target : path.join(ws.projectDir, target),
      old_string: 'a',
      new_string: 'b',
    }).then((d) => d.decision);
  const bash = (command: string) => pre('Bash', { command }).then((d) => d.decision);
  return { client, task, run_id: claimed.run_id, agent, pre, edit, bash };
}
