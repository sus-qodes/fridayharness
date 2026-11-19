/**
 * The settings of config.yaml a person changes from the interface (2026-11-16): `POST
 * …/config/settings` writes only those, keeps the file's comments, records the change, and none of
 * them applies on its own say (automatic verification waits for this clone's trust).
 */
import { chmodSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_AUTONOMY } from '@friday/policy';
import { ASKABLE_COMMAND_CLASSES, approveProvider, providerApproval } from '@friday/sdk';
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
      { 'master_brain.max_replans': 9 },
      { 'autonomy.git.push': 'auto' },
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

describe('what Settings sets besides (2026-11-17)', () => {
  type Checks = {
    checks: { name: string; kind: string; command: string; args: string[]; required: boolean }[];
    suggested: { name: string; command: string; args: string[]; runs: string }[];
    manager: string;
    added?: string[];
    removed?: string[];
  };

  it("lists the project's checks with what package.json suggests, and adds and removes them by name", async () => {
    const td = await startTestDaemon(ws());
    const P = (p: string) => td.operator.projectPath(p);
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const before = readFileSync(file, 'utf8');
    writeFileSync(
      path.join(ws().projectDir, 'package.json'),
      JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .', dev: 'vite', build: 'tsc --watch' } }),
    );
    const first = await td.operator.get<Checks>(P('/config/checks'));
    expect(first).toMatchObject({ checks: [], manager: 'npm' });
    // The dev server and the watcher are no checks.
    expect(first.suggested.map((s) => [s.name, s.command, ...s.args, s.runs])).toEqual([
      ['tests', 'npm', 'run', 'test', 'node --test'],
      ['lint', 'npm', 'run', 'lint', 'eslint .'],
    ]);

    const added = await td.operator.post<Checks>(P('/config/checks'), { add: ['tests'] });
    expect(added.added).toEqual(['tests']);
    // With its time limit, and what it took (nothing yet) (2026-11-19).
    expect(added.checks).toEqual([
      {
        name: 'tests',
        kind: 'test',
        command: 'npm',
        args: ['run', 'test'],
        required: true,
        timeout_ms: 120_000,
        took_ms: null,
        ran_out: false,
        suggested_ms: null,
      },
    ]);
    expect(added.suggested.map((s) => s.name)).toEqual(['lint']);
    // Only the line of the list changed, into the lines of the check.
    const was = before.split('\n');
    const now = readFileSync(file, 'utf8').split('\n');
    expect(was.filter((l) => l !== '  checks: []').every((l) => now.includes(l))).toBe(true);
    expect(now).toHaveLength(was.length + 4);
    // The board lists it with no restart: it judges the next verification.
    type Board = { verification: { checks: { name: string; kind: string; required: boolean }[] } };
    expect((await td.operator.get<Board>(P('/ui/snapshot'))).verification.checks).toEqual([
      { name: 'tests', kind: 'test', required: true },
    ]);
    // Adding it again changes nothing; a name Friday did not find is refused, and nothing is written.
    expect((await td.operator.post<Checks>(P('/config/checks'), { add: ['tests'] })).added).toEqual([]);
    const held = readFileSync(file, 'utf8');
    await expect(td.operator.post(P('/config/checks'), { add: ['deploy'] })).rejects.toThrow(
      /not a check Friday found in this project's package.json/,
    );
    await expect(td.operator.post(P('/config/checks'), { add: ['lint', 'deploy'] })).rejects.toThrow();
    expect(readFileSync(file, 'utf8')).toBe(held);

    // Its time limit, set from the app in whole minutes (2026-11-19: the way out was editing the
    // file by hand); a bad one, or a check that is not there, changes nothing.
    const limited = await td.operator.post<Checks>(P('/config/checks'), { limit: { name: 'tests', minutes: 5 } });
    expect(limited.checks[0]).toMatchObject({ name: 'tests', timeout_ms: 300_000 });
    expect(readFileSync(file, 'utf8')).toContain('timeout_ms: 300000');
    const longer = readFileSync(file, 'utf8');
    await expect(td.operator.post(P('/config/checks'), { limit: { name: 'tests', minutes: 0 } })).rejects.toThrow();
    await expect(td.operator.post(P('/config/checks'), { limit: { name: 'tests', minutes: 61 } })).rejects.toThrow();
    await expect(td.operator.post(P('/config/checks'), { limit: { name: 'nope', minutes: 5 } })).rejects.toThrow(
      /no check named "nope"/,
    );
    expect(readFileSync(file, 'utf8')).toBe(longer);
    // The board's checks are read from the file each time: the next verification gets five minutes.
    expect(
      (await td.operator.get<Checks>(P('/config/checks'))).checks.map((c) => (c as { timeout_ms?: number }).timeout_ms),
    ).toEqual([300_000]);

    const removed = await td.operator.post<Checks>(P('/config/checks'), { remove: ['tests', 'nope'] });
    expect(removed).toMatchObject({ removed: ['tests'], checks: [] });
    expect(removed.suggested.map((s) => s.name)).toEqual(['tests', 'lint']);
    // As it was before any of it, byte for byte.
    expect(readFileSync(file, 'utf8')).toBe(before);
    const recorded = td.daemon.state.store
      .readSince(td.project.project_id, 0, { types: ['config.edited'], limit: 9 })
      .map((e) => e.payload);
    expect(recorded).toEqual([
      { changed: ['verification.checks'], added: ['tests'], removed: [] },
      { changed: ['verification.checks'], limit: { name: 'tests', timeout_ms: 300_000 } },
      { changed: ['verification.checks'], added: [], removed: ['tests'] },
    ]);
    // The operator only.
    await expect(td.bootstrap.get(td.bootstrap.projectPath('/config/checks'))).rejects.toThrow();
    await expect(td.bootstrap.post(td.bootstrap.projectPath('/config/checks'), { add: ['tests'] })).rejects.toThrow();
  });

  it('lets agents run a kind of command without asking only once this clone trusts it', async () => {
    const td = await startTestDaemon(ws());
    const P = (p: string) => td.operator.projectPath(p);
    type Policy = {
      policy: {
        autonomy: Record<string, string>;
        loosening: { source: string; setting: string; from: string; to: string; id: string; trusted: boolean }[];
        loosening_hash: string | null;
        trusted: boolean;
      };
    };
    const set = (s: Record<string, unknown>) =>
      td.operator.post<{ changed: string[] }>(P('/config/settings'), { set: s });
    expect((await set({ 'autonomy.package.install': 'auto' })).changed).toEqual(['autonomy.package.install']);
    const asked = await td.operator.get<Policy>(P('/policy'));
    expect(asked.policy.loosening).toMatchObject([
      { source: 'config.yaml', setting: 'autonomy.package.install', from: 'review', to: 'auto', trusted: false },
    ]);
    // Asked for, and not in force.
    expect(asked.policy.trusted).toBe(false);
    expect(asked.policy.autonomy['package.install'] ?? 'review').toBe('review');
    const trusted = await td.operator.post<Policy>(P('/policy/trust'), {
      loosening_hash: asked.policy.loosening_hash,
    });
    expect(trusted.policy.trusted).toBe(true);
    expect(trusted.policy.autonomy['package.install']).toBe('auto');

    // A second kind waits for its own trust (2026-11-18): the first stays in force meanwhile. One
    // hash used to cover the list, so switching a second thing on switched the first off again.
    await set({ 'autonomy.unknown': 'auto' });
    const two = await td.operator.get<Policy>(P('/policy'));
    expect(two.policy.loosening.map((l) => [l.setting, l.trusted])).toEqual([
      ['autonomy.package.install', true],
      ['autonomy.unknown', false],
    ]);
    expect(two.policy.trusted).toBe(false);
    expect(two.policy.autonomy['package.install']).toBe('auto');
    expect(two.policy.autonomy.unknown ?? 'review').toBe('review');
    // Trusted by its own id: that one, and nothing else that might wait.
    await set({ 'autonomy.process.kill': 'auto' });
    const three = await td.operator.get<Policy>(P('/policy'));
    const idOf = (setting: string) => three.policy.loosening.find((l) => l.setting === setting)?.id as string;
    const one = await td.operator.post<Policy>(P('/policy/trust'), { items: [idOf('autonomy.unknown')] });
    expect(one.policy.loosening.map((l) => [l.setting, l.trusted])).toEqual([
      ['autonomy.package.install', true],
      ['autonomy.process.kill', false],
      ['autonomy.unknown', true],
    ]);
    expect(one.policy.autonomy.unknown).toBe('auto');
    expect(one.policy.autonomy['process.kill'] ?? 'review').toBe('review');
    // An id that names nothing the files ask for now trusts nothing, also not what was sent with it.
    await expect(
      td.operator.post(P('/policy/trust'), { items: [idOf('autonomy.process.kill'), 'ffffffffffffffff'] }),
    ).rejects.toThrow(/changed since you looked/);
    expect((await td.operator.get<Policy>(P('/policy'))).policy.autonomy['process.kill'] ?? 'review').toBe('review');
    await expect(td.operator.post(P('/policy/trust'), { items: [] })).rejects.toThrow();
    await expect(td.operator.post(P('/policy/trust'), { items: ['x'], loosening_hash: 'y' })).rejects.toThrow();

    // Asking again for one is a tightening, in force at once; what stays on stays trusted.
    await set({ 'autonomy.unknown': 'review' });
    await set({ 'autonomy.process.kill': 'review' });
    const back = await td.operator.get<Policy>(P('/policy'));
    expect(back.policy.loosening.map((l) => [l.setting, l.trusted])).toEqual([['autonomy.package.install', true]]);
    expect(back.policy.trusted).toBe(true);
    expect(back.policy.autonomy['package.install']).toBe('auto');
    // Switched off, a setting loses its trust: switched on again it is asked about again.
    await set({ 'autonomy.unknown': 'auto' });
    const again = await td.operator.get<Policy>(P('/policy'));
    expect(again.policy.loosening.find((l) => l.setting === 'autonomy.unknown')?.trusted).toBe(false);
    expect(again.policy.autonomy.unknown ?? 'review').toBe('review');
    await set({ 'autonomy.unknown': 'review' });
    // What this computer trusts is kept by name, in its private folder.
    const kept = JSON.parse(readFileSync(path.join(td.daemon.privateDir, 'policy-trust.json'), 'utf8')) as {
      loosening_hash: string | null;
      items: string[];
    };
    expect(kept.items).toEqual([back.policy.loosening[0]?.id]);
    // Trusted one at a time: no name for the whole list stands beside them.
    expect(kept.loosening_hash).toBeNull();

    // The kinds a page may allow are exactly the ones the policy asks about by default.
    const asksByDefault = Object.entries(DEFAULT_AUTONOMY)
      .filter(([, level]) => level === 'review')
      .map(([cls]) => cls);
    expect([...ASKABLE_COMMAND_CLASSES].sort()).toEqual(asksByDefault.sort());

    // What always asks, and what is never allowed, no page loosens.
    const file = path.join(ws().projectDir, '.friday', 'config.yaml');
    const held = readFileSync(file, 'utf8');
    for (const s of [
      { 'autonomy.git.push': 'auto' },
      { 'autonomy.secrets.read': 'auto' },
      { 'autonomy.package.install': 'never' },
      { autonomy: { 'git.push': 'auto' } },
    ]) {
      await expect(set(s)).rejects.toThrow();
    }
    expect(readFileSync(file, 'utf8')).toBe(held);
  });

  it('says whether plans are asked to start on their own, what planning may spend, and takes spending back', async () => {
    const td = await startTestDaemon(ws());
    const P = (p: string) => td.operator.projectPath(p);
    type Status = {
      auto_approve: boolean;
      auto_approve_requested: boolean;
      approved_here: boolean;
      spending: { provider: string; approved: boolean; yours_usd: number | null; project_usd: number };
    };
    const first = await td.operator.get<Status>(P('/brain'));
    expect(first).toMatchObject({ auto_approve: false, auto_approve_requested: false });
    expect(first.spending).toEqual({ provider: 'anthropic', approved: false, yours_usd: null, project_usd: 5 });

    // Starting plans without approval: asked for in config.yaml, in force only once trusted.
    await td.operator.post(P('/config/settings'), { set: { 'master_brain.auto_approve': true } });
    expect(await td.operator.get<Status>(P('/brain'))).toMatchObject({
      auto_approve: false,
      auto_approve_requested: true,
    });
    const policy = await td.operator.get<{ policy: { loosening_hash: string } }>(P('/policy'));
    await td.operator.post(P('/policy/trust'), { loosening_hash: policy.policy.loosening_hash });
    expect(await td.operator.get<Status>(P('/brain'))).toMatchObject({
      auto_approve: true,
      auto_approve_requested: true,
    });
    await td.operator.post(P('/config/settings'), { set: { 'master_brain.auto_approve': false } });
    expect(await td.operator.get<Status>(P('/brain'))).toMatchObject({
      auto_approve: false,
      auto_approve_requested: false,
    });

    // This machine allows the spending: its own act, never a route's.
    await expect(td.operator.post(P('/brain/allow-remote'), { budget: 100 })).rejects.toThrow();
    approveProvider(td.project, 'anthropic', { daily_budget_usd: 2 }, { FRIDAY_STATE_DIR: ws().stateDir });
    const allowed = await td.operator.get<Status>(P('/brain'));
    expect(allowed.approved_here).toBe(true);
    expect(allowed.spending).toEqual({ provider: 'anthropic', approved: true, yours_usd: 2, project_usd: 5 });

    // Taking it back only tightens: the page may, and it holds at once.
    await expect(td.operator.post(P('/brain/deny-remote'), { provider: 'openai' })).rejects.toThrow(
      /anthropic or claude-code/,
    );
    await expect(td.bootstrap.post(td.bootstrap.projectPath('/brain/deny-remote'), {})).rejects.toThrow();
    const off = await td.operator.post<{ removed: boolean; brain: Status }>(P('/brain/deny-remote'), {
      provider: 'anthropic',
    });
    expect(off.removed).toBe(true);
    expect(off.brain.approved_here).toBe(false);
    expect(off.brain.spending.approved).toBe(false);
    expect(providerApproval(td.project, 'anthropic', { FRIDAY_STATE_DIR: ws().stateDir })).toBeUndefined();
    // Again: nothing was there, and nothing more is recorded.
    expect((await td.operator.post<{ removed: boolean }>(P('/brain/deny-remote'), {})).removed).toBe(false);
    expect(
      td.daemon.state.store
        .readSince(td.project.project_id, 0, { types: ['planner.spending_denied'], limit: 5 })
        .map((e) => e.payload),
    ).toEqual([{ provider: 'anthropic' }]);
  });
});
