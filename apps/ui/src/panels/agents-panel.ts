/**
 * The agents drawer (plan §7.7, review §4 "one click away"): Start agent; one list of agents, each
 * row saying whether Friday started it or it attached in VS Code, whether it is connected now, its
 * process state, enforcement and model, with Stop, Start again, Forget and Output as they apply
 * (processes and remembered profiles read again every 3 s while the drawer is open; the connected
 * sessions from the board); the "Claude Code in VS Code" card; and the installed hosts, shown only
 * while none is found (the Start dialog's Host field shows them otherwise). The routing pins live in
 * Settings → Routing: a request for them opens Settings there.
 */
import type {
  AgentHost,
  AgentProcess,
  AgentProcessesView,
  AgentProfile,
  HarnessEntry,
  UiSnapshot,
} from '@friday/protocol';
import { enforcementWords } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, type Component, type DrawerRequest, openDrawer, openModal } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { humanize, timeAgo } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import { actWithError, badge, errorOf, note, panel, pathText, plain, Teardown } from './common.js';

export const PROCESS_POLL_MS = 3000;

/**
 * One agent, from whatever Friday knows of it: a process it started, a profile it remembers, and
 * the session connected now (from the board). A session that holds a Friday-started key joins that
 * row; a session attached in VS Code with its own key is a row of its own.
 */
export interface AgentRow {
  /** The agent key, or `harness:<id>` for a session that named none. */
  id: string;
  /** Empty when the session named no key. */
  agent_key: string;
  host: string;
  role: string;
  process: AgentProcess | null;
  profile: AgentProfile | null;
  harness: HarnessEntry | null;
  /** Who started it: Friday (a process, a profile or a spawned session) or the person, in VS Code. */
  origin: 'friday' | 'attached';
}

export function isLive(p: AgentProcess | null): boolean {
  return !!p && (p.status === 'starting' || p.status === 'running' || p.status === 'stopping');
}

/** A session Friday can talk to now. */
export function isConnected(x: HarnessEntry | null | undefined): boolean {
  return !!x && x.status !== 'DISCONNECTED' && x.status !== 'TERMINATED';
}

/** Joins processes, profiles and the board's sessions by agent key, sorted by key. */
export function agentRows(
  view: Partial<AgentProcessesView> | null | undefined,
  board?: Pick<UiSnapshot, 'agents' | 'harnesses'> | null,
): AgentRow[] {
  const rows = new Map<string, AgentRow>();
  const fresh = (id: string, agent_key: string, host: string, role: string): AgentRow => ({
    id,
    agent_key,
    host,
    role,
    process: null,
    profile: null,
    harness: null,
    origin: 'friday',
  });
  for (const p of view?.profiles ?? []) {
    const row = fresh(p.agent_key, p.agent_key, p.host, p.role);
    row.profile = p;
    rows.set(p.agent_key, row);
  }
  for (const p of view?.processes ?? []) {
    const row = rows.get(p.agent_key) ?? fresh(p.agent_key, p.agent_key, p.host, p.role);
    row.process = p;
    rows.set(p.agent_key, row);
  }
  const agents = board?.agents ?? [];
  for (const x of board?.harnesses ?? []) {
    const agent = agents.find((a) => a.harness_id === x.harness_id);
    const key = agent?.agent_key ?? x.requested_agent_key ?? '';
    const id = key || `harness:${x.harness_id}`;
    const row = rows.get(id) ?? fresh(id, key, x.vendor, agent?.role ?? '');
    // Two sessions with one key (a shadow): the connected one speaks for the row.
    if (!row.harness || (isConnected(x) && !isConnected(row.harness))) row.harness = x;
    rows.set(id, row);
  }
  for (const row of rows.values()) {
    row.origin = row.harness?.attach_mode === 'attach' && !isLive(row.process) ? 'attached' : 'friday';
  }
  return [...rows.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** The process state of a row Friday started. */
export function rowStatus(row: Pick<AgentRow, 'process'>): {
  label: string;
  tone: 'good' | 'info' | 'warn' | 'danger' | 'muted';
} {
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
  /** The last answer of `GET agent-processes`; null until it arrives. */
  let view: AgentProcessesView | null = null;

  // The pins moved to Settings → Routing (review decision 2); an old door to them lands there.
  if (request.tab === 'pins' || request.tab === 'routing') openDrawer(ctx, { kind: 'settings', tab: 'routing' });

  // ---- installed hosts: shown only while no host is found (the Start dialog's Host field has them otherwise)
  const hostsBox = h('div', { class: 'pn-hosts' }, h('div', { class: 'muted' }, 'Checking which hosts are installed…'));
  const refreshHosts = button([icon('rework', 14), 'Check again'], () => void loadHosts(true), {
    class: 'btn btn-ghost',
  });
  const hostsSection = h(
    'section',
    { class: 'pn-section', id: 'pn-hosts', hidden: true },
    h(
      'div',
      { class: 'row' },
      h('h3', { class: 'section-title' }, 'Installed hosts'),
      h('span', { class: 'spacer' }),
      refreshHosts,
    ),
    note('Friday starts agents in a coding host installed on this machine; none was found.'),
    hostsBox,
  );

  function renderHosts(hosts: AgentHost[]) {
    hostsSection.hidden = hosts.some((x) => x.found);
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
      // Unknown is not found: the row stays, with what went wrong.
      hostsSection.hidden = false;
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

  // ---- the one list
  const list = h('ul', { class: 'pn-list pn-agents' });
  const listState = h('div', { class: 'muted' }, 'Reading the agents…');

  function rowView(initial: AgentRow): RowView {
    let row = initial;
    const keyEl = h('span', { class: 'mono pn-agent-key' });
    const originEl = h('span', { class: 'muted pn-agent-origin' });
    const connEl = h('span', { class: 'badge' });
    const statusEl = h('span', { class: 'badge' });
    const enfEl = h('span', { class: 'badge' });
    const shadowEl = badge('shadow', 'warn');
    const meta = h('div', { class: 'pn-agent-meta muted' });
    const opts = h('div', { class: 'pn-agent-meta muted' });
    const basis = h('div', { class: 'muted pn-host-reason' });
    const error = h('div', { class: 'field-error', hidden: true, role: 'alert' });
    const log = h('pre', { class: 'pn-log' });
    const output = h('details', { class: 'pn-output' }, h('summary', null, 'Output'), log);
    const stop = button([icon('stop', 14), 'Stop'], () => void act('stop'), { class: 'btn' });
    const again = button([icon('play', 14), 'Start again'], () => void act('start'), { class: 'btn' });
    const forget = button([icon('close', 14), 'Forget'], () => void act('forget'), { class: 'btn btn-ghost' });
    const el = h(
      'li',
      { class: 'pn-item pn-agent-row' },
      h(
        'div',
        { class: 'row' },
        keyEl,
        originEl,
        connEl,
        statusEl,
        enfEl,
        shadowEl,
        h('span', { class: 'spacer' }),
        stop,
        again,
        forget,
      ),
      meta,
      opts,
      basis,
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
      const p = row.process;
      const x = row.harness;
      const fridayRow = !!p || !!row.profile;
      keyEl.textContent = visible(row.agent_key || '—');
      originEl.textContent = row.origin === 'attached' ? 'attached in VS Code' : 'started by Friday';
      const connected = isConnected(x);
      connEl.className = `badge badge-${connected ? 'good' : 'muted'}`;
      connEl.textContent = connected ? 'connected' : 'not connected';
      // The process state belongs to what Friday started; a session attached in VS Code has none.
      const st = rowStatus(row);
      statusEl.hidden = !fridayRow;
      statusEl.className = `badge badge-${st.tone}`;
      statusEl.textContent = st.label;
      // The pod's words (Enforced, Reported, Watched, Unverified), the level in the tooltip: one
      // vocabulary on the canvas and in this drawer.
      const enf = x ? enforcementWords(x.enforcement_level, x.enforcement_status, x.enforcement_basis) : null;
      enfEl.hidden = !enf;
      enfEl.className = `badge badge-${enf?.tone ?? 'muted'}`;
      enfEl.textContent = enf?.label ?? '';
      enfEl.title = enf?.title ?? '';
      shadowEl.hidden = !(p?.shadow || x?.shadow);
      const parts = [
        HOST_LABEL[row.host] ?? plain(row.host, 40),
        x?.name && x.name !== (HOST_LABEL[row.host] ?? row.host) ? plain(x.name, 60) : '',
        x?.version ? plain(x.version, 40) : '',
        row.role ? `role ${plain(row.role, 32)}` : '',
        x ? (x.observed_model ? `model ${plain(x.observed_model, 80)}` : 'model not reported') : '',
        x && connected ? humanize(x.status).toLowerCase() : '',
        p?.pid ? `pid ${p.pid}` : '',
        p?.started_at ? `started ${timeAgo(p.started_at, ctx.now())}` : '',
        p?.ended_at ? `ended ${timeAgo(p.ended_at, ctx.now())}` : '',
        p && p.exit_code !== null ? `exit code ${p.exit_code}` : '',
        fridayRow
          ? row.profile
            ? row.profile.autostart
              ? 'starts with Friday'
              : 'started by hand'
            : 'not remembered'
          : '',
        p?.shadow || x?.shadow ? 'shadow: another session holds this key' : '',
      ].filter(Boolean);
      meta.textContent = plain(parts.join(' · '), 600);
      opts.textContent = plain(
        optionsText((p?.options ?? row.profile?.options) as Record<string, unknown> | undefined),
        300,
      );
      opts.hidden = !opts.textContent;
      basis.textContent = x?.enforcement_basis ? plain(x.enforcement_basis, 300) : '';
      basis.hidden = !basis.textContent;
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

  function renderRows() {
    const rows = agentRows(view, ctx.store.select('board'));
    if (rows.length > 0 || view) {
      listState.hidden = rows.length > 0;
      listState.textContent = rows.length
        ? ''
        : 'No agent yet. Start one above, or set up Claude Code in VS Code below.';
    }
    const seen = new Set<string>();
    for (const row of rows) {
      seen.add(row.id);
      const existing = rowViews.get(row.id);
      if (existing) existing.update(row);
      else rowViews.set(row.id, rowView(row));
    }
    for (const [k, v] of rowViews) {
      if (!seen.has(k)) {
        v.el.remove();
        rowViews.delete(k);
      }
    }
    // Keep the order without re-creating rows (focus stays where it is).
    rows.forEach((row, i) => {
      const v = rowViews.get(row.id) as RowView;
      if (list.children[i] !== v.el) list.insertBefore(v.el, list.children[i] ?? null);
    });
  }

  async function loadProcesses() {
    if (polling) return;
    polling = true;
    try {
      const r = await ctx.api.agentProcesses();
      if (td.done) return;
      view = {
        processes: Array.isArray(r?.processes) ? r.processes : [],
        profiles: Array.isArray(r?.profiles) ? r.profiles : [],
      };
      renderRows();
    } catch (e) {
      if (td.done) return;
      // The sessions from the board still show; the error says what Friday could not read.
      const err = errorOf(e);
      renderRows();
      listState.hidden = false;
      listState.textContent = `Could not read the agents Friday started: ${err.code ? `${err.code} ` : ''}${plain(err.message, 300)}`;
    } finally {
      polling = false;
    }
  }

  // ---- Claude Code in VS Code
  const claudeBox = h('div', { class: 'pn-claude' });
  function renderClaude() {
    const st = claudeCodeStatus(ctx.store.select('board')?.harnesses ?? []);
    const b = st.harness
      ? enforcementWords(st.harness.enforcement_level, st.harness.enforcement_status, st.harness.enforcement_basis)
      : null;
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
        h('dd', null, b ? badge(b.label, b.tone, b.title) : '—'),
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

  // ---- the drawer
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
    hostsSection,
    h('section', { class: 'pn-section' }, h('h3', { class: 'section-title' }, 'Agents'), listState, list),
    claudeSection,
  );

  renderRows();
  renderClaude();
  td.add(
    ctx.store.subscribe('board', () => {
      renderRows();
      renderClaude();
    }),
  );
  void loadHosts();
  void loadProcesses();
  const timer = setInterval(() => void loadProcesses(), PROCESS_POLL_MS);
  td.add(() => clearInterval(timer));

  if (request.tab === 'claude') {
    queueMicrotask(() => {
      if (!td.done && typeof claudeSection.scrollIntoView === 'function')
        claudeSection.scrollIntoView({ block: 'start' });
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
