/**
 * The settings of config.yaml a person changes from the interface (2026-11-16): `POST
 * …/config/settings` writes only those, keeps the file's comments, records the change, and none of
 * them applies on its own say (automatic verification waits for this clone's trust).
 */
import { chmodSync, readdirSync, readFileSync } from 'node:fs';
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

describe('how a person plans, kept on their machine (2026-11-17)', () => {
  type Status = {
    provider: string;
    choice: { here: string | null; project: string; wanted: string };
    claude_code: { found: boolean; allowed: boolean; approved: boolean; project_budget_usd: number };
  };

  it('records the choice outside config.yaml, and the planner runs it from the next start', async () => {
    const td = await startTestDaemon(ws());
    const P = (p: string) => td.operator.projectPath(p);
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const before = readFileSync(file, 'utf8');
    const first = await td.operator.get<Status>(P('/brain'));
    expect(first.choice).toEqual({ here: null, project: 'anthropic', wanted: 'anthropic' });
    expect(first.claude_code).toMatchObject({ allowed: false, approved: false, project_budget_usd: 5 });

    const chosen = await td.operator.post<Status>(P('/brain/planner-choice'), { provider: 'claude-code' });
    expect(chosen.choice).toEqual({ here: 'claude-code', project: 'anthropic', wanted: 'claude-code' });
    // The planner was built when Friday started: it runs the old one until a restart.
    expect(chosen.provider).toBe('anthropic');
    // The tracked file is untouched: a teammate's planner does not change with this person's.
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(
      td.daemon.state.store
        .readSince(td.project.project_id, 0, { types: ['planner.chosen'], limit: 5 })
        .map((e) => e.payload),
    ).toEqual([{ provider: 'claude-code', was: null }]);
    // The same again records nothing more.
    await td.operator.post(P('/brain/planner-choice'), { provider: 'claude-code' });
    expect(
      td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['planner.chosen'], limit: 5 }),
    ).toHaveLength(1);
    // Only a planner a machine may choose, and only for the operator.
    await expect(td.operator.post(P('/brain/planner-choice'), { provider: 'local' })).rejects.toThrow(
      /provider is one of/,
    );
    await expect(
      td.bootstrap.post(td.bootstrap.projectPath('/brain/planner-choice'), { provider: 'none' }),
    ).rejects.toThrow();

    // Friday starts again: the choice is the planner, and config.yaml still says what the project said.
    await td.daemon.close('restart');
    const again = await startTestDaemon(ws(), { initialized: true });
    const A = (p: string) => again.operator.projectPath(p);
    const after = await again.operator.get<Status>(A('/brain'));
    expect(after.provider).toBe('claude-code');
    expect(after.choice).toEqual({ here: 'claude-code', project: 'anthropic', wanted: 'claude-code' });
    expect(readFileSync(file, 'utf8')).toBe(before);

    // Handing the choice back: the project's setting stands again.
    const back = await again.operator.post<Status>(A('/brain/planner-choice'), { provider: null });
    expect(back.choice).toEqual({ here: null, project: 'anthropic', wanted: 'anthropic' });
  });

  it('keeps the planner’s model on the machine too, and uses it from the next plan without a restart', async () => {
    type WithModel = Status & {
      model: string;
      model_choice: { here: string | null; project: string; applies: boolean };
    };
    const td = await startTestDaemon(ws());
    const P = (p: string) => td.operator.projectPath(p);
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const before = readFileSync(file, 'utf8');
    const chosen = () =>
      td.daemon.state.store
        .readSince(td.project.project_id, 0, { types: ['planner.chosen'], limit: 10 })
        .map((e) => e.payload);
    const first = await td.operator.get<WithModel>(P('/brain'));
    // The project names no model (`auto`): Friday's default, and a choice made here would count.
    expect(first.model).toBe('claude-opus-5-5');
    expect(first.model_choice).toEqual({ here: null, project: 'auto', applies: true });

    const sonnet = await td.operator.post<WithModel>(P('/brain/planner-choice'), { model: 'claude-sonnet-5-5' });
    // At once: the model is read at each planning call, so nothing restarts.
    expect(sonnet.model).toBe('claude-sonnet-5-5');
    expect(sonnet.model_choice).toEqual({ here: 'claude-sonnet-5-5', project: 'auto', applies: true });
    // How the person plans was not touched by choosing a model, and the tracked file not at all.
    expect(sonnet.choice).toEqual({ here: null, project: 'anthropic', wanted: 'anthropic' });
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(chosen()).toEqual([{ model: 'claude-sonnet-5-5', was_model: null }]);

    // A model Friday has no price for is refused: it could not count a plan against the limit.
    await expect(td.operator.post(P('/brain/planner-choice'), { model: 'some-unknown-model' })).rejects.toThrow(
      /Friday has no price for some-unknown-model/,
    );
    await expect(td.operator.post(P('/brain/planner-choice'), { model: '--help' })).rejects.toThrow();
    await expect(td.operator.post(P('/brain/planner-choice'), { model: 5 })).rejects.toThrow(/model is a model name/);
    await expect(td.operator.post(P('/brain/planner-choice'), {})).rejects.toThrow(/send/);
    expect((await td.operator.get<WithModel>(P('/brain'))).model).toBe('claude-sonnet-5-5');

    // The planner and its model in one request; each is kept when the other changes.
    const both = await td.operator.post<WithModel>(P('/brain/planner-choice'), {
      provider: 'claude-code',
      model: 'claude-fable-5-2',
    });
    expect(both.choice.here).toBe('claude-code');
    expect(both.model_choice.here).toBe('claude-fable-5-2');
    const provider = await td.operator.post<WithModel>(P('/brain/planner-choice'), { provider: null });
    expect(provider.choice.here).toBeNull();
    expect(provider.model_choice.here).toBe('claude-fable-5-2');

    // It is there after a restart, and handing it back returns to Friday's default.
    await td.daemon.close('restart');
    const again = await startTestDaemon(ws(), { initialized: true });
    const A = (p: string) => again.operator.projectPath(p);
    expect((await again.operator.get<WithModel>(A('/brain'))).model).toBe('claude-fable-5-2');
    const back = await again.operator.post<WithModel>(A('/brain/planner-choice'), { model: null });
    expect(back.model).toBe('claude-opus-5-5');
    expect(back.model_choice).toEqual({ here: null, project: 'auto', applies: true });
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});

describe('editing config.yaml from the interface, as a careful person would', () => {
  it('changes the one line it has to, and says whether automatic checks are asked for and in force', async () => {
    const td = await startTestDaemon(ws());
    const P = (p: string) => td.operator.projectPath(p);
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const before = readFileSync(file, 'utf8').split('\n');
    type Board = { verification: { auto_on_completion: boolean; auto_requested?: boolean } };
    expect((await td.operator.get<Board>(P('/ui/snapshot'))).verification).toMatchObject({
      auto_on_completion: false,
      auto_requested: false,
    });
    await td.operator.post(P('/config/settings'), { set: { 'verification.auto_on_completion': true } });
    const after = readFileSync(file, 'utf8').split('\n');
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(['  auto_on_completion: true']);
    // Asked for, and not in force: this clone has not trusted it.
    expect((await td.operator.get<Board>(P('/ui/snapshot'))).verification).toMatchObject({
      auto_on_completion: false,
      auto_requested: true,
    });
  });

  it.skipIf(process.platform !== 'win32')(
    'refuses in words, and leaves nothing behind, when config.yaml cannot be written',
    async () => {
      const td = await startTestDaemon(ws());
      const dir = path.join(ws().projectDir, '.friday');
      const file = path.join(dir, 'config.yaml');
      const before = readFileSync(file, 'utf8');
      // Read-only, as a file checked out so, or held by a program that locks it.
      chmodSync(file, 0o444);
      try {
        await expect(
          td.operator.post(td.operator.projectPath('/config/settings'), {
            set: { 'verification.auto_on_completion': true },
          }),
        ).rejects.toThrow(/could not be written.*nothing was changed/s);
        expect(readFileSync(file, 'utf8')).toBe(before);
        expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
        expect(
          td.daemon.state.store.readSince(td.project.project_id, 0, { types: ['config.edited'], limit: 5 }),
        ).toHaveLength(0);
      } finally {
        chmodSync(file, 0o644);
      }
    },
    30_000,
  );
});
