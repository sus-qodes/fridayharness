import { describe, expect, it, vi } from 'vitest';
import type { GraphQuery } from '../api/client.js';
import type { RecordedCall } from '../test/context.js';
import { makeContext } from '../test/context.js';
import { makeSnapshot, makeTask } from '../test/fixtures.js';
import { createCodeGraph, runningScopes } from './code-graph.js';

const IMG = '<img src=x onerror=alert(1)>';
const BIDI = '\u202E';
const HOSTILE = `frontend/${IMG}${BIDI}.ts`;
const CENTER = 'shared/src/api.ts';
const RUNNING = 'task_00000000000000000000run001';

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0));
}

function q(path: string, depth: number): GraphQuery {
  if (path === CENTER)
    return {
      version: 'v1',
      node: { path: CENTER, area: 'shared', contract: { areas: ['backend', 'frontend'] } },
      dependencies: [{ to: 'shared/src/types.ts', kind: 'import' }],
      consumers: [
        { from: 'backend/src/checkout.ts', kind: 'import' },
        { from: HOSTILE, kind: 'import' },
        { from: 'shared/test/api.test.ts', kind: 'import' },
      ],
      tests: ['shared/test/api.test.ts'],
      neighbourhood: [
        { path: 'shared/src/types.ts', distance: 1 },
        { path: 'backend/src/checkout.ts', distance: 1 },
        { path: HOSTILE, distance: 1 },
        { path: 'shared/test/api.test.ts', distance: 1 },
        ...(depth >= 2 ? [{ path: 'backend/src/server.ts', distance: 2 }] : []),
      ],
    };
  return {
    version: 'v1',
    node: { path, area: path.split('/')[0] ?? null },
    dependencies: [{ to: CENTER, kind: 'import' }],
    consumers: [{ from: `${path}.consumer.ts`, kind: 'import' }],
    tests: [],
    neighbourhood: [{ path: CENTER, distance: 1 }],
  };
}

function params(call: RecordedCall | undefined): URLSearchParams {
  return new URLSearchParams(call?.path.split('?')[1] ?? '');
}

function setup(path: string | null = CENTER, answers: Record<string, unknown> = {}) {
  const ctx = makeContext({
    snapshot: makeSnapshot({
      tasks: [
        makeTask({
          task_id: RUNNING,
          status: 'RUNNING',
          summary: `Checkout ${IMG}`,
          scope: { write: ['backend/**'], read: [] },
        }),
        makeTask({ task_id: 'task_ready', status: 'READY', scope: { write: ['frontend/**'], read: [] } }),
      ],
    }),
    answers: {
      'GET /graph/query': (call: RecordedCall) => {
        const p = params(call);
        const file = p.get('path') ?? '';
        if (file === 'missing.ts')
          throw new Error('missing.ts is not in the code graph (only TS/JS files git sees are)');
        return q(file, Number(p.get('depth')));
      },
      'GET /graph': { version: 'v1', stats: {}, contracts: [{ path: CENTER, area: 'shared', consumers: ['backend'] }] },
      ...answers,
    },
  });
  const open = vi.fn();
  (ctx.platform as { openInEditor: (p: string, l?: number) => void }).openInEditor = open;
  const drawer = createCodeGraph(ctx, { kind: 'graph', ...(path ? { path } : {}) });
  document.body.append(drawer.el);
  return { ctx, drawer, open };
}

function node(root: HTMLElement, path: string): SVGGElement | undefined {
  return [...root.querySelectorAll<SVGGElement>('.dr-g-node')].find((g) => g.getAttribute('data-path') === path);
}

function buttonNamed(root: HTMLElement, text: string): HTMLButtonElement | undefined {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text));
}

describe('runningScopes', () => {
  it('takes the write scopes of running tasks only', () => {
    expect(
      runningScopes([
        { task_id: 'a', status: 'RUNNING', summary: 'A', scope: { write: ['x/**', 'y'] } },
        { task_id: 'b', status: 'READY', summary: 'B', scope: { write: ['z/**'] } },
        { task_id: 'c', status: 'RUNNING', summary: 'C', scope: null },
      ]).map((s) => s.glob),
    ).toEqual(['x/**', 'y']);
  });
});

describe('the code graph drawer', () => {
  it("says it is the main checkout's graph and draws the neighbourhood as SVG", async () => {
    const { ctx, drawer } = setup();
    await settle();
    expect(drawer.el.textContent).toContain("main checkout's code graph (TS/JS files)");
    const first = ctx.transport.to('GET', '/graph/query')[0];
    expect(params(first).get('path')).toBe(CENTER);
    expect(params(first).get('depth')).toBe('2');
    expect(drawer.el.querySelectorAll('.dr-g-node')).toHaveLength(6);
    expect(drawer.el.querySelectorAll('.dr-g-edge').length).toBeGreaterThanOrEqual(4);
    expect(drawer.el.textContent).toContain('Two steps away');
    drawer.destroy();
  });

  it('shows hostile file names as text with visible marks', async () => {
    const { drawer } = setup();
    await settle();
    expect(drawer.el.querySelector('img')).toBeNull();
    const g = node(drawer.el, HOSTILE);
    expect(g?.getAttribute('aria-label')).toContain('⟨U+202E⟩');
    expect(g?.querySelector('title')?.textContent).toBe(`frontend/${IMG}⟨U+202E⟩.ts`);
    expect(g?.querySelector('.dr-g-label')?.textContent).not.toContain(BIDI);
    drawer.destroy();
  });

  it('colours write scopes of running tasks, shared contracts and tests', async () => {
    const { drawer } = setup();
    await settle();
    expect(node(drawer.el, 'backend/src/checkout.ts')?.getAttribute('class')).toContain('dr-g-tone-scope');
    expect(node(drawer.el, CENTER)?.getAttribute('class')).toContain('dr-g-tone-contract');
    expect(node(drawer.el, 'shared/test/api.test.ts')?.getAttribute('class')).toContain('dr-g-tone-test');
    expect(node(drawer.el, HOSTILE)?.getAttribute('class')).toContain('dr-g-tone-plain');
    drawer.destroy();
  });

  it('selects a file on click and shows its links in the panel', async () => {
    const { ctx, drawer, open } = setup();
    await settle();
    node(drawer.el, 'backend/src/checkout.ts')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await settle();
    const detail = ctx.transport
      .to('GET', '/graph/query')
      .find((c) => params(c).get('path') === 'backend/src/checkout.ts');
    expect(params(detail).get('depth')).toBe('1');
    expect(node(drawer.el, 'backend/src/checkout.ts')?.getAttribute('aria-pressed')).toBe('true');
    const panel = drawer.el.querySelector('.dr-graph-panel');
    expect(panel?.textContent).toContain('backend/src/checkout.ts');
    expect(panel?.textContent).toContain('Imports (1)');
    expect(panel?.textContent).toContain('Imported by (1)');
    expect(panel?.textContent).toContain('In the write scope of');
    expect(panel?.textContent).toContain(`Checkout ${IMG}`);
    expect(drawer.el.querySelector('img')).toBeNull();
    buttonNamed(drawer.el, 'Open in VS Code')?.click();
    expect(open).toHaveBeenCalledWith('C:/demo/shop/backend/src/checkout.ts');
    buttonNamed(panel as HTMLElement, `Checkout ${IMG}`)?.click();
    expect(ctx.store.select('ui').drawer).toEqual({ kind: 'inspector', id: RUNNING });
    drawer.destroy();
  });

  it('recentres on a double-click, on Shift+Enter and from the panel', async () => {
    const { ctx, drawer } = setup();
    await settle();
    node(drawer.el, 'shared/src/types.ts')?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    await settle();
    const deep = ctx.transport.to('GET', '/graph/query').filter((c) => params(c).get('depth') === '2');
    expect(params(deep.at(-1)).get('path')).toBe('shared/src/types.ts');
    expect(drawer.el.querySelector<HTMLInputElement>('.dr-graph-input')?.value).toBe('shared/src/types.ts');
    expect(node(drawer.el, 'shared/src/types.ts')?.getAttribute('class')).toContain('dr-g-role-center');
    node(drawer.el, CENTER)?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }),
    );
    await settle();
    expect(node(drawer.el, CENTER)?.getAttribute('class')).toContain('dr-g-role-center');
    node(drawer.el, 'shared/src/types.ts')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }),
    );
    await settle();
    buttonNamed(drawer.el, 'Centre here')?.click();
    await settle();
    expect(node(drawer.el, 'shared/src/types.ts')?.getAttribute('class')).toContain('dr-g-role-center');
    drawer.destroy();
  });

  it('redraws only when the running write scopes change', async () => {
    const { ctx, drawer } = setup();
    await settle();
    const before = node(drawer.el, 'backend/src/checkout.ts');
    const same = ctx.store.select('board');
    if (same) ctx.board({ ...same, tasks: same.tasks.map((t) => ({ ...t })) });
    expect(node(drawer.el, 'backend/src/checkout.ts')).toBe(before);
    ctx.board(
      makeSnapshot({
        tasks: [makeTask({ task_id: RUNNING, status: 'RUNNING', scope: { write: ['frontend/**'], read: [] } })],
      }),
    );
    expect(node(drawer.el, 'backend/src/checkout.ts')).not.toBe(before);
    expect(node(drawer.el, 'backend/src/checkout.ts')?.getAttribute('class')).toContain('dr-g-tone-plain');
    expect(node(drawer.el, HOSTILE)?.getAttribute('class')).toContain('dr-g-tone-scope');
    drawer.destroy();
  });

  it('centres on a typed path and reports one the graph does not know', async () => {
    const { drawer } = setup(null);
    await settle();
    expect(drawer.el.textContent).toContain('Shared contracts');
    const input = drawer.el.querySelector<HTMLInputElement>('.dr-graph-input') as HTMLInputElement;
    input.value = 'missing.ts';
    drawer.el.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(drawer.el.querySelector('.dr-error')?.textContent).toContain('missing.ts is not in the code graph');
    buttonNamed(drawer.el, 'Show')?.click();
    input.value = `.\\shared\\src\\api.ts`;
    drawer.el.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await settle();
    expect(node(drawer.el, CENTER)).toBeDefined();
    drawer.destroy();
  });

  it('starts from a shared contract when opened without a path', async () => {
    const { drawer } = setup(null);
    await settle();
    buttonNamed(drawer.el, CENTER)?.click();
    await settle();
    expect(node(drawer.el, CENTER)?.getAttribute('class')).toContain('dr-g-role-center');
    drawer.destroy();
  });

  it('marks the graph as indexing while a reindex runs, then reads it again', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const { ctx, drawer } = setup(CENTER, {
      'POST /graph/reindex': () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    await settle();
    const before = ctx.transport.to('GET', '/graph/query').length;
    const reindex = buttonNamed(drawer.el, 'Reindex') as HTMLButtonElement;
    reindex.click();
    expect(ctx.store.select('ui').indexing).toBe(true);
    await settle();
    expect(reindex.disabled).toBe(true);
    reindex.click();
    expect(ctx.transport.to('POST', '/graph/reindex')).toHaveLength(1);
    finish({ version: 'v2', stats: {}, contracts: [] });
    await settle();
    expect(ctx.store.select('ui').indexing).toBe(false);
    expect(reindex.disabled).toBe(false);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'success', text: 'The code graph was rebuilt' });
    expect(ctx.transport.to('GET', '/graph/query').length).toBeGreaterThan(before);
    drawer.destroy();
  });

  it('turns indexing off when a reindex fails, even after the drawer closed', async () => {
    let fail: (e: unknown) => void = () => undefined;
    const { ctx, drawer } = setup(CENTER, {
      'POST /graph/reindex': () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    });
    await settle();
    buttonNamed(drawer.el, 'Reindex')?.click();
    expect(ctx.store.select('ui').indexing).toBe(true);
    drawer.destroy();
    fail(new Error('graph build failed'));
    await settle();
    expect(ctx.store.select('ui').indexing).toBe(false);
    expect(ctx.toasts.at(-1)).toMatchObject({ kind: 'error', detail: 'graph build failed' });
  });
});
