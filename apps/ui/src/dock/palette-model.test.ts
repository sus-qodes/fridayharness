import { describe, expect, it } from 'vitest';
import { makeContext } from '../test/context.js';
import { makeAgent, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import { registerCommands } from './commands.js';
import {
  boardEntries,
  collectEntries,
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
