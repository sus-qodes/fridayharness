import { describe, expect, it } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeHarness, makeSnapshot } from '../test/fixtures.js';
import { CORE_COMMAND_IDS, coreCommands, pruneToast, registerCommands } from './commands.js';

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

const PAUSED = { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null };

function setup(answers: Record<string, unknown> = {}): TestContext {
  const ctx = makeContext({ answers });
  registerCommands(ctx);
  return ctx;
}

function available(ctx: TestContext): string[] {
  return [...ctx.registry.commands.values()].filter((c) => !c.available || c.available(ctx)).map((c) => c.id);
}

async function run(ctx: TestContext, id: string): Promise<void> {
  const c = ctx.registry.commands.get(id);
  if (!c) throw new Error(`no command ${id}`);
  await c.run(ctx);
  await flush();
}

describe('core commands', () => {
  it('registers every core command with a label', () => {
    const ctx = setup();
    expect([...ctx.registry.commands.keys()]).toEqual([...CORE_COMMAND_IDS]);
    for (const c of ctx.registry.commands.values()) expect(c.label.length).toBeGreaterThan(2);
  });

  it('names the drawers as the drawers name themselves: Project memory and Messages (review §4)', () => {
    const byId = new Map(coreCommands().map((c) => [c.id, c]));
    expect(byId.get('memory')?.label).toBe('Project memory');
    expect(byId.get('inbox')?.label).toBe('Messages');
    // The old words still find them when typed.
    expect(byId.get('memory')?.keywords).toContain('memory bank');
    expect(byId.get('inbox')?.keywords).toContain('inbox');
    const labels = coreCommands().map((c) => c.label);
    expect(labels).not.toContain('Memory bank');
    expect(labels).not.toContain('Inbox');
  });

  it('offers housekeeping only when typed: reindex, prune and Stop Friday', () => {
    const typed = coreCommands()
      .filter((c) => c.show === 'typed')
      .map((c) => c.id);
    expect(typed).toEqual(['reindex-graph', 'prune-worktrees', 'stop-friday']);
    for (const c of coreCommands()) expect(c.show === undefined || c.show === 'typed').toBe(true);
  });

  it('offers "Open another project…" in the desktop app only, and asks the shell for its folder picker', async () => {
    const ctx = setup();
    // A browser's page belongs to the Friday it was opened from.
    expect(available(ctx)).not.toContain('open-project');
    let asked = 0;
    (ctx as { platform: unknown }).platform = {
      ...ctx.platform,
      kind: 'tauri',
      desktop: {
        openProject: async () => {
          asked += 1;
        },
      },
    };
    expect(available(ctx)).toContain('open-project');
    await run(ctx, 'open-project');
    expect(asked).toBe(1);
    // A shell that refuses says so, as any act does.
    (ctx.platform.desktop as { openProject: () => Promise<void> }).openProject = async () => {
      throw new Error('the folder picker could not be opened');
    };
    await run(ctx, 'open-project');
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', detail: 'the folder picker could not be opened' });
  });

  it('offers pause while running and resume only while paused', () => {
    const ctx = setup();
    expect(available(ctx)).toContain('pause');
    expect(available(ctx)).not.toContain('resume');
    ctx.board(makeSnapshot({ control: PAUSED }));
    expect(available(ctx)).toContain('resume');
    expect(available(ctx)).not.toContain('pause');
  });

  it('hides daemon commands while not connected', () => {
    const ctx = setup();
    ctx.store.setState({ board: null });
    const shown = available(ctx);
    for (const id of ['pause', 'resume', 'halt', 'new-goal', 'reindex-graph', 'prune-worktrees', 'stop-friday'])
      expect(shown).not.toContain(id);
    for (const id of ['agents', 'memory', 'graph', 'settings', 'inbox', 'mute']) expect(shown).toContain(id);
  });

  it('offers mute or unmute by the preference', async () => {
    const ctx = setup();
    expect(available(ctx)).toContain('mute');
    expect(available(ctx)).not.toContain('unmute');
    await run(ctx, 'mute');
    expect(ctx.store.select('prefs').muted).toBe(true);
    expect(available(ctx)).toContain('unmute');
    expect(available(ctx)).not.toContain('mute');
    await run(ctx, 'unmute');
    expect(ctx.store.select('prefs').muted).toBe(false);
  });

  it('pauses and resumes through the control routes', async () => {
    const ctx = setup({
      'POST /control/pause': {
        control: PAUSED,
        tasks: [{ task_id: 't', preserved_ref: 'r', host: 'spawned', stop: 'sent' }],
        operations_stopped: 0,
      },
    });
    await run(ctx, 'pause');
    expect(ctx.transport.to('POST', '/control/pause')).toHaveLength(1);
    expect(ctx.toasts.at(-1)?.text).toMatch(
      /Friday is paused.*Friday asked 1 agent it cannot hold in place to stop.*kept/,
    );
    expect(ctx.refreshes).toBe(1);
    ctx.board(makeSnapshot({ control: PAUSED, harnesses: [makeHarness({ attach_mode: 'attach' })] }));
    await run(ctx, 'resume');
    expect(ctx.transport.to('POST', '/control/resume')).toHaveLength(1);
    expect(ctx.toasts.at(-1)?.text).toBe(
      'Friday runs again. Agents connected from VS Code continue when you prompt them there.',
    );
  });

  it('opens the halt dialog, never halting directly', async () => {
    const ctx = setup();
    await run(ctx, 'halt');
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'halt' });
    expect(ctx.transport.calls).toHaveLength(0);
  });

  it('opens the drawers and the new-goal modal', async () => {
    const ctx = setup();
    const drawers: [string, string][] = [
      ['agents', 'agents'],
      ['memory', 'memory'],
      ['graph', 'graph'],
      ['inbox', 'inbox'],
    ];
    for (const [id, kind] of drawers) {
      await run(ctx, id);
      expect(ctx.store.select('ui').drawer).toEqual({ kind });
    }
    await run(ctx, 'settings');
    expect(ctx.store.select('ui').activeView).toBe('settings');
    await run(ctx, 'new-goal');
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'new-goal' });
  });

  it('marks the graph as indexing while a reindex runs, and hides the command meanwhile', async () => {
    let during: boolean | null = null;
    let offered: boolean | null = null;
    const ctx = setup({
      'POST /graph/reindex': () => {
        during = ctx.store.select('ui').indexing;
        offered = available(ctx).includes('reindex-graph');
        return { version: 'g2' };
      },
    });
    await run(ctx, 'reindex-graph');
    expect(during).toBe(true);
    expect(offered).toBe(false);
    expect(ctx.store.select('ui').indexing).toBe(false);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'success', text: 'The code graph is up to date' });
  });

  it('clears indexing when the reindex fails', async () => {
    const ctx = setup({
      'POST /graph/reindex': () => {
        throw new Error('COS-1000 bad');
      },
    });
    await run(ctx, 'reindex-graph');
    expect(ctx.store.select('ui').indexing).toBe(false);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', text: 'Reindex the code graph' });
  });

  it('prunes clean worktrees and lists what was removed and kept, with reasons', async () => {
    const ctx = setup({
      'POST /worktrees/prune': {
        removed: ['C:/wt/a', 'C:/wt/b'],
        kept: [{ path: 'C:/wt/c', reason: '3 uncommitted changes' }],
      },
    });
    await run(ctx, 'prune-worktrees');
    const t = ctx.toasts.at(-1);
    expect(t?.text).toBe('Removed 2 finished task folders; kept 1');
    expect(t?.detail).toBe('Removed C:/wt/a\nRemoved C:/wt/b\nKept C:/wt/c: 3 uncommitted changes');
    expect(t?.timeoutMs).toBe(0);
  });

  it('asks before stopping Friday and stops only when confirmed', async () => {
    const ctx = setup();
    ctx.confirmAnswer = false;
    await run(ctx, 'stop-friday');
    expect(ctx.confirms).toHaveLength(1);
    expect(ctx.confirms[0]).toMatchObject({ title: 'Stop Friday?', danger: true });
    expect(ctx.transport.to('POST', '/daemon/stop')).toHaveLength(0);
    ctx.confirmAnswer = true;
    await run(ctx, 'stop-friday');
    expect(ctx.transport.to('POST', '/daemon/stop')).toHaveLength(1);
    expect(ctx.toasts.at(-1)?.text).toBe('Friday is stopping');
  });
});

describe('pruneToast', () => {
  it('says when there was nothing to prune', () => {
    expect(pruneToast({ removed: [], kept: [] })).toEqual({
      kind: 'info',
      text: 'No finished task folder to clean up',
    });
  });

  it('caps the list and counts the rest', () => {
    const removed = Array.from({ length: 11 }, (_, i) => `C:/wt/${i}`);
    const t = pruneToast({ removed, kept: [] });
    expect(t.detail?.split('\n')).toHaveLength(9);
    expect(t.detail).toContain('… and 3 more removed');
    expect(t.kind).toBe('success');
    expect(t.timeoutMs).toBe(8000);
  });

  it('shows hostile paths with visible marks and cleans reasons', () => {
    const t = pruneToast({
      removed: ['C:/wt/<img src=x onerror=alert(1)>\u202E'],
      kept: [{ path: 'C:/wt/\u200Bk', reason: `dirty\u202E ${'r'.repeat(5000)}` }],
    });
    expect(t.detail).toContain('<img src=x onerror=alert(1)>⟨U+202E⟩');
    expect(t.detail).toContain('C:/wt/⟨U+200B⟩k');
    expect(t.detail).not.toContain('\u202E');
    expect((t.detail ?? '').length).toBeLessThan(400);
  });
});
