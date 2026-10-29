/**
 * The agents drawer (plan §7.7): the installed hosts, the agents Friday started (processes and
 * remembered profiles, read again every 3 s while the drawer is open) with Stop, Start again and
 * Forget, the agents connected now (with their enforcement level, model and shadow state), the
 * "Claude Code in VS Code" card, and the routing pins that steer which model a task gets.
 */
import type {
  AgentHost,
  AgentProcess,
  AgentProcessesView,
  AgentProfile,
  HarnessEntry,
  RoutingPinView,
} from '@friday/protocol';
import { enforcementBadge, TASK_KIND } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, type Component, type DrawerRequest, openModal } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { humanize, timeAgo, truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import {
  actWithError,
  badge,
  errorOf,
  field,
  input,
  note,
  panel,
  pathText,
  plain,
  select,
  Teardown,
} from './common.js';

export const PROCESS_POLL_MS = 3000;

/** One agent Friday started or remembers: its process (if any) and its profile (if any). */
export interface AgentRow {
  agent_key: string;
  host: string;
  role: string;
  process: AgentProcess | null;
  profile: AgentProfile | null;
}

/** Joins processes and profiles by agent key, sorted by key. */
export function agentRows(view: Partial<AgentProcessesView> | null | undefined): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  for (const p of view?.profiles ?? []) {
    rows.set(p.agent_key, { agent_key: p.agent_key, host: p.host, role: p.role, process: null, profile: p });
  }
  for (const p of view?.processes ?? []) {
    const row = rows.get(p.agent_key);
    if (row) row.process = p;
    else rows.set(p.agent_key, { agent_key: p.agent_key, host: p.host, role: p.role, process: p, profile: null });
  }
  return [...rows.values()].sort((a, b) => a.agent_key.localeCompare(b.agent_key));
}

export function isLive(p: AgentProcess | null): boolean {
  return !!p && (p.status === 'starting' || p.status === 'running' || p.status === 'stopping');
}

/** The status badge of a row. */
export function rowStatus(row: AgentRow): { label: string; tone: 'good' | 'info' | 'warn' | 'danger' | 'muted' } {
  const p = row.process;
  if (!p) return { label: 'not running', tone: 'muted' };
  if (p.status === 'running') return { label: 'running', tone: 'good' };
  if (p.status === 'starting') return { label: 'starting', tone: 'info' };
  if (p.status === 'stopping') return { label: 'stopping', tone: 'warn' };
  return p.exit_code === 0 || p.exit_code === null
    ? { label: 'exited', tone: 'muted' }
    : { label: `exited (code ${p.exit_code})`, tone: 'danger' };
}

function optionsText(o: Record<string, unknown> | undefined): string {
  if (!o) return '';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(o))
    if (v !== undefined && v !== null && v !== '') parts.push(`${k.replaceAll('_', ' ')} ${String(v)}`);
  return parts.join(' · ');
}

const HOST_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

/** The "Claude Code in VS Code" status from the connected harnesses (plan §7.7). */
export function claudeCodeStatus(harnesses: readonly HarnessEntry[]): {
  connected: boolean;
  hooksSeen: boolean;
  harness: HarnessEntry | null;
} {
  const attached = harnesses.filter(
    (x) => x.vendor === 'claude-code' && x.attach_mode === 'attach' && x.status !== 'TERMINATED',
  );
  const harness = attached.find((x) => x.status !== 'DISCONNECTED') ?? attached[0] ?? null;
  const status = harness?.enforcement_status ?? null;
  return {
    connected: !!harness && harness.status !== 'DISCONNECTED',
    hooksSeen: status === 'enforcing' || status === 'degraded' || status === 'unverified',
    harness,
  };
}

interface RowView {
  el: HTMLElement;
  update(row: AgentRow): void;
}

export function agentsDrawer(ctx: AppContext, request: DrawerRequest): Component & { title: string } {
  const td = new Teardown();
  let polling = false;
  const rowViews = new Map<string, RowView>();

  // ---- installed hosts
  const hostsBox = h('div', { class: 'pn-hosts' }, h('div', { class: 'muted' }, 'Checking which hosts are installed…'));
  const refreshHosts = button([icon('rework', 14), 'Check again'], () => void loadHosts(true), {
    class: 'btn btn-ghost',
  });

  function renderHosts(hosts: AgentHost[]) {
    replace(
      hostsBox,
      hosts.length === 0 ? h('div', { class: 'muted' }, 'Friday reported no hosts.') : null,
      h(
        'ul',
        { class: 'pn-list' },
        hosts.map((x) =>
          h(
            'li',
            { class: 'pn-item pn-host' },
            h('span', { class: 'pn-host-name' }, HOST_LABEL[x.host] ?? plain(x.host, 40)),
            x.found
              ? badge(x.supported ? 'found' : 'unsupported', x.supported ? 'good' : 'warn')
              : badge('not found', 'muted'),
            x.version ? h('span', { class: 'muted' }, plain(x.version, 60)) : null,
            x.path ? pathText(x.path, 'pn-grow') : null,
            x.reason ? h('div', { class: 'muted pn-host-reason' }, plain(x.reason, 400)) : null,
          ),
        ),
      ),
    );
  }

  async function loadHosts(refresh = false) {
    refreshHosts.disabled = true;
    try {
      const r = await ctx.api.agentHosts(refresh);
      if (td.done) return;
      renderHosts(Array.isArray(r?.hosts) ? r.hosts : []);
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        hostsBox,
        h(
          'div',
          { class: 'field-error' },
          `Could not check the hosts: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
    } finally {
      if (!td.done) refreshHosts.disabled = false;
    }
  }

  // ---- processes and profiles
  const processesList = h('ul', { class: 'pn-list pn-agents' });
  const processesState = h('div', { class: 'muted' }, 'Reading the agents Friday started…');

  function rowView(initial: AgentRow): RowView {
    let row = initial;
    const keyEl = h('span', { class: 'mono pn-agent-key' }, visible(row.agent_key));
    const statusEl = h('span', { class: 'badge' });
    const meta = h('div', { class: 'pn-agent-meta muted' });
    const opts = h('div', { class: 'pn-agent-meta muted' });
    const error = h('div', { class: 'field-error', hidden: true, role: 'alert' });
    const log = h('pre', { class: 'pn-log' });
    const output = h('details', { class: 'pn-output' }, h('summary', null, 'Output'), log);
    const stop = button([icon('stop', 14), 'Stop'], () => void act('stop'), { class: 'btn' });
    const again = button([icon('play', 14), 'Start again'], () => void act('start'), { class: 'btn' });
    const forget = button([icon('close', 14), 'Forget'], () => void act('forget'), { class: 'btn btn-ghost' });
    const el = h(
      'li',
      { class: 'pn-item pn-agent-row' },
      h('div', { class: 'row' }, keyEl, statusEl, h('span', { class: 'spacer' }), stop, again, forget),
      meta,
      opts,
      error,
      output,
    );

    function showError(message: string | null) {
      error.hidden = !message;
      error.textContent = message ?? '';
    }

    async function act(what: 'stop' | 'start' | 'forget') {
      const k = row.agent_key;
      showError(null);
      if (what === 'forget') {
        const ok = await ctx.confirm({
          title: `Forget ${visible(k)}?`,
          body: [
            'Friday stops this agent if it runs and no longer starts it.',
            'Its tasks and their work stay as they are.',
          ],
          confirmLabel: 'Forget the agent',
          danger: true,
        });
        if (!ok) return;
      }
      const label =
        what === 'stop' ? 'Stop the agent' : what === 'start' ? 'Start the agent again' : 'Forget the agent';
      const call =
        what === 'stop'
          ? () => ctx.api.stopAgent(k)
          : what === 'start'
            ? () => ctx.api.startAgent(k)
            : () => ctx.api.forgetAgent(k);
      const r = await actWithError<unknown>(
        ctx,
        label,
        call,
        // A 409 names who holds the key: shown as the daemon wrote it.
        (e) =>
          showError(
            e.status === 409 ? plain(e.message, 1000) : `${e.code ? `${e.code}: ` : ''}${plain(e.message, 1000)}`,
          ),
        what === 'stop'
          ? `Stopping ${visible(k)}`
          : what === 'start'
            ? `Starting ${visible(k)}`
            : `Forgot ${visible(k)}`,
      );
      if (td.done) return;
      if (r !== undefined) {
        ctx.refresh();
        void loadProcesses();
      }
    }

    function update(next: AgentRow) {
      row = next;
      const st = rowStatus(row);
      statusEl.className = `badge badge-${st.tone}`;
      statusEl.textContent = st.label;
      const p = row.process;
      const parts = [
        HOST_LABEL[row.host] ?? row.host,
        `role ${row.role}`,
        p?.pid ? `pid ${p.pid}` : '',
        p?.started_at ? `started ${timeAgo(p.started_at, ctx.now())}` : '',
        p?.ended_at ? `ended ${timeAgo(p.ended_at, ctx.now())}` : '',
        p && p.exit_code !== null ? `exit code ${p.exit_code}` : '',
        row.profile ? (row.profile.autostart ? 'starts with Friday' : 'started by hand') : 'not remembered',
        p?.shadow ? 'shadow: another session holds this key' : '',
      ].filter(Boolean);
      meta.textContent = plain(parts.join(' · '), 400);
      opts.textContent = plain(
        optionsText((p?.options ?? row.profile?.options) as Record<string, unknown> | undefined),
        300,
      );
      opts.hidden = !opts.textContent;
      const live = isLive(p);
      stop.hidden = !live;
      stop.disabled = p?.status === 'stopping';
      again.hidden = live || !row.profile;
      forget.hidden = !row.profile;
      const lines = p?.log_tail ?? [];
      output.hidden = lines.length === 0;
      const textOut = lines.map((l) => plain(l, 2000)).join('\n');
      if (log.textContent !== textOut) log.textContent = textOut;
    }

    update(row);
    return { el, update };
  }

  function renderProcesses(view: AgentProcessesView) {
    const rows = agentRows(view);
    processesState.hidden = rows.length > 0;
    processesState.textContent = rows.length ? '' : 'No agent was started from here yet.';
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.agent_key);
      const existing = rowViews.get(row.agent_key);
      if (existing) existing.update(row);
      else rowViews.set(row.agent_key, rowView(row));
    }
    for (const [k, v] of rowViews) {
      if (!seen.has(k)) {
        v.el.remove();
        rowViews.delete(k);
      }
    }
    // Keep the order without re-creating rows (focus stays where it is).
    rows.forEach((row, i) => {
      const v = rowViews.get(row.agent_key) as RowView;
      if (processesList.children[i] !== v.el) processesList.insertBefore(v.el, processesList.children[i] ?? null);
    });
  }

  async function loadProcesses() {
    if (polling) return;
    polling = true;
    try {
      const r = await ctx.api.agentProcesses();
      if (td.done) return;
      renderProcesses({
        processes: Array.isArray(r?.processes) ? r.processes : [],
        profiles: Array.isArray(r?.profiles) ? r.profiles : [],
      });
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      processesState.hidden = false;
      processesState.textContent = `Could not read the agents: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`;
    } finally {
      polling = false;
    }
  }

  // ---- connected harnesses (from the board)
  const harnessBox = h('div', { class: 'pn-harnesses' });
  function renderHarnesses() {
    const board = ctx.store.select('board');
    const harnesses = board?.harnesses ?? [];
    const agents = board?.agents ?? [];
    replace(
      harnessBox,
      harnesses.length === 0
        ? h(
            'div',
            { class: 'muted' },
            'No agent is connected. Start one above, or set up Claude Code in VS Code below.',
          )
        : h(
            'ul',
            { class: 'pn-list' },
            harnesses.map((x) => {
              const b = enforcementBadge(x.enforcement_level, x.enforcement_status);
              const agent = agents.find((a) => a.harness_id === x.harness_id);
              return h(
                'li',
                { class: 'pn-item pn-harness' },
                h('span', { class: 'pn-host-name' }, plain(x.name || x.vendor, 60)),
                h('span', { class: 'mono pn-agent-key' }, visible(agent?.agent_key ?? x.requested_agent_key ?? '—')),
                badge(b.label, b.tone),
                badge(x.attach_mode === 'attach' ? 'attached' : 'spawned', 'muted'),
                x.shadow ? badge('shadow', 'warn') : null,
                h('span', { class: 'muted' }, humanize(x.status)),
                h(
                  'span',
                  { class: 'muted pn-grow' },
                  x.observed_model ? `model ${plain(x.observed_model, 80)}` : 'model not reported',
                ),
                x.enforcement_basis
                  ? h('div', { class: 'muted pn-host-reason' }, plain(x.enforcement_basis, 300))
                  : null,
              );
            }),
          ),
    );
  }

  // ---- Claude Code in VS Code
  const claudeBox = h('div', { class: 'pn-claude' });
  function renderClaude() {
    const st = claudeCodeStatus(ctx.store.select('board')?.harnesses ?? []);
    const b = st.harness ? enforcementBadge(st.harness.enforcement_level, st.harness.enforcement_status) : null;
    replace(
      claudeBox,
      h(
        'dl',
        { class: 'pn-kv' },
        h('dt', null, 'Configured'),
        h('dd', null, st.harness ? 'yes: it connected' : 'not seen yet (Set up previews it)'),
        h('dt', null, 'MCP connected'),
        h('dd', null, st.connected ? 'yes' : 'no'),
        h('dt', null, 'Hooks seen'),
        h('dd', null, st.hooksSeen ? 'yes' : st.harness ? 'not yet: they show with its first tool call' : 'no'),
        h('dt', null, 'Enforcement'),
        h('dd', null, b ? badge(b.label, b.tone) : '—'),
      ),
      h(
        'div',
        { class: 'pn-actions pn-actions-start' },
        button([icon('gear', 14), 'Set up'], () => openModal(ctx, { kind: 'claude-setup' }), {
          class: 'btn btn-primary',
        }),
      ),
    );
  }

  // ---- routing pins
  const pinsList = h('div', { class: 'pn-pins' }, h('div', { class: 'muted' }, 'Reading the routing pins…'));
  let models: string[] = [];
  const pinForm = h('div', { class: 'pn-pin-form' });
  const pinState: { scope: 'role' | 'task' | 'kind'; target: string; model: string } = {
    scope: 'role',
    target: 'developer',
    model: '',
  };

  function renderPins(pins: RoutingPinView[]) {
    const live = pins.filter((p) => !p.revoked_at);
    replace(
      pinsList,
      live.length === 0
        ? h('div', { class: 'muted' }, 'No pins: Friday routes by evidence and the project’s settings.')
        : h(
            'ul',
            { class: 'pn-list' },
            live.map((p) =>
              h(
                'li',
                { class: 'pn-item' },
                badge(p.scope, 'info'),
                p.target ? h('span', { class: 'mono' }, visible(truncate(p.target, 80))) : null,
                h('span', { class: 'pn-grow' }, p.model ? `→ ${plain(p.model, 80)}` : p.mode ? `mode ${p.mode}` : ''),
                p.until ? h('span', { class: 'muted' }, `until ${timeAgo(p.until, ctx.now())}`) : null,
                p.note ? h('span', { class: 'muted' }, plain(p.note, 200)) : null,
                button('Unpin', () => void unpin(p), {
                  class: 'btn btn-ghost',
                  ariaLabel: `Unpin the ${p.scope} pin${p.target ? ` for ${visible(p.target)}` : ''}`,
                }),
              ),
            ),
          ),
    );
  }

  async function loadPins() {
    try {
      const r = await ctx.api.pins();
      if (td.done) return;
      renderPins(Array.isArray(r?.pins) ? r.pins : []);
    } catch (e) {
      if (td.done) return;
      const err = errorOf(e);
      replace(
        pinsList,
        h(
          'div',
          { class: 'field-error' },
          `Could not read the pins: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`,
        ),
      );
    }
  }

  async function unpin(p: RoutingPinView) {
    const r = await ctx.act('Unpin', () => ctx.api.unpin(p.pin_id), 'Unpinned');
    if (r && !td.done) void loadPins();
  }

  function renderPinForm() {
    const board = ctx.store.select('board');
    const scope = select<'role' | 'task' | 'kind'>(
      [
        { value: 'role', label: 'A role' },
        { value: 'task', label: 'A task' },
        { value: 'kind', label: 'A kind of task' },
      ],
      pinState.scope,
      (v) => {
        pinState.scope = v;
        pinState.target =
          v === 'role'
            ? 'developer'
            : v === 'kind'
              ? 'implementation'
              : (board?.tasks.find((t) => !['COMPLETED', 'CANCELLED'].includes(t.status))?.task_id ?? '');
        renderPinForm();
      },
    );
    let target: HTMLElement;
    if (pinState.scope === 'kind') {
      target = select(
        Object.keys(TASK_KIND).map((k) => ({ value: k, label: humanize(k) })),
        pinState.target,
        (v) => {
          pinState.target = v;
        },
      );
    } else if (pinState.scope === 'task') {
      const tasks = (board?.tasks ?? []).filter((t) => !['COMPLETED', 'CANCELLED', 'ABANDONED'].includes(t.status));
      target = select(
        tasks.length
          ? tasks.map((t) => ({ value: t.task_id, label: truncate(plain(t.summary, 80), 70) }))
          : [{ value: '', label: 'No open task', disabled: true }],
        pinState.target,
        (v) => {
          pinState.target = v;
        },
      );
    } else {
      const box = input({ class: 'input mono', value: pinState.target, maxLength: 32, placeholder: 'developer' });
      box.addEventListener('input', () => {
        pinState.target = box.value.trim();
      });
      target = box;
    }
    if (!pinState.model && models[0]) pinState.model = models[0];
    const model = select(
      models.length
        ? models.map((m) => ({ value: m, label: m }))
        : [{ value: '', label: 'No models known', disabled: true }],
      pinState.model,
      (v) => {
        pinState.model = v;
      },
    );
    const pinBtn = button([icon('plus', 14), 'Pin'], () => void addPin(), {
      class: 'btn',
      disabled: models.length === 0,
    });
    replace(
      pinForm,
      h('div', { class: 'pn-grid3' }, field('Pin for', scope).el, field('Which', target).el, field('Model', model).el),
      h('div', { class: 'pn-actions pn-actions-start' }, pinBtn),
    );
  }

  async function addPin() {
    if (!pinState.target || !pinState.model) {
      ctx.toast({ kind: 'warn', text: 'Choose what to pin and a model' });
      return;
    }
    const r = await ctx.act(
      'Pin a model',
      () => ctx.api.pin({ scope: pinState.scope, target: pinState.target, model: pinState.model }),
      `Pinned ${pinState.model}`,
    );
    if (r && !td.done) void loadPins();
  }

  async function loadModels() {
    try {
      const r = await ctx.api.models();
      if (td.done) return;
      models = (Array.isArray(r?.models) ? r.models : [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === 'string');
    } catch {
      models = [];
    }
    if (!td.done) renderPinForm();
  }

  // ---- the drawer
  const pinsSection = h(
    'section',
    { class: 'pn-section', id: 'pn-pins' },
    h('h3', { class: 'section-title' }, 'Routing pins'),
    note('A pin makes Friday route a role, a task or a kind of task to one model.'),
    pinsList,
    pinForm,
  );
  const claudeSection = h(
    'section',
    { class: 'pn-section pn-card' },
    h('h3', { class: 'section-title' }, 'Claude Code in VS Code'),
    note('Claude Code running in your editor joins Friday through its MCP server and hooks.'),
    claudeBox,
  );

  const el = panel(
    'pn-agents-drawer',
    h(
      'div',
      { class: 'pn-actions pn-actions-start' },
      button([icon('plus', 14), 'Start agent'], () => openModal(ctx, { kind: 'start-agent' }), {
        class: 'btn btn-primary',
      }),
    ),
    h(
      'section',
      { class: 'pn-section' },
      h(
        'div',
        { class: 'row' },
        h('h3', { class: 'section-title' }, 'Installed hosts'),
        h('span', { class: 'spacer' }),
        refreshHosts,
      ),
      hostsBox,
    ),
    h(
      'section',
      { class: 'pn-section' },
      h('h3', { class: 'section-title' }, 'Agents Friday started'),
      processesState,
      processesList,
    ),
    h('section', { class: 'pn-section' }, h('h3', { class: 'section-title' }, 'Connected now'), harnessBox),
    claudeSection,
    pinsSection,
  );

  renderHarnesses();
  renderClaude();
  renderPinForm();
  td.add(
    ctx.store.subscribe('board', () => {
      renderHarnesses();
      renderClaude();
    }),
  );
  void loadHosts();
  void loadProcesses();
  void loadPins();
  void loadModels();
  const timer = setInterval(() => void loadProcesses(), PROCESS_POLL_MS);
  td.add(() => clearInterval(timer));

  // `routing` (the Notch's routing badge) opens on the pins, where the routing mode is shown.
  if (request.tab === 'pins' || request.tab === 'routing' || request.tab === 'claude') {
    const target = request.tab === 'claude' ? claudeSection : pinsSection;
    queueMicrotask(() => {
      if (!td.done && typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
    });
  }

  return {
    title: 'Agents',
    el,
    destroy() {
      td.run();
      for (const v of rowViews.values()) v.el.remove();
      rowViews.clear();
      el.remove();
    },
  };
}
