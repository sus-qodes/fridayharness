/**
 * The project's own policy behind a trust boundary (plan M6b, ADR-0028; spec Part 07 §3, §11).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { claudeCodeHooks } from '@friday/adapter-claude';
import { GenericHarnessClient } from '@friday/adapter-generic';
import type { TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { decisionOf, postHook, toolHook } from '../helpers/hooks.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

interface Effective {
  trusted: boolean;
  loosening: { setting: string; source: string }[];
  loosening_hash: string | null;
  version: string;
  deny: { write: string[] };
  errors: { file: string }[];
}

const policyFile = (name: string, text: string) => {
  const dir = path.join(ws().projectDir, '.friday', 'policies');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, name), text);
};

/** A Claude Code session of a frontend agent holding a task that may write anywhere. */
async function session(td: TestDaemon) {
  const pid = 8101;
  const sessionId = 'sess-policy';
  const client = new GenericHarnessClient(td.bootstrap, {
    harness_key: `claude-code:${td.project.project_id}:pid:${pid}`,
    vendor: 'claude-code',
    name: 'Claude Code',
    version: '2.1.296',
    adapter_version: '0.1.0',
    attach_mode: 'attach',
    project_id: td.project.project_id,
    capabilities: { hooks: true },
    agent_key: 'fe-1',
    role: 'frontend',
    host: { pid, session_id: sessionId, cwd: ws().projectDir },
  });
  await client.register();
  const daemon = { url: td.url, projectId: td.project.project_id, token: td.daemon.tokens.bootstrap };
  const vars = { projectDir: ws().projectDir, sessionId };
  await postHook(
    daemon,
    'SessionStart',
    { session_id: sessionId, cwd: vars.projectDir, hook_event_name: 'SessionStart', source: 'startup' },
    { claudePid: pid },
  );
  const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
    summary: 'frontend work',
    scope: { write: ['**'], read: [] },
    assign_agent_key: 'fe-1',
  });
  await client.claim({ task_id: task.task_id });
  const pre = async (tool: string, input: Record<string, unknown>) => {
    const res = await postHook(daemon, 'PreToolUse', toolHook('PreToolUse', tool, input, vars), { claudePid: pid });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return decisionOf(res.body.hook_output) ?? { decision: 'allow', reason: '' };
  };
  const edit = (rel: string) =>
    pre('Edit', { file_path: path.join(ws().projectDir, rel), old_string: 'a', new_string: 'b' }).then(
      (d) => d.decision,
    );
  return { client, task, pre, edit };
}

const show = (td: TestDaemon) =>
  td.operator.get<{ policy: Effective }>(td.operator.projectPath('/policy')).then((r) => r.policy);
const reload = (td: TestDaemon) =>
  td.operator.post<{ policy: Effective }>(td.operator.projectPath('/policy/reload'), {}).then((r) => r.policy);

describe('project policy and trust', () => {
  it('applies what tracked files tighten at once, and what they loosen only after this clone trusts exactly that', async () => {
    const td = await startTestDaemon(ws(), {
      git: true,
      extensions: [claudeCodeHooks()],
      extraConfig: 'autonomy:\n  git.push: auto\n',
    });
    const { client, pre, edit } = await session(td);
    const dir = ws().projectDir;

    // config.yaml asks for pushes without review: repository content, so not applied yet.
    expect((await pre('Bash', { command: 'git push' })).decision).toBe('deny');
    expect(await show(td)).toMatchObject({
      trusted: false,
      loosening: [{ setting: 'autonomy.git.push', source: 'config.yaml' }],
    });

    // A policy file that only tightens applies without trust.
    policyFile(
      'infra.yaml',
      'deny:\n  write: ["infra/**"]\nteams:\n  frontend:\n    write: ["frontend/**", "infra/**", "docs/**"]\n',
    );
    await reload(td);
    expect(await edit('frontend/a.ts')).toBe('allow');
    const denied = await pre('Edit', {
      file_path: path.join(dir, 'infra', 'deploy.json'),
      old_string: 'a',
      new_string: 'b',
    });
    expect(denied).toMatchObject({ decision: 'deny' });
    expect(denied.reason).toContain("project's policy");
    expect(await edit('backend/a.ts')).toBe('deny');

    // Trusting shows what loosens first, and applies only with --yes.
    const asked = await cli(['--project', dir, 'policy', 'trust']);
    expect(asked.stdout).toContain('autonomy.git.push: manual -> auto (config.yaml)');
    expect((await show(td)).trusted).toBe(false);
    expect((await cli(['--project', dir, 'policy', 'trust', '--yes'])).code).toBe(0);
    expect((await show(td)).trusted).toBe(true);
    expect((await pre('Bash', { command: 'git push' })).decision).toBe('allow');

    // An approval made under this policy...
    const asked2 = await client.requestPermission({
      action_class: 'file.write',
      resource: 'backend/b.ts',
      justification: 'one shared fix',
      ttl_s: 600,
      reuse: 'task',
    });
    await cli(['--project', dir, 'approve', asked2.approval_id as string]);
    expect(await edit('backend/b.ts')).toBe('allow');

    // ...and the trust both end when the loosening changes: it is a different policy.
    policyFile('relax.yaml', 'risk:\n  shell.git.commit: low\n');
    const changed = await reload(td);
    expect(changed.trusted).toBe(false);
    expect((await pre('Bash', { command: 'git push' })).decision).toBe('deny');
    expect(await edit('backend/b.ts')).toBe('deny');
  });

  it('reports a policy file it cannot read and applies nothing from it', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    policyFile('broken.yaml', 'deny:\n  write: ["infra/**"]\n  overwrite: true\n');
    const p = await reload(td);
    expect(p.errors.map((e) => e.file)).toEqual(['policies/broken.yaml']);
    expect(p.deny.write).toEqual([]);
    const validated = await cli(['--project', ws().projectDir, 'policy', 'validate']);
    expect(validated.code).toBe(1);
    expect(validated.stdout).toContain('invalid broken.yaml');
    const shown = await cli(['--project', ws().projectDir, 'policy', 'show']);
    expect(shown.stdout).toContain('NOT APPLIED policies/broken.yaml');
  });

  it('applies a new or changed policy file without a reload (LESSONS D-43)', async () => {
    const td = await startTestDaemon(ws(), { git: true, extensions: [claudeCodeHooks()] });
    const { edit } = await session(td);
    expect(await edit('infra/deploy.json')).toBe('allow');

    // A file a teammate's commit adds, or a human writes: it tightens on the next judgment.
    policyFile('infra.yaml', 'deny:\n  write: ["infra/**"]\n');
    expect(await edit('infra/deploy.json')).toBe('deny');
    expect((await show(td)).deny.write).toEqual(['infra/**']);

    // Changed: the new rule replaces the old one.
    policyFile('infra.yaml', 'deny:\n  write: ["docs/**"]\n');
    expect(await edit('infra/deploy.json')).toBe('allow');
    expect(await edit('docs/a.md')).toBe('deny');
  });
});
