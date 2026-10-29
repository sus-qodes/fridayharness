/**
 * Start an agent (plan §7.7, FD-10, FD-24): a coding host Friday runs as a child
 * (`friday harness run <host>`), with its agent key, role and the host's own options, remembered
 * as a profile that can start with Friday. There is no model field: models come from routing.
 */
import type { AgentHost, AgentLaunchRequest, AgentOptions, AgentProcessesView, UiSnapshot } from '@friday/protocol';
import { type AppContext, type Component, closeModal, type ModalRequest, openDrawer } from '../shell/context.js';
import { button, h } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { actWithError, checkbox, field, input, linkButton, note, panel, plain, select, Teardown } from './common.js';

export type HostName = AgentLaunchRequest['host'];
export const HOSTS: readonly { host: HostName; label: string; prefix: string }[] = [
  { host: 'claude-code', label: 'Claude Code', prefix: 'claude' },
  { host: 'codex', label: 'Codex', prefix: 'codex' },
];

export const AGENT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
export const BUDGET = { min: 0.01, max: 100, default: 1 } as const;

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
  };
}

export function formErrors(form: AgentForm): { agent_key?: string; role?: string; max_budget_usd?: string } {
  const errors: { agent_key?: string; role?: string; max_budget_usd?: string } = {};
  if (!AGENT_KEY_RE.test(form.agent_key))
    errors.agent_key = 'use lowercase letters, digits and dashes (up to 64), starting with a letter or digit';
  if (!ROLE_RE.test(form.role))
    errors.role = 'a lowercase word such as developer, backend, frontend or qa (letters, digits, - and _)';
  if (form.host === 'claude-code') {
    const n = Number(form.claude.max_budget_usd);
    if (!form.claude.max_budget_usd.trim() || !Number.isFinite(n) || n < BUDGET.min || n > BUDGET.max)
      errors.max_budget_usd = `between ${BUDGET.min} and ${BUDGET.max} dollars`;
  }
  return errors;
}

/** The request body `POST agent-processes` takes: only the chosen host's options, no model. */
export function launchBody(form: AgentForm): AgentLaunchRequest {
  const options: AgentOptions = {};
  if (form.host === 'claude-code') {
    if (form.claude.effort) options.effort = form.claude.effort;
    options.max_budget_usd = Number(form.claude.max_budget_usd);
  } else {
    options.sandbox = form.codex.sandbox;
    if (form.codex.windows_sandbox) options.windows_sandbox = form.codex.windows_sandbox;
    if (form.codex.effort) options.effort = form.codex.effort;
    if (form.codex.service_tier) options.service_tier = form.codex.service_tier;
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
  const hostField = field('Host', hostSelect);
  hostField.el.append(hostNote);

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

  function renderOptions() {
    budgetField = null;
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
      optionsBox.replaceChildren(h('div', { class: 'pn-grid2' }, field('Effort', effort).el, budgetField.el));
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
      );
    }
  }

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
    const info = hostInfo();
    if (hostsFailed)
      hostNote.textContent = 'Friday could not check the installed hosts; it checks again when the agent starts.';
    else if (hosts === null) hostNote.textContent = 'Checking which hosts are installed…';
    else if (!info) hostNote.textContent = 'Friday did not report this host.';
    else if (!info.found) hostNote.textContent = `Not found: ${plain(info.reason ?? 'it is not installed', 300)}`;
    else
      hostNote.textContent = `Found${info.version ? ` ${plain(info.version, 40)}` : ''}${info.supported ? '' : ` (not supported: ${plain(info.reason ?? 'unknown version', 200)})`}`;
    const unavailable = !!info && !info.found;
    submitBtn.disabled = busy || Object.keys(errors).length > 0 || unavailable;
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
    optionsBox,
    autostart,
    note('Friday remembers this agent; with "Start with Friday" it starts whenever Friday does.'),
    h(
      'div',
      { class: 'pn-models-note' },
      note(
        'There is no model to choose here: Friday picks the model for each task from routing. To steer it, pin a model to a role, a task or a kind.',
      ),
      linkButton('Open routing pins', () => {
        closeModal(ctx);
        openDrawer(ctx, { kind: 'agents', tab: 'pins' });
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

  void ctx.api
    .agentHosts()
    .then((r) => {
      if (td.done) return;
      hosts = Array.isArray(r?.hosts) ? r.hosts : [];
      for (const opt of Array.from(hostSelect.options)) {
        const info = hosts.find((x) => x.host === opt.value);
        opt.disabled = !!info && !info.found;
        opt.textContent = `${HOSTS.find((x) => x.host === opt.value)?.label ?? opt.value}${info && !info.found ? ' (not found)' : ''}`;
      }
      // Choose an installed host when the default one is missing.
      const current = hostInfo();
      const found = hosts.find((x) => x.found);
      if (!preset && current && !current.found && found && (found.host === 'claude-code' || found.host === 'codex')) {
        form.host = found.host;
        hostSelect.value = found.host;
        refreshKey();
        renderOptions();
      }
      update();
    })
    .catch(() => {
      if (td.done) return;
      hostsFailed = true;
      update();
    });

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
