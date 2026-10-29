/**
 * The agent pod (handoff Part 04 §4, plan §7.3, review M9k): vendor, agent key and the enforcement
 * badge in plain words (Enforced, Reported, Watched, Unverified; the level in its tooltip); the
 * model (observed, else requested); spend and tokens as the host reports them; the live ribbon
 * with the current tool, its target, the task's `+N −M` and the last tool's duration; attached or
 * spawned, its status and the shadow marker. Clicking the pod opens its live stream; the file in
 * the ribbon opens the task's diff.
 */
import type { PodModel } from '../model/board.js';
import { enforcementWords } from '../model/status.js';
import { visible } from '../model/text.js';
import { type AppContext, openDrawer } from '../shell/context.js';
import type { AgentActivity, ToolActivity } from '../store/state.js';
import { button, h, replace, toggleClass } from '../ui/dom.js';
import { compact, duration, humanize, shortId, truncate, usd } from '../ui/format.js';
import { badge, fingerprint, fromControl, type NodeView, nodeIcon } from './common.js';
import { statText } from './task-node.js';

export interface PodCardModel {
  pod: PodModel;
  activity: AgentActivity | null;
  /** The pod's task's line counts. */
  stats: { added: number; removed: number } | null;
  /** How long the last finished tool took (from its policy decision to its completion). */
  lastToolMs: number | null;
  /** The file most recently written for its task (the ribbon's file when the tool is not a write). */
  recentFile: string | null;
  selected: boolean;
}

/**
 * Measures each agent's last tool: from the decision that let it run (`allow`) to its completion
 * (`done` or `failed`), as the activity slice shows them one after the other.
 */
export class ToolDurations {
  readonly #start = new Map<string, number>();
  readonly #last = new Map<string, number>();
  readonly #seen = new Map<string, ToolActivity | null>();

  observe(agents: Readonly<Record<string, AgentActivity>>): void {
    for (const [key, a] of Object.entries(agents)) {
      const cur = a.current;
      if (this.#seen.get(key) === cur) continue;
      this.#seen.set(key, cur);
      if (!cur) continue;
      if (cur.decision === 'allow' || cur.decision === 'ask') this.#start.set(key, cur.at);
      else if (cur.decision === 'done' || cur.decision === 'failed') {
        const start = this.#start.get(key);
        if (start !== undefined && cur.at >= start) this.#last.set(key, cur.at - start);
        this.#start.delete(key);
      } else this.#start.delete(key);
    }
  }

  last(agentKey: string): number | null {
    return this.#last.get(agentKey) ?? null;
  }
}

const VENDOR: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  october: 'October',
  generic: 'Agent',
};

export function vendorLabel(pod: Pick<PodModel, 'harness'>): string {
  const v = pod.harness?.vendor;
  return v ? (VENDOR[v] ?? pod.harness?.name ?? v) : 'Agent';
}

/** The model to show: observed by the host, else what Friday routed the run to. */
export function podModelName(m: Pick<PodCardModel, 'pod' | 'activity'>): { name: string; requested: boolean } | null {
  const observed = m.pod.run?.model_observed ?? m.activity?.model ?? m.pod.harness?.observed_model ?? null;
  if (observed) return { name: observed, requested: false };
  const requested = m.pod.run?.model_requested ?? null;
  return requested ? { name: requested, requested: true } : null;
}

/** Spend and tokens as reported: the snapshot's last usage of the run, else the live one. */
export function podUsage(m: Pick<PodCardModel, 'pod' | 'activity'>): { cost: string; tokens: string } {
  const u = m.pod.usage ?? m.activity?.usage ?? null;
  const tokens =
    u && (u.input_tokens !== null || u.output_tokens !== null) ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) : null;
  return { cost: usd(u?.cost_usd ?? null), tokens: tokens === null ? '—' : compact(tokens) };
}

export function createAgentPod(ctx: AppContext, initial: PodCardModel): NodeView<PodCardModel> {
  let model = initial;
  let printed = '';
  const openTerminal = () => openDrawer(ctx, { kind: 'terminal', id: model.pod.agentKey });
  const body = h('div', { class: 'nd-body' });
  const foot = h('div', { class: 'nd-foot' });
  const el = h(
    'div',
    {
      class: ['nd-card', 'nd-pod'],
      role: 'group',
      tabIndex: 0,
      dataset: { id: initial.pod.id, kind: 'pod' },
      on: {
        click: (e) => {
          if (!fromControl(e)) openTerminal();
        },
        keydown: (e) => {
          if (e.target === el && e.key === 'Enter') {
            e.preventDefault();
            openTerminal();
          }
        },
      },
    },
    body,
    foot,
  );

  function render(force = false): void {
    const m = model;
    const pod = m.pod;
    const cur = m.activity?.current ?? null;
    const usage = podUsage(m);
    const modelName = podModelName(m);
    const print = fingerprint([
      pod.agentKey,
      pod.agent.status,
      pod.agent.shadow,
      pod.harness?.harness_id,
      pod.harness?.status,
      pod.harness?.attach_mode,
      pod.harness?.enforcement_level,
      pod.harness?.enforcement_status,
      pod.harness?.shadow,
      pod.taskId,
      pod.task?.status,
      pod.working,
      modelName,
      usage,
      cur,
      m.stats,
      m.lastToolMs,
      m.recentFile,
    ]);
    toggleClass(el, 'nd-selected', m.selected);
    if (!force && print === printed) return;
    printed = print;

    const enforcement = enforcementWords(
      pod.harness?.enforcement_level,
      pod.harness?.enforcement_status,
      pod.harness?.enforcement_basis,
    );
    const shadow = pod.agent.shadow || !!pod.harness?.shadow;
    replace(
      body,
      h(
        'div',
        { class: 'nd-head', dataset: { dragHandle: '' } },
        nodeIcon('robot', 15),
        h('span', { class: 'nd-vendor' }, vendorLabel(pod)),
        h('span', { class: 'nd-key mono', title: visible(pod.agentKey) }, truncate(visible(pod.agentKey), 28)),
        h('span', { class: 'spacer' }),
        badge(enforcement.label, enforcement.tone, enforcement.title),
        button(nodeIcon('terminal', 13), openTerminal, {
          class: 'btn btn-ghost btn-icon nd-open',
          ariaLabel: `Open the live stream of ${pod.agentKey}`,
          title: 'Open the live stream',
          dataset: { action: 'terminal' },
        }),
      ),
      h(
        'div',
        { class: 'nd-model' },
        h('span', { class: 'nd-label' }, 'Model'),
        modelName
          ? h('span', { class: 'mono', title: visible(modelName.name) }, truncate(visible(modelName.name), 40))
          : h('span', { class: 'muted' }, '—'),
        modelName?.requested ? h('span', { class: 'muted' }, ' (requested)') : null,
      ),
      h(
        'div',
        { class: 'nd-metrics' },
        h('span', { title: 'Spend reported by the host' }, usage.cost),
        h('span', { title: 'Tokens reported by the host' }, `${usage.tokens} tokens`),
        h(
          'span',
          { title: 'How long the last tool took' },
          `last tool ${m.lastToolMs === null ? '—' : duration(m.lastToolMs)}`,
        ),
      ),
      ribbon(m, cur),
    );
    replace(
      foot,
      h(
        'span',
        { class: 'nd-mode' },
        pod.harness?.attach_mode === 'spawn' ? 'spawned' : pod.harness ? 'attached' : 'no session',
      ),
      h('span', { class: 'muted' }, `· ${humanize(pod.agent.status)}`),
      pod.taskId ? h('span', { class: 'muted mono', title: pod.taskId }, `· ${shortId(pod.taskId)}`) : null,
      h('span', { class: 'spacer' }),
      shadow ? badge('shadow', 'warn', 'Another live session holds this agent key; this one only observes') : null,
    );
    el.dataset.status = pod.agent.status;
    toggleClass(el, 'nd-pod-working', pod.working);
    toggleClass(el, 'nd-pod-offline', pod.agent.status === 'DISCONNECTED' || pod.agent.status === 'UNHEALTHY');
    el.setAttribute('aria-label', `Agent ${pod.agentKey}, ${humanize(pod.agent.status)}`);
  }

  function ribbon(m: PodCardModel, cur: ToolActivity | null): HTMLElement {
    const taskId = m.pod.taskId;
    const isFile = cur?.target && (cur.kind === 'write' || cur.kind === 'read' || cur.kind === 'search');
    const file = isFile ? cur?.target : m.recentFile;
    const target =
      file && taskId
        ? button(
            [nodeIcon('file', 11), truncate(visible(file), 60)],
            () => openDrawer(ctx, { kind: 'diff', id: taskId, path: file }),
            {
              class: 'btn btn-ghost nd-file mono',
              title: `Open the diff of ${visible(file)}`,
              dataset: { action: 'diff' },
            },
          )
        : cur?.target
          ? h('span', { class: 'nd-target mono', title: visible(cur.target) }, truncate(visible(cur.target), 60))
          : null;
    return h(
      'div',
      { class: ['nd-ribbon', !cur && 'nd-ribbon-idle'] },
      h(
        'div',
        { class: 'nd-ribbon-row' },
        nodeIcon(m.pod.working ? 'bolt' : 'dot', 12),
        h('span', { class: 'nd-tool' }, cur ? truncate(visible(cur.tool), 24) : m.pod.task ? 'idle' : 'no task'),
        cur && cur.decision !== 'allow'
          ? h('span', { class: `nd-decision nd-decision-${cur.decision}` }, cur.decision)
          : null,
        h('span', { class: 'spacer' }),
        taskId
          ? h('span', { class: 'nd-lines mono', title: 'Lines added and removed in its task' }, statText(m.stats))
          : null,
      ),
      target ? h('div', { class: 'nd-ribbon-row' }, target) : null,
    );
  }

  render(true);
  return {
    el,
    update(next) {
      model = next;
      render();
    },
    destroy() {
      el.remove();
    },
  };
}
