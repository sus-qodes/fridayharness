/**
 * Start an agent (plan §7.7, FD-10, FD-24): a coding host Friday runs as a child
 * (`friday harness run <host>`), with its agent key, role and the host's own options (under an
 * Options fold, review §4), remembered as a profile that can start with Friday. The Host field says
 * what is installed, with "Check again" (the drawer's Installed hosts list folded in here). There is
 * no model field: models come from routing, whose pins live in Settings → Routing. Claude Code and
 * Codex may name the models routing may run for the agent, and its cost class (plan M13.3).
 */
import type { AgentHost, AgentLaunchRequest, AgentOptions, AgentProcessesView, UiSnapshot } from '@friday/protocol';
import { visible } from '../model/text.js';
import { type AppContext, type Component, closeModal, type ModalRequest, openDrawer } from '../shell/context.js';
import { button, h } from '../ui/dom.js';
import { truncate } from '../ui/format.js';
import { icon } from '../ui/svg.js';
import {
  actWithError,
  checkbox,
  field,
  fold,
  input,
  linkButton,
  note,
  panel,
  plain,
  select,
  Teardown,
} from './common.js';

export type HostName = AgentLaunchRequest['host'];
export const HOSTS: readonly { host: HostName; label: string; prefix: string }[] = [
  { host: 'claude-code', label: 'Claude Code', prefix: 'claude' },
  { host: 'codex', label: 'Codex', prefix: 'codex' },
  // Experimental until the owner's live check with their own login (plan M8b).
  { host: 'cursor', label: 'Cursor CLI (experimental)', prefix: 'cursor' },
  { host: 'gemini', label: 'Gemini CLI (experimental)', prefix: 'gemini' },
];

export const AGENT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const BUDGET = { min: 0.01, max: 100, default: 1 } as const;
/** A model id as a registry or a local server names one; never a leading `-` (the launcher's rule). */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
export const MAX_MODELS = 8;

export type CostClassChoice = '' | NonNullable<AgentOptions['cost_class']>;

export type ClaudeEffort = '' | 'low' | 'medium' | 'high';
export type CodexSandbox = NonNullable<AgentOptions['sandbox']>;
export type CodexEffort = '' | 'minimal' | 'low' | 'medium' | 'high';

export interface AgentForm {
  host: HostName;
  agent_key: string;
  role: string;
  autostart: boolean;
  claude: { effort: ClaudeEffort; max_budget_usd: string };
  codex: {
    sandbox: CodexSandbox;
    windows_sandbox: '' | 'elevated' | 'unelevated';
    effort: CodexEffort;
    service_tier: '' | 'default' | 'priority';
  };
  /** Claude Code and Codex: what the agent's work costs, and the models routing may run for it (plan M13.3). */
  routing: { cost_class: CostClassChoice; models: string };
}

export function hostPrefix(host: HostName): string {
  return HOSTS.find((x) => x.host === host)?.prefix ?? host;
}

/** The agent keys already in use: remembered profiles, running processes and the board's agents. */
export function takenKeys(
  board: Pick<UiSnapshot, 'agents'> | null | undefined,
  view?: AgentProcessesView | null,
): string[] {
  return [
    ...(board?.agents ?? []).map((a) => a.agent_key),
    ...(view?.profiles ?? []).map((p) => p.agent_key),
    ...(view?.processes ?? []).map((p) => p.agent_key),
  ];
}

/** `claude-1`, `claude-2`, … (or `codex-n`): the first number no profile, process or agent uses. */
export function nextAgentKey(host: HostName, taken: Iterable<string>): string {
  const used = new Set(taken);
  const prefix = hostPrefix(host);
  for (let n = 1; ; n += 1) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export function defaultForm(host: HostName, taken: Iterable<string>): AgentForm {
  return {
    host,
    agent_key: nextAgentKey(host, taken),
    role: 'developer',
    autostart: true,
    claude: { effort: '', max_budget_usd: String(BUDGET.default) },
    codex: { sandbox: 'workspace-write', windows_sandbox: '', effort: '', service_tier: '' },
    routing: { cost_class: '', models: '' },
  };
}

/** The models a form names, one per comma. */
export function formModels(form: AgentForm): string[] {
  return form.routing.models
    .split(',')
    .map((m) => m.trim())
    .filter(Boolean);
}

const ROUTED_HOSTS = new Set<HostName>(['claude-code', 'codex']);

export function formErrors(form: AgentForm): {
  agent_key?: string;
  role?: string;
  max_budget_usd?: string;
  models?: string;
} {
  const errors: { agent_key?: string; role?: string; max_budget_usd?: string; models?: string } = {};
  if (!AGENT_KEY_RE.test(form.agent_key))
    errors.agent_key = 'use lowercase letters, digits and dashes (up to 64), starting with a letter or digit';
  if (!ROLE_RE.test(form.role))
    errors.role = 'a lowercase word such as developer, backend, frontend or qa (letters, digits, - and _)';
  if (form.host === 'claude-code') {
    const n = Number(form.claude.max_budget_usd);
    if (!form.claude.max_budget_usd.trim() || !Number.isFinite(n) || n < BUDGET.min || n > BUDGET.max)
      errors.max_budget_usd = `between ${BUDGET.min} and ${BUDGET.max} dollars`;
  }
  if (ROUTED_HOSTS.has(form.host)) {
    const models = formModels(form);
    if (models.length > MAX_MODELS) errors.models = `at most ${MAX_MODELS} models`;
    else if (models.some((m) => !MODEL_RE.test(m)))
      errors.models = 'model ids such as claude-haiku-5-5, separated by commas';
  }
  return errors;
}

/** The request body `POST agent-processes` takes: only the chosen host's options, no model. */
export function launchBody(form: AgentForm): AgentLaunchRequest {
  const options: AgentOptions = {};
  if (form.host === 'claude-code') {
    if (form.claude.effort) options.effort = form.claude.effort;
    options.max_budget_usd = Number(form.claude.max_budget_usd);
  } else if (form.host === 'codex') {
    options.sandbox = form.codex.sandbox;
    if (form.codex.windows_sandbox) options.windows_sandbox = form.codex.windows_sandbox;
    if (form.codex.effort) options.effort = form.codex.effort;
    if (form.codex.service_tier) options.service_tier = form.codex.service_tier;
  }
  if (ROUTED_HOSTS.has(form.host)) {
    if (form.routing.cost_class) options.cost_class = form.routing.cost_class;
    const models = formModels(form);
    if (models.length) options.models = models;
  }
  return {
    host: form.host,
    agent_key: form.agent_key.trim(),
    role: form.role.trim(),
    options,
    autostart: form.autostart,
  };
}

export function startAgentModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const board = ctx.store.select('board');
  const preset = HOSTS.find((x) => x.host === request.id)?.host;
  let view: AgentProcessesView | null = null;
  let hosts: AgentHost[] | null = null;
  let hostsFailed = false;
  const form = defaultForm(preset ?? 'claude-code', takenKeys(board));
  /** The key the page chose; replaced when the host changes or the profiles arrive, kept once typed. */
  let autoKey = form.agent_key;
  let busy = false;

  const hostSelect = select(
    HOSTS.map((x) => ({ value: x.host, label: x.label })),
    form.host,
    (v) => {
      form.host = v;
      refreshKey();
      renderOptions();
      update();
    },
  );
  const hostNote = h('div', { class: 'field-hint', aria: { live: 'polite' } }, 'Checking which hosts are installed…');
  const checkHosts = button([icon('rework', 14), 'Check again'], () => void loadHosts(true), {
    class: 'btn btn-ghost',
    title: 'Look for the installed hosts again',
  });
  const hostField = field('Host', hostSelect);
  hostField.el.append(h('div', { class: 'row pn-host-check' }, hostNote, h('span', { class: 'spacer' }), checkHosts));

  const key = input({ class: 'input mono', value: form.agent_key, maxLength: 64 });
  const keyField = field('Agent key', key, { hint: 'how Friday names this agent; a new key for each agent' });
  key.addEventListener('input', () => {
    form.agent_key = key.value;
    update();
  });

  const role = input({ class: 'input mono', value: form.role, maxLength: 32 });
  const roleField = field('Role', role, { hint: 'tasks are matched to agents by role' });
  role.addEventListener('input', () => {
    form.role = role.value;
    update();
  });

  const optionsBox = h('div', { class: 'pn-host-options' });
  let budgetField: ReturnType<typeof field> | null = null;
  let modelsField: ReturnType<typeof field> | null = null;

  /** The cost class and the models, for Claude Code and Codex (plan M13.3). */
  function routingOptions(): HTMLElement {
    const cost = select<CostClassChoice>(
      [
        { value: '', label: 'From its model' },
        { value: 'free', label: 'Free (a model on this machine)' },
        { value: 'cheap', label: 'Cheap' },
        { value: 'standard', label: 'Standard' },
      ],
      form.routing.cost_class,
      (v) => {
        form.routing.cost_class = v;
      },
    );
    const models = input({ class: 'input mono', value: form.routing.models, maxLength: 900 });
    models.addEventListener('input', () => {
      form.routing.models = models.value;
      update();
    });
    modelsField = field('Models', models, {
      hint: 'optional, comma-separated: the only models routing may run for this agent',
    });
    return h(
      'div',
      { class: 'pn-grid2' },
      field('Cost class', cost, {
        hint: 'small, low-risk tasks go to the cheapest capable agent; a refused claim to a stronger one',
      }).el,
      modelsField.el,
    );
  }

  function renderOptions() {
    budgetField = null;
    modelsField = null;
    if (form.host === 'claude-code') {
      const effort = select<ClaudeEffort>(
        [
          { value: '', label: "Claude Code's default" },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
        form.claude.effort,
        (v) => {
          form.claude.effort = v;
        },
      );
      const budget = input({
        type: 'number',
        value: form.claude.max_budget_usd,
        min: String(BUDGET.min),
        max: String(BUDGET.max),
        step: '0.01',
      });
      budget.addEventListener('input', () => {
        form.claude.max_budget_usd = budget.value;
        update();
      });
      budgetField = field('Spending cap per attempt (USD)', budget, {
        hint: `${BUDGET.min} to ${BUDGET.max}; Claude Code stops an attempt that would spend more`,
      });
      optionsBox.replaceChildren(
        h('div', { class: 'pn-grid2' }, field('Effort', effort).el, budgetField.el),
        routingOptions(),
      );
    } else if (form.host !== 'codex') {
      // The Cursor CLI and Gemini CLI take no options here: their models come from routing too.
      optionsBox.replaceChildren(
        h('div', { class: 'field-hint' }, 'This host takes no options here; Friday routes its model.'),
      );
    } else {
      let previous = form.codex.sandbox;
      const sandbox = select<CodexSandbox>(
        [
          { value: 'read-only', label: 'Read only' },
          { value: 'workspace-write', label: 'Workspace write (default)' },
          { value: 'danger-full-access', label: 'Full access (dangerous)' },
        ],
        form.codex.sandbox,
        (v) => {
          if (v !== 'danger-full-access') {
            form.codex.sandbox = v;
            previous = v;
            return;
          }
          void ctx
            .confirm({
              title: 'Give Codex full access?',
              body: [
                'With full access Codex runs its commands with no sandbox: they can change any file and reach the network.',
                'Friday cannot hold Codex at the tool boundary; only its sandbox limits it.',
              ],
              confirmLabel: 'Allow full access',
              danger: true,
            })
            .then((ok) => {
              if (td.done) return;
              if (ok) {
                form.codex.sandbox = 'danger-full-access';
                previous = 'danger-full-access';
              } else {
                form.codex.sandbox = previous;
                sandbox.value = previous;
              }
            });
        },
      );
      const windows = select<AgentForm['codex']['windows_sandbox']>(
        [
          { value: '', label: 'Your Codex setting' },
          { value: 'unelevated', label: 'Unelevated' },
          { value: 'elevated', label: "Elevated (needs an administrator's setup)" },
        ],
        form.codex.windows_sandbox,
        (v) => {
          form.codex.windows_sandbox = v;
        },
      );
      const effort = select<CodexEffort>(
        [
          { value: '', label: "Codex's default" },
          { value: 'minimal', label: 'Minimal' },
          { value: 'low', label: 'Low' },
          { value: 'medium', label: 'Medium' },
          { value: 'high', label: 'High' },
        ],
        form.codex.effort,
        (v) => {
          form.codex.effort = v;
        },
      );
      const tier = select<AgentForm['codex']['service_tier']>(
        [
          { value: '', label: 'Your Codex setting' },
          { value: 'default', label: 'Default (standard speed)' },
          { value: 'priority', label: 'Priority' },
        ],
        form.codex.service_tier,
        (v) => {
          form.codex.service_tier = v;
        },
      );
      optionsBox.replaceChildren(
        h(
          'div',
          { class: 'pn-grid2' },
          field('Sandbox', sandbox).el,
          field('Windows sandbox', windows, { hint: 'on Windows only' }).el,
          field('Effort', effort).el,
          field('Service tier', tier).el,
        ),
        routingOptions(),
      );
    }
  }

  // The host's own options are for the few who tune them (review §4): under a fold, opened by
  // itself when one of them is wrong, so the reason the agent cannot start is never out of sight.
  const options = fold('Options', { class: 'pn-host-options-fold' }, optionsBox);
  const autostart = checkbox('Start with Friday', form.autostart, (on) => {
    form.autostart = on;
  });
  const serverError = h('div', { class: 'field-error pn-server-error', hidden: true, role: 'alert' });
  const submitBtn = button([icon('play', 14), 'Start the agent'], () => void submit(), { class: 'btn btn-primary' });

  function refreshKey() {
    if (form.agent_key !== autoKey) return;
    autoKey = nextAgentKey(form.host, takenKeys(ctx.store.select('board'), view));
    form.agent_key = autoKey;
    key.value = autoKey;
  }

  function hostInfo(): AgentHost | undefined {
    return hosts?.find((x) => x.host === form.host);
  }

  function update() {
    const errors = formErrors(form);
    keyField.setError(errors.agent_key ?? null);
    roleField.setError(errors.role ?? null);
    budgetField?.setError(errors.max_budget_usd ?? null);
    modelsField?.setError(errors.models ?? null);
    if (errors.max_budget_usd || errors.models) options.open = true;
    const info = hostInfo();
    if (hostsFailed)
      hostNote.textContent = 'Friday could not check the installed hosts; it checks again when the agent starts.';
    else if (hosts === null) hostNote.textContent = 'Checking which hosts are installed…';
    else if (!info) hostNote.textContent = 'Friday did not report this host.';
    else if (!info.found) hostNote.textContent = `Not found: ${plain(info.reason ?? 'it is not installed', 300)}`;
    else
      hostNote.textContent = `Found${info.version ? ` ${plain(info.version, 40)}` : ''}${info.path ? ` at ${visible(truncate(info.path, 120))}` : ''}${info.supported ? '' : ` (not supported: ${plain(info.reason ?? 'unknown version', 200)})`}`;
    const unavailable = !!info && !info.found;
    submitBtn.disabled = busy || Object.keys(errors).length > 0 || unavailable;
  }

  /** Asks Friday which hosts are installed; `refresh` makes it look again instead of answering from memory. */
  async function loadHosts(refresh = false) {
    checkHosts.disabled = true;
    if (refresh) {
      hosts = null;
      hostsFailed = false;
      update();
    }
    try {
      const r = await ctx.api.agentHosts(refresh);
      if (td.done) return;
      hosts = Array.isArray(r?.hosts) ? r.hosts : [];
      for (const opt of Array.from(hostSelect.options)) {
        const info = hosts.find((x) => x.host === opt.value);
        opt.disabled = !!info && !info.found;
        opt.textContent = `${HOSTS.find((x) => x.host === opt.value)?.label ?? opt.value}${info && !info.found ? ' (not found)' : ''}`;
      }
      // Choose an installed host when the chosen one is missing (unless the opener named it).
      const current = hostInfo();
      const found = hosts.find((x) => x.found);
      if (!preset && current && !current.found && found && (found.host === 'claude-code' || found.host === 'codex')) {
        form.host = found.host;
        hostSelect.value = found.host;
        refreshKey();
        renderOptions();
      }
    } catch {
      if (td.done) return;
      hostsFailed = true;
    } finally {
      if (!td.done) {
        checkHosts.disabled = false;
        update();
      }
    }
  }

  async function submit() {
    if (busy) return;
    const errors = formErrors(form);
    if (Object.keys(errors).length) {
      update();
      return;
    }
    busy = true;
    serverError.hidden = true;
    update();
    const body = launchBody(form);
    const r = await actWithError(
      ctx,
      'Start the agent',
      () => ctx.api.launchAgent(body),
      (e) => {
        // A 409 says who holds the key: shown as the daemon wrote it.
        serverError.hidden = false;
        serverError.textContent =
          e.status === 409 ? plain(e.message, 1000) : `${e.code ? `${e.code}: ` : ''}${plain(e.message, 1000)}`;
      },
      `Started ${body.agent_key}`,
    );
    busy = false;
    if (td.done) return;
    update();
    if (!r) return;
    ctx.refresh();
    close();
  }

  const el = panel(
    'pn-start-agent',
    hostField.el,
    h('div', { class: 'pn-grid2' }, keyField.el, roleField.el),
    autostart,
    note('Friday remembers this agent; with "Start with Friday" it starts whenever Friday does.'),
    options,
    h(
      'div',
      { class: 'pn-models-note' },
      note(
        'There is no model to choose here: Friday picks the model for each task from routing. To steer it, pin a model to a role, a task or a kind in Settings → Routing.',
      ),
      // A drawer under a dialog takes no input: the dialog closes first (plan §7.4).
      linkButton('Open routing pins', () => {
        closeModal(ctx);
        openDrawer(ctx, { kind: 'settings', tab: 'routing' });
      }),
    ),
    serverError,
    h(
      'div',
      { class: 'pn-actions' },
      button('Cancel', () => close(), { class: 'btn btn-ghost' }),
      submitBtn,
    ),
  );

  renderOptions();
  update();
  void loadHosts();

  void ctx.api
    .agentProcesses()
    .then((r) => {
      if (td.done) return;
      view = r && Array.isArray(r.profiles) ? r : null;
      refreshKey();
      update();
    })
    .catch(() => undefined);

  return {
    title: 'Start an agent',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
