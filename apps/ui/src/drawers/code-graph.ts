/**
 * The code graph drawer (plan §7.4, handoff Part 05 §4, ERRATA F28, F39): the main checkout's
 * import graph (TS/JS files only), the 2-hop neighbourhood of one file laid out in layers around it
 * (graph-layout.ts), drawn as SVG. A click selects a file and shows its panel (what it imports, who
 * imports it, its tests, Open in VS Code); a double-click — or "Centre here" — recentres on it.
 * "Reindex" rebuilds the graph while the mascot searches (`ui.indexing`).
 */
import type { GraphQuery } from '../api/client.js';
import { visible } from '../model/text.js';
import type { AppContext, Component, DrawerRequest } from '../shell/context.js';
import { openDrawer } from '../shell/context.js';
import { button, type Child, h, replace } from '../ui/dom.js';
import { basename, cleanText, plural, truncate } from '../ui/format.js';
import { icon, s } from '../ui/svg.js';
import { badge, empty, errorNote, joinPath, loading, mono, statusPill } from './common.js';
import { matchesAny, normalizePath } from './glob.js';
import {
  classify,
  edgePath,
  type GraphLayout,
  type LaidNode,
  layoutNeighbourhood,
  NODE_H,
  NODE_W,
} from './graph-layout.js';

const PANEL_LIST = 30;
let graphSeq = 0;

/** A query answer with every list present (an older or partial answer may leave one out). */
export function graphOf(q: Partial<GraphQuery> | null | undefined): GraphQuery {
  return {
    version: q?.version ?? '',
    node: q?.node ?? null,
    dependencies: (q?.dependencies ?? []).filter((d) => typeof d?.to === 'string'),
    consumers: (q?.consumers ?? []).filter((c) => typeof c?.from === 'string'),
    tests: (q?.tests ?? []).filter((t) => typeof t === 'string'),
    neighbourhood: (q?.neighbourhood ?? []).filter((n) => typeof n?.path === 'string'),
  };
}

/** Write scopes of the running tasks, with the task each belongs to. */
export function runningScopes(
  tasks: readonly { task_id: string; status: string; summary: string; scope: { write: string[] } | null }[],
): { glob: string; taskId: string; summary: string }[] {
  return tasks
    .filter((t) => t.status === 'RUNNING')
    .flatMap((t) => (t.scope?.write ?? []).map((glob) => ({ glob, taskId: t.task_id, summary: t.summary })));
}

export function createCodeGraph(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const markerId = `dr-graph-arrow-${++graphSeq}`;
  let destroyed = false;
  let center: string | null = request.path ? normalizePath(request.path) : null;
  let query: GraphQuery | null = null;
  let layout: GraphLayout | null = null;
  let selected: string | null = null;
  let contracts = new Set<string>();
  let contractsLoaded = false;
  let token = 0;
  const details = new Map<string, GraphQuery>();
  const unsubscribe: (() => void)[] = [];

  const input = h('input', {
    class: 'input mono dr-graph-input',
    type: 'text',
    value: center ?? '',
    placeholder: 'src/path/to/file.ts',
    autocomplete: 'off',
    spellcheck: false,
    aria: { label: 'File to centre the graph on' },
  });
  const reindexButton = button([icon('rework', 14), 'Reindex'], () => void reindex(), {
    class: 'btn',
    title: 'Rebuild the code graph of the main checkout',
  });
  const form = h(
    'form',
    {
      class: 'dr-graph-form row',
      role: 'search',
      on: {
        submit: (e: SubmitEvent) => {
          e.preventDefault();
          const p = normalizePath(input.value.trim());
          if (p) void centreOn(p);
        },
      },
    },
    input,
    h('button', { type: 'submit', class: 'btn btn-primary' }, 'Show'),
    reindexButton,
  );
  const status = h('div', { class: 'dr-graph-status muted', role: 'status', aria: { live: 'polite' } });
  const canvas = h('div', { class: 'dr-graph-canvas scroll' });
  const panel = h('aside', { class: 'dr-graph-panel', aria: { label: 'Selected file' } });
  const legend = h(
    'ul',
    { class: 'dr-legend', aria: { label: 'Colours' } },
    h('li', null, h('span', { class: 'dr-swatch dr-g-tone-scope' }), 'In the write scope of a running task'),
    h('li', null, h('span', { class: 'dr-swatch dr-g-tone-contract' }), 'Shared contract'),
    h('li', null, h('span', { class: 'dr-swatch dr-g-tone-test' }), 'Test'),
  );
  const el = h(
    'div',
    { class: 'dr-graph' },
    h(
      'p',
      { class: 'dr-note' },
      icon('graph', 14),
      " This is the main checkout's code graph (TS/JS files). Changes still in task worktrees are not in it.",
    ),
    form,
    legend,
    status,
    canvas,
    panel,
  );

  function scopes(): { glob: string; taskId: string; summary: string }[] {
    return runningScopes(ctx.store.select('board')?.tasks ?? []);
  }

  function relayout(): void {
    if (!query) return;
    layout = layoutNeighbourhood(query, { scopes: scopes().map((x) => x.glob), contracts });
    draw();
  }

  function draw(): void {
    if (!layout || !query) return;
    const svg = s('svg', {
      class: 'dr-graph-svg',
      viewBox: `0 0 ${layout.width} ${layout.height}`,
      width: layout.width,
      height: layout.height,
      role: 'group',
      'aria-label': `Code graph around ${visible(center ?? '')}`,
    });
    svg.append(
      s(
        'defs',
        {},
        s(
          'marker',
          {
            id: markerId,
            viewBox: '0 0 10 10',
            refX: 9,
            refY: 5,
            markerWidth: 7,
            markerHeight: 7,
            orient: 'auto-start-reverse',
          },
          s('path', { d: 'M0 0L10 5L0 10z', class: 'dr-g-arrow' }),
        ),
      ),
    );
    for (const c of layout.columns) {
      svg.append(s('text', { x: c.x, y: 24, class: 'dr-g-heading' }, c.label));
    }
    const byPath = new Map(layout.nodes.map((n) => [n.path, n]));
    for (const e of layout.edges) {
      const from = byPath.get(e.from);
      const to = byPath.get(e.to);
      if (!from || !to) continue;
      svg.append(
        s(
          'path',
          {
            d: edgePath(from, to),
            class: `dr-g-edge dr-g-edge-${e.kind === 'test' ? 'test' : 'import'}`,
            'marker-end': `url(#${markerId})`,
          },
          s('title', {}, `${visible(e.from)} imports ${visible(e.to)}`),
        ),
      );
    }
    for (const node of layout.nodes) svg.append(nodeView(node));
    for (const [layer, n] of Object.entries(layout.hidden)) {
      if (!n) continue;
      const col = layout.columns.find((c) => String(c.layer) === layer);
      if (col) svg.append(s('text', { x: col.x, y: layout.height - 12, class: 'dr-g-more' }, `+${n} more`));
    }
    replace(canvas, svg);
  }

  function nodeView(node: LaidNode): SVGGElement {
    const label = truncate(visible(basename(node.path)), 24);
    const roleText: Record<LaidNode['role'], string> = {
      center: 'the file shown',
      consumer: 'imports it',
      dependency: 'imported by it',
      test: 'a test of it',
      far: 'two steps away',
    };
    const g = s(
      'g',
      {
        class: [
          'dr-g-node',
          `dr-g-tone-${node.tone}`,
          `dr-g-role-${node.role}`,
          node.inScope ? 'dr-g-inscope' : '',
          node.path === selected ? 'dr-g-selected' : '',
        ]
          .filter(Boolean)
          .join(' '),
        transform: `translate(${node.x} ${node.y})`,
        tabindex: 0,
        role: 'button',
        'aria-label': `${visible(node.path)}: ${roleText[node.role]}`,
        'aria-pressed': String(node.path === selected),
        'data-path': node.path,
      },
      s('title', {}, visible(node.path)),
      s('rect', { width: NODE_W, height: NODE_H, rx: 6, ry: 6, class: 'dr-g-box' }),
      s('text', { x: 10, y: NODE_H / 2 + 4, class: 'dr-g-label' }, label),
    );
    g.addEventListener('click', () => select(node.path));
    g.addEventListener('dblclick', () => void centreOn(node.path));
    g.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (e.key === 'Enter' && e.shiftKey) void centreOn(node.path);
        else select(node.path);
      }
    });
    return g;
  }

  function pathList(title: string, paths: string[]): HTMLElement {
    const shown = paths.slice(0, PANEL_LIST);
    return h(
      'div',
      { class: 'dr-graph-list' },
      h('h4', { class: 'section-title' }, `${title} (${paths.length})`),
      paths.length
        ? h(
            'ul',
            null,
            shown.map((p) =>
              h(
                'li',
                null,
                button(visible(p), () => void centreOn(p), {
                  class: 'dr-link dr-mono',
                  title: `Centre on ${visible(p)}`,
                }),
              ),
            ),
            paths.length > shown.length ? h('li', { class: 'muted' }, `+${paths.length - shown.length} more`) : null,
          )
        : h('div', { class: 'muted' }, 'None.'),
    );
  }

  async function detailsOf(path: string): Promise<GraphQuery | null> {
    if (path === center && query) return query;
    const cached = details.get(path);
    if (cached) return cached;
    try {
      const q = graphOf(await ctx.api.graphQuery(path, 1));
      details.set(path, q);
      return q;
    } catch {
      return null;
    }
  }

  async function renderPanel(): Promise<void> {
    const path = selected;
    if (!path) {
      replace(panel);
      return;
    }
    replace(panel, loading('Reading the file’s links…'));
    const q = await detailsOf(path);
    if (destroyed || path !== selected) return;
    const owners = scopes().filter((x) => matchesAny(path, [x.glob]));
    const look = classify(
      path,
      { scopes: owners.map((o) => o.glob), contracts },
      { contract: Boolean(q?.node?.contract) },
    );
    const root = ctx.store.select('board')?.project.root ?? '';
    const board = ctx.store.select('board');
    const contract = q?.node?.contract as { areas?: string[] } | undefined;
    const kids: Child[] = [
      h('div', { class: 'dr-graph-panel-title' }, mono(path)),
      h(
        'div',
        { class: 'row-wrap' },
        look.contract
          ? badge(
              contract?.areas?.length
                ? `Shared contract · used by ${contract.areas.map((a) => cleanText(a)).join(', ')}`
                : 'Shared contract',
              'strong',
            )
          : null,
        look.test ? badge('Test', 'good') : null,
        q?.node?.area ? badge(`area ${cleanText(String(q.node.area))}`, 'muted') : null,
      ),
      owners.length
        ? h(
            'div',
            { class: 'dr-graph-owners' },
            h('span', { class: 'muted' }, 'In the write scope of: '),
            h(
              'ul',
              null,
              owners.map((o) => {
                const t = board?.tasks.find((x) => x.task_id === o.taskId);
                return h(
                  'li',
                  null,
                  button(
                    [t ? statusPill(t.status) : null, truncate(cleanText(o.summary), 80), ' ', mono(o.glob)],
                    () => openDrawer(ctx, { kind: 'inspector', id: o.taskId }),
                    { class: 'dr-link' },
                  ),
                );
              }),
            ),
          )
        : null,
      h(
        'div',
        { class: 'row-wrap dr-graph-actions' },
        path !== center
          ? button([icon('target', 14), 'Centre here'], () => void centreOn(path), { class: 'btn' })
          : null,
        button([icon('expand', 14), 'Open in VS Code'], () => ctx.platform.openInEditor(joinPath(root, path)), {
          class: 'btn btn-ghost',
        }),
      ),
    ];
    if (q) {
      kids.push(
        pathList(
          'Imports',
          q.dependencies.map((d) => d.to).filter((p): p is string => typeof p === 'string' && p.length > 0),
        ),
        pathList(
          'Imported by',
          q.consumers.map((c) => c.from),
        ),
        pathList('Tests', q.tests),
      );
    } else kids.push(h('div', { class: 'muted' }, 'Friday could not read this file’s links.'));
    replace(panel, kids);
  }

  function select(path: string): void {
    selected = path;
    for (const g of canvas.querySelectorAll<SVGGElement>('.dr-g-node')) {
      const on = g.getAttribute('data-path') === path;
      g.classList.toggle('dr-g-selected', on);
      g.setAttribute('aria-pressed', String(on));
    }
    void renderPanel();
  }

  async function centreOn(path: string): Promise<void> {
    const p = normalizePath(path);
    center = p;
    input.value = p;
    selected = p;
    const mine = ++token;
    replace(status, 'Reading the code graph… (it is rebuilt when the main checkout changed)');
    replace(canvas, loading('Reading the code graph…'));
    try {
      const answer = graphOf(await ctx.api.graphQuery(p, 2));
      if (destroyed || mine !== token) return;
      const q = answer.node ? answer : { ...answer, node: { path: p } };
      query = q;
      details.set(p, q);
      replace(
        status,
        `${plural(q.dependencies.length, 'import')}, imported by ${plural(q.consumers.length, 'file')}, ${plural(q.tests.length, 'test')}, ${plural(q.neighbourhood.length, 'file')} within two steps`,
      );
      relayout();
      void renderPanel();
      if (!contractsLoaded) void loadContracts();
    } catch (e) {
      if (destroyed || mine !== token) return;
      query = null;
      layout = null;
      replace(status);
      replace(canvas, errorNote('Could not read the code graph', e));
      replace(panel);
    }
  }

  async function loadContracts(): Promise<void> {
    contractsLoaded = true;
    try {
      const g = await ctx.api.graph();
      if (destroyed) return;
      contracts = new Set((g.contracts ?? []).map((c) => normalizePath(c.path)));
      relayout();
      if (!center) renderSuggestions(g.contracts ?? []);
    } catch {
      contractsLoaded = false;
    }
  }

  function renderSuggestions(list: { path: string; consumers: string[] }[]): void {
    if (center) return;
    replace(
      canvas,
      list.length
        ? h(
            'div',
            { class: 'dr-graph-suggest' },
            h('h4', { class: 'section-title' }, 'Shared contracts'),
            h(
              'ul',
              { class: 'row-wrap' },
              list.slice(0, 40).map((c) =>
                h(
                  'li',
                  null,
                  button(visible(c.path), () => void centreOn(c.path), { class: 'pill dr-link dr-mono' }),
                ),
              ),
            ),
          )
        : empty('Type a file path above, or open the graph from a file in the inspector’s Context tab.'),
    );
  }

  async function reindex(): Promise<void> {
    if (ctx.store.select('ui').indexing) return;
    ctx.store.patch('ui', { indexing: true });
    try {
      const r = await ctx.act('Reindex the code graph', () => ctx.api.graphReindex(), 'The code graph was rebuilt');
      if (r !== undefined && !destroyed) {
        details.clear();
        contractsLoaded = false;
        if (center) void centreOn(center);
        else void loadContracts();
      }
    } finally {
      ctx.store.patch('ui', { indexing: false });
    }
  }

  unsubscribe.push(
    ctx.store.subscribe('ui', (ui, prev) => {
      if (ui.indexing !== prev.indexing) {
        reindexButton.disabled = ui.indexing;
        reindexButton.setAttribute('aria-busy', String(ui.indexing));
      }
    }),
  );
  // Redraw only when the running write scopes change: a redraw would move the keyboard focus.
  let lastScopes = JSON.stringify(scopes());
  unsubscribe.push(
    ctx.store.subscribe('board', () => {
      const next = JSON.stringify(scopes());
      if (next === lastScopes) return;
      lastScopes = next;
      relayout();
    }),
  );
  reindexButton.disabled = ctx.store.select('ui').indexing;

  if (center) void centreOn(center);
  else {
    replace(canvas, empty('Type a file path above, or open the graph from a file in the inspector’s Context tab.'));
    void loadContracts();
  }

  return {
    el,
    title: 'Code graph',
    destroy() {
      destroyed = true;
      token++;
      for (const u of unsubscribe) u();
      el.remove();
    },
  };
}
