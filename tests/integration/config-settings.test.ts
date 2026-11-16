/**
 * The settings of config.yaml a person changes from the interface (2026-11-16): `POST
 * …/config/settings` writes only those, keeps the file's comments, records the change, and none of
 * them applies on its own say (automatic verification waits for this clone's trust).
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();

describe('config settings from the interface', () => {
  it('sets the planner and automatic verification in config.yaml, keeps its comments, and records it', async () => {
    const td = await startTestDaemon(ws());
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const before = readFileSync(file, 'utf8');
    const r = await td.operator.post<{ changed: string[] }>(td.operator.projectPath('/config/settings'), {
      set: {
        'master_brain.provider': 'claude-code',
        'providers.claude-code.allow_remote': true,
        'providers.claude-code.daily_budget_usd': 2,
        'verification.auto_on_completion': true,
      },
    });
    expect(r.changed).toHaveLength(4);
    const after = readFileSync(file, 'utf8');
    expect(after).toMatch(/provider: claude-code/);
    expect(after).toMatch(/auto_on_completion: true/);
    expect(after).toContain('# Friday project configuration. Tracked in git; never put secrets here.');
    expect(after.split('\n').length).toBeGreaterThanOrEqual(before.split('\n').length);
    const recorded = td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['config.edited'], limit: 5 });
    expect(recorded.map((e) => (e.payload as { changed: string[] }).changed)).toEqual([r.changed]);
    // The same again changes nothing and records nothing.
    expect(
      await td.operator.post<{ changed: string[] }>(td.operator.projectPath('/config/settings'), {
        set: { 'master_brain.provider': 'claude-code' },
      }),
    ).toEqual({ changed: [] });

    // Automatic verification is a loosening: the policy asks this clone to trust it before it applies.
    const policy = await td.operator.get<{ policy: { loosening: { setting: string }[]; trusted: boolean } }>(
      td.operator.projectPath('/policy'),
    );
    expect(policy.policy.loosening.map((l) => l.setting)).toContain('verification.auto_on_completion');
    expect(policy.policy.trusted).toBe(false);
  });

  it('refuses any other setting, a bad value, and a caller without the operator token', async () => {
    const td = await startTestDaemon(ws());
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const before = readFileSync(file, 'utf8');
    for (const set of [
      { sandbox: true },
      { 'verification.checks': [] },
      { 'master_brain.provider': 'somewhere-else' },
      { 'master_brain.auto_approve': true },
    ]) {
      await expect(td.operator.post(td.operator.projectPath('/config/settings'), { set })).rejects.toThrow();
    }
    await expect(
      td.bootstrap.post(td.bootstrap.projectPath('/config/settings'), { set: { 'master_brain.provider': 'none' } }),
    ).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
