import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeAgent, makeGoal, makePlan, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import { registerCommands } from './commands.js';
import {
  boardEntries,
  collectEntries,
  commandShow,
  forgetRecent,
  LABEL_MAX,
  type PaletteEntry,
  RECENT_MAX,
  rankEntries,
  recentIds,
  remember,
} from './palette-model.js';

function entry(id: string, label: string, group: PaletteEntry['group'] = 'command', keywords: string[] = []) {
  return { id, label, group, keywords, icon: 'bolt', run: () => undefined } as PaletteEntry;
}

describe('commandShow', () => {
  it('reads the command’s own word, else always: no table apart from the registrations', () => {
    expect(commandShow({ id: 'pause' })).toBe('always');
    expect(commandShow({ id: 'prune-worktrees', show: 'typed' })).toBe('typed');
    expect(commandShow({ id: 'zoom-in', show: 'never' })).toBe('never');
    // A command that declares nothing is listed: the canvas declares its own (stage.ts), and the
    // first-screen test checks them through the palette.
    expect(commandShow({ id: 'zoom-in' })).toBe('always');
  });
});

describe('collectEntries', () => {
  it('lists available commands, agents, tasks, goals and files seen in the activity', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    registerCommands(ctx);
    ctx.store.patch('activity', {
      files: { task_00000000000000000000api001: [{ path: 'backend/src/billing.ts', at: 1 }] },
    });
    const entries = collectEntries(ctx);
    const ids = entries.map((e) => e.id);
    expect(ids).toContain('cmd:pause');
    expect(ids).not.toContain('cmd:resume');
    expect(ids).toContain('agent:claude-1');
    expect(ids).toContain('task:task_00000000000000000000api001');
    expect(ids).toContain('goal:goal_0000000000000000000000gg01');
    expect(ids).toContain('file:task_00000000000000000000api001:backend/src/billing.ts');
    const file = entries.find((e) => e.group === 'file');
    expect(file?.label).toBe('billing.ts');
    expect(file?.detail).toBe('backend/src/billing.ts · Add the subscription API');
  });

  it('runs each kind of entry to its place', async () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    ctx.store.patch('activity', { files: { task_x: [{ path: 'a.ts', at: 1 }] } });
    const entries = boardEntries(ctx.store.select('board'), ctx.store.select('activity'));
    const byId = (id: string) => entries.find((e) => e.id === id) as PaletteEntry;
    await byId('task:task_00000000000000000000api001').run(ctx);
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: 'task_00000000000000000000api001' });
    expect(ctx.store.select('ui').selectedTaskId).toBe('task_00000000000000000000api001');
    await byId('agent:codex-1').run(ctx);
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'terminal', id: 'codex-1' });
    await byId('file:task_x:a.ts').run(ctx);
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'diff', id: 'task_x', path: 'a.ts' });
    await byId('goal:goal_0000000000000000000000gg01').run(ctx);
    expect(ctx.store.select('ui').selectedTaskId).toBe('goal_0000000000000000000000gg01');
  });

  it('offers the plan editor of an open goal without a plan, and only of one (review R1)', async () => {
    const open = makeGoal({ goal_id: 'goal_open', status: 'OPEN', plan_id: null, request: 'Add subscriptions' });
    const proposed = makeGoal({ goal_id: 'goal_proposed', status: 'OPEN' });
    const active = makeGoal({ goal_id: 'goal_active', status: 'ACTIVE' });
    const cancelled = makeGoal({ goal_id: 'goal_cancelled', status: 'CANCELLED', plan_id: null });
    const ctx = makeContext({
      snapshot: makeSnapshot({
        goals: [open, proposed, active, cancelled],
        plans: {
          goal_proposed: { active: null, proposed: makePlan({ status: 'PROPOSED' }) },
          goal_active: { active: makePlan(), proposed: null },
        },
      }),
    });
    const entries = boardEntries(ctx.store.select('board'), null);
    const plans = entries.filter((e) => e.id.startsWith('goal-plan:'));
    expect(plans.map((e) => e.id)).toEqual(['goal-plan:goal_open']);
    expect(plans[0]).toMatchObject({ group: 'goal', label: 'Write the plan: Add subscriptions' });
    expect(rankEntries(entries, 'write plan')[0]?.entry.id).toBe('goal-plan:goal_open');
    await plans[0]?.run(ctx);
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: 'goal_open', mode: 'first' });
  });

  it('leaves out commands the palette never lists, and marks the typed-only ones', () => {
    const ctx = makeContext({ snapshot: makeScenario() });
    registerCommands(ctx);
    // The canvas's commands as stage.ts registers them: each declares where the palette offers it.
    ctx.registry.command({ id: 'zoom-in', label: 'Zoom in', show: 'never', run: () => undefined });
    ctx.registry.command({ id: 'zoom-out', label: 'Zoom out', show: 'never', run: () => undefined });
    ctx.registry.command({ id: 'reset-layout', label: 'Reset moved cards', show: 'typed', run: () => undefined });
    ctx.registry.command({ id: 'fit', label: 'Fit everything', run: () => undefined });
    const entries = collectEntries(ctx);
    const ids = entries.map((e) => e.id);
    expect(ids).not.toContain('cmd:zoom-in');
    expect(ids).not.toContain('cmd:zoom-out');
    expect(ids).toContain('cmd:fit');
    const typedOnly = entries.filter((e) => e.typedOnly).map((e) => e.id);
    expect(typedOnly).toEqual(['cmd:reindex-graph', 'cmd:prune-worktrees', 'cmd:stop-friday', 'cmd:reset-layout']);
    expect(entries.find((e) => e.id === 'cmd:pause')?.typedOnly).toBeUndefined();
  });

  it('skips a command whose availability check throws', () => {
    const ctx = makeContext();
    ctx.registry.command({
      id: 'broken',
      label: 'Broken',
      available: () => {
        throw new Error('x');
      },
      run: () => undefined,
    });
    expect(collectEntries(ctx).map((e) => e.id)).not.toContain('cmd:broken');
  });

  it('makes hostile board text safe in labels', () => {
    const hostile = '<img src=x onerror=alert(1)>';
    const board = makeSnapshot({
      tasks: [makeTask({ summary: `${hostile}‮​${'w'.repeat(5000)}` })],
      agents: [makeAgent({ agent_key: `bad‮key` })],
    });
    const entries = boardEntries(board, {
      agents: {},
      files: { t: [{ path: `src/${hostile}‮.ts`, at: 1 }] },
      pulses: [],
      lastActivityAt: 0,
      reactions: [],
    });
    const task = entries.find((e) => e.group === 'task') as PaletteEntry;
    expect(Array.from(task.label).length).toBeLessThanOrEqual(LABEL_MAX);
    expect(task.label).not.toContain('‮');
    expect(task.label.startsWith(hostile)).toBe(true);
    const agent = entries.find((e) => e.group === 'agent') as PaletteEntry;
    expect(agent.label).toBe('bad⟨U+202E⟩key');
    const file = entries.find((e) => e.group === 'file') as PaletteEntry;
    expect(file.label).toBe(`${hostile}⟨U+202E⟩.ts`);
  });
});

describe('rankEntries', () => {
  const entries = [
    entry('cmd:pause', 'Pause Friday'),
    entry('cmd:prune', 'Prune clean worktrees'),
    entry('cmd:graph', 'Code graph'),
    entry('task:1', 'Add the pricing page', 'task', ['task_0001']),
    entry('agent:claude-1', 'claude-1', 'agent', ['developer']),
    entry('goal:1', 'Subscriptions', 'goal'),
  ];

  it('without a query: recent first (newest first), then by group', () => {
    const r = rankEntries(entries, '', ['task:1', 'cmd:graph', 'gone:1']);
    expect(r.map((x) => x.entry.id)).toEqual([
      'task:1',
      'cmd:graph',
      'cmd:pause',
      'cmd:prune',
      'agent:claude-1',
      'goal:1',
    ]);
    expect(r.slice(0, 2).every((x) => x.recent)).toBe(true);
  });

  it('with a query: only matches, best first, with the matched characters', () => {
    const r = rankEntries(entries, 'pr');
    expect(r[0]?.entry.id).toBe('cmd:prune');
    expect(r[0]?.indices).toEqual([0, 1]);
    // "Code graph" and "Subscriptions" hold a p and an r, but not in that order.
    expect(r.map((x) => x.entry.id)).not.toContain('cmd:graph');
    expect(r.map((x) => x.entry.id)).not.toContain('goal:1');
  });

  it('without a query: typed-only entries stay out, unless recently run; typed, they match', () => {
    const typed = { ...entry('cmd:stop', 'Stop Friday…'), typedOnly: true };
    const all = [...entries, typed];
    expect(rankEntries(all, '').map((x) => x.entry.id)).not.toContain('cmd:stop');
    expect(rankEntries(all, '', ['cmd:stop']).map((x) => x.entry.id)[0]).toBe('cmd:stop');
    expect(rankEntries(all, 'stop fri')[0]?.entry.id).toBe('cmd:stop');
  });

  it('with a query: recent matches first', () => {
    const r = rankEntries(entries, 'p', ['task:1']);
    expect(r[0]?.entry.id).toBe('task:1');
    expect(r[0]?.recent).toBe(true);
  });

  it('matches keywords, a little below the label', () => {
    const r = rankEntries(entries, 'task_0001');
    expect(r.map((x) => x.entry.id)).toEqual(['task:1']);
    expect(r[0]?.indices).toEqual([]);
    expect(rankEntries(entries, 'developer')[0]?.entry.id).toBe('agent:claude-1');
  });

  it('breaks ties by the shorter label and caps the results', () => {
    const many = Array.from({ length: 80 }, (_, i) => entry(`e${i}`, `item ${'x'.repeat(i)}`));
    const r = rankEntries(many, 'item', [], 50);
    expect(r).toHaveLength(50);
    expect(r[0]?.entry.id).toBe('e0');
  });
});

describe('recent actions', () => {
  it('keeps the newest first, without duplicates, at most RECENT_MAX', () => {
    const ctx = makeContext();
    for (let i = 0; i < RECENT_MAX + 3; i++) remember(ctx, `e${i}`);
    remember(ctx, 'e5');
    const ids = recentIds(ctx);
    expect(ids[0]).toBe('e5');
    expect(ids).toHaveLength(RECENT_MAX);
    expect(new Set(ids).size).toBe(ids.length);
    forgetRecent(ctx);
    expect(recentIds(ctx)).toEqual([]);
    // Another interface instance has its own list.
    expect(recentIds(makeContext())).toEqual([]);
  });
});
