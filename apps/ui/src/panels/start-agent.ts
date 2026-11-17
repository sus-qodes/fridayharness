/**
 * Start an agent, or change one (plan §7.7, FD-10, FD-24): a coding host Friday runs as a child
 * (`friday harness run <host>`), with its agent key, role and the host's own options (under an
 * Options fold, review §4), remembered as a profile that can start with Friday. The Host field says
 * what is installed and how it is signed in, with "Check again". There is no model field: models
 * come from routing.
 *
 * 2026-11-17 (the review of connecting agents, and the owner's decisions):
 * - Only hosts that work are offered: Claude Code and Codex. OpenCode, the Cursor CLI and the
 *   Gemini CLI are listed as coming soon and cannot be chosen (they could not take whole kinds of
 *   work, or refused personal accounts). Antigravity is listed as before: a person opens it.
 * - The spending cap per attempt is a choice of none or an amount. It starts at none for a
 *   subscription's sign-in, which is not charged per attempt, and at $5 for an API key or when
 *   Friday cannot tell; it was $1 for everyone, which stopped larger tasks half way.
 * - The free-text "Models" and the "Cost class" are gone: the first, filled as its own hint said,
 *   left an agent that could take no task. An agent that already has them keeps them.
 * - The same dialog changes a remembered agent ("Edit"): its role, options and whether it starts
 *   with Friday. Its host and key stay; before, any change meant forgetting it and starting anew.
 */
import type {
  AgentHost,
  AgentLaunchRequest,
  AgentOptions,
  AgentProcessesView,
  AgentProfile,
  UiSnapshot,
} from '@friday/protocol';
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
/** The hosts Friday starts from here. */
export const HOSTS: readonly { host: HostName; label: string; prefix: string }[] = [
  { host: 'claude-code', label: 'Claude Code', prefix: 'claude' },
  { host: 'codex', label: 'Codex', prefix: 'codex' },
];
/** Hosts listed and not offered yet: each could not take whole kinds of work, or refused personal accounts. */
export const COMING_SOON: readonly string[] = ['OpenCode', 'Cursor CLI', 'Gemini CLI'];

/** The Host list's line for Antigravity: shown and never selectable, since Friday does not start it. */
export const ANTIGRAVITY_OPTION = 'antigravity';
export const ANTIGRAVITY_OPTION_LABEL = 'Antigravity: you open it yourself (Agents → Antigravity → Connect)';

export const AGENT_KEY_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE_RE = /^[a-z][a-z0-9_-]{0,31}$/;
/** The cap per attempt: its range, and what it starts at where each attempt is charged. */
export const BUDGET = { min: 0.01, max: 1000, default: 5 } as const;

export type ClaudeEffort = '' | 'low' | 'medium' | 'high';
export type CodexSandbox = NonNullable<AgentOptions['sandbox']>;
export type CodexEffort = '' | 'minimal' | 'low' | 'medium' | 'high';

export interface AgentForm {
  host: HostName;
  agent_key: string;
  role: string;
  autostart: boolean;
  /** `limit`: no cap per attempt, or the amount in `max_budget_usd`. */
  claude: { effort: ClaudeEffort; limit: 'none' | 'set'; max_budget_usd: string };
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

/** Whether a host's sign-in is charged per attempt: a cap starts at none only when it is known not to be. */
export function startsWithoutCap(signIn: AgentHost['sign_in'] | undefined): boolean {
  return signIn === 'subscription';
}

export function defaultForm(host: HostName, taken: Iterable<string>): AgentForm {
  return {
    host,
    agent_key: nextAgentKey(host, taken),
    role: 'developer',
    autostart: true,
    claude: { effort: '', limit: 'set', max_budget_usd: String(BUDGET.default) },
    codex: { sandbox: 'workspace-write', windows_sandbox: '', effort: '', service_tier: '' },
  };
}

const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;

/** The form of a remembered agent, for changing it. */
export function formOfProfile(p: AgentProfile): AgentForm {
  const o = p.options ?? {};
  const cap = o.max_budget_usd;
  return {
    host: p.host,
    agent_key: p.agent_key,
    role: p.role,
    autostart: p.autostart,
    claude: {
      effort: oneOf(o.effort, ['low', 'medium', 'high'] as const, ''),
      // A cap nobody set is decided when the agent starts; shown as an amount a person can change.
      limit: cap === null ? 'none' : 'set',
      max_budget_usd: String(typeof cap === 'number' ? cap : BUDGET.default),
    },
    codex: {
      sandbox: oneOf(o.sandbox, ['read-only', 'workspace-write', 'danger-full-access'] as const, 'workspace-write'),
      windows_sandbox: oneOf(o.windows_sandbox, ['elevated', 'unelevated'] as const, ''),
      effort: oneOf(o.effort, ['minimal', 'low', 'medium', 'high'] as const, ''),
      service_tier: oneOf(o.service_tier, ['default', 'priority'] as const, ''),
    },
  };
}

export function formErrors(form: AgentForm): { agent_key?: string; role?: string; max_budget_usd?: string } {
  const errors: { agent_key?: string; role?: string; max_budget_usd?: string } = {};
  if (!AGENT_KEY_RE.test(form.agent_key))
    errors.agent_key = 'use lowercase letters, digits and dashes (up to 64), starting with a letter or digit';
  if (!ROLE_RE.test(form.role))
    errors.role = 'a lowercase word such as developer, backend, frontend or qa (letters, digits, - and _)';
  if (form.host === 'claude-code' && form.claude.limit === 'set') {
    const n = Number(form.claude.max_budget_usd);
    if (!form.claude.max_budget_usd.trim() || !Number.isFinite(n) || n < BUDGET.min || n > BUDGET.max)
      errors.max_budget_usd = `between ${BUDGET.min} and ${BUDGET.max} dollars`;
  }
  return errors;
}

/** The chosen host's options as the daemon takes them, no model. */
export function formOptions(form: AgentForm): AgentOptions {
  const options: AgentOptions = {};
  if (form.host === 'claude-code') {
    if (form.claude.effort) options.effort = form.claude.effort;
    // A person's own choice either way: none (null), or the amount.
    options.max_budget_usd = form.claude.limit === 'none' ? null : Number(form.claude.max_budget_usd);
  } else if (form.host === 'codex') {
    options.sandbox = form.codex.sandbox;
    if (form.codex.windows_sandbox) options.windows_sandbox = form.codex.windows_sandbox;
    if (form.codex.effort) options.effort = form.codex.effort;
    if (form.codex.service_tier) options.service_tier = form.codex.service_tier;
  }
  return options;
}

/** The request body `POST agent-processes` takes: only the chosen host's options, no model. */
export function launchBody(form: AgentForm): AgentLaunchRequest {
  return {
    host: form.host,
    agent_key: form.agent_key.trim(),
    role: form.role.trim(),
    options: formOptions(form),
    autostart: form.autostart,
  };
}

/**
 * What `POST agent-processes/:key/update` takes for a changed agent. What the form no longer
 * shows of an agent made before (the models routing may run for it, its cost class) is kept.
 */
export function updateBody(
  form: AgentForm,
  was: AgentProfile,
): { role: string; options: AgentOptions; autostart: boolean } {
  const kept: AgentOptions = {};
  if (was.options?.models?.length) kept.models = was.options.models;
  if (was.options?.cost_class) kept.cost_class = was.options.cost_class;
  return { role: form.role.trim(), options: { ...kept, ...formOptions(form) }, autostart: form.autostart };
}

/** What Friday read of a host's sign-in, in a sentence; null when it has nothing to say. */
export function signInLine(info: AgentHost | undefined, label: string): string | null {
  switch (info?.sign_in) {
    case 'subscription':
      return 'Signed in with a subscription: nothing is charged per attempt.';
    case 'api_key':
      return 'Signed in with an API key or a cloud account: each attempt is charged to it.';
    case 'signed_in':
      return 'Signed in.';
    case 'none':
      return `Friday found no sign-in for ${label} on this computer. Open ${label} once and sign in, then Check again; an agent that is not signed in fails its first task. If you sign in another way, start it anyway.`;
    default:
      return null;
  }
}

export function startAgentModal(
  ctx: AppContext,
  request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  const board = ctx.store.select('board');
  /** Changing a remembered agent: `request.id` is its key. */
  const editing = request.kind === 'edit-agent';
  const editKey = editing ? (request.id ?? '') : '';
  const preset = editing ? undefined : HOSTS.find((x) => x.host === request.id)?.host;
  let view: AgentProcessesView | null = null;
  let hosts: AgentHost[] | null = null;
  let hostsFailed = false;
  /** The agent being changed, once read; null while reading, or when it is not remembered. */
  let profile: AgentProfile | null = null;
  const form = defaultForm(preset ?? 'claude-code', takenKeys(board));
  if (editing) form.agent_key = editKey;
  /** The key the page chose; replaced when the host changes or the profiles arrive, kept once typed. */
  let autoKey = form.agent_key;
  /** The cap's starting choice follows how the host is signed in, until the person chooses. */
  let limitTouched = editing;
  let busy = false;

  const hostSelect = select<HostName>(
    [
      ...HOSTS.map((x) => ({ value: x.host, label: x.label })),
      // Listed, not offered, so nobody looks for them in vain.
      ...COMING_SOON.map((name) => ({
        value: `soon:${name}` as HostName,
        label: `${name}: coming soon`,
        disabled: true,
      })),
      // Antigravity is not started by Friday (its terms keep a personal account to the session its
      // person runs).
      { value: ANTIGRAVITY_OPTION as HostName, label: ANTIGRAVITY_OPTION_LABEL, disabled: true },
    ],
    form.host,
    (v) => {
      form.host = v;
      refreshKey();
      applySignIn();
      renderOptions();
      update();
    },
  );
  hostSelect.disabled = editing;
  const hostNote = h('div', { class: 'field-hint', aria: { live: 'polite' } }, 'Checking which hosts are installed…');
  const signInNote = h('div', { class: 'field-hint pn-sign-in', aria: { live: 'polite' }, hidden: true });
  const checkHosts = button([icon('rework', 14), 'Check again'], () => void loadHosts(true), {
    class: 'btn btn-ghost',
    title: 'Look for the installed hosts, and how they are signed in, again',
  });
  const hostField = field('Host', hostSelect);
  hostField.el.append(
    h('div', { class: 'row pn-host-check' }, hostNote, h('span', { class: 'spacer' }), checkHosts),
    signInNote,
    editing
      ? h('div', { class: 'field-hint' }, 'An agent keeps its host and its key; start a new agent for another one.')
      : h(
          'div',
          { class: 'field-hint pn-antigravity-hint' },
          'Antigravity is not started here: you open it yourself. ',
          // A drawer under a dialog takes no input: the dialog closes first (plan §7.4).
          linkButton('Connect Antigravity', () => {
            closeModal(ctx);
            openDrawer(ctx, { kind: 'agents', tab: 'antigravity' });
          }),
        ),
  );

  const key = input({ class: 'input mono', value: form.agent_key, maxLength: 64 });
  key.disabled = editing;
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
      budget.disabled = form.claude.limit === 'none';
      budget.addEventListener('input', () => {
        form.claude.max_budget_usd = budget.value;
        limitTouched = true;
        update();
      });
      const limit = select<AgentForm['claude']['limit']>(
        [
          { value: 'none', label: 'No limit' },
          { value: 'set', label: 'Stop an attempt at (USD)' },
        ],
        form.claude.limit,
        (v) => {
          form.claude.limit = v;
          limitTouched = true;
          budget.disabled = v === 'none';
          update();
        },
      );
      budgetField = field('Spending limit per attempt', limit, {
        hint: 'A limit matters when each attempt is charged (an API key). With a subscription nothing is charged per attempt.',
      });
      budgetField.el.append(h('div', { class: 'pn-limit-amount' }, budget));
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
                'Friday cannot check each thing Codex does before it does it; only Codex’s own sandbox limits it.',
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

  // The host's own options are for the few who tune them (review §4): under a fold, opened by
  // itself when one of them is wrong, so the reason the agent cannot start is never out of sight.
  const options = fold('Options', { class: 'pn-host-options-fold' }, optionsBox);
  const autostartBox = checkbox('Start with Friday', form.autostart, (on) => {
    form.autostart = on;
  });
  const serverError = h('div', { class: 'field-error pn-server-error', hidden: true, role: 'alert' });
  const submitBtn = button(
    editing ? [icon('check', 14), 'Save'] : [icon('play', 14), 'Start the agent'],
    () => void submit(),
    { class: 'btn btn-primary' },
  );

  function refreshKey() {
    if (editing || form.agent_key !== autoKey) return;
    autoKey = nextAgentKey(form.host, takenKeys(ctx.store.select('board'), view));
    form.agent_key = autoKey;
    key.value = autoKey;
  }

  function hostInfo(): AgentHost | undefined {
    return hosts?.find((x) => x.host === form.host);
  }

  /** The cap starts where the host's sign-in puts it, until the person chooses (never when editing). */
  function applySignIn() {
    if (limitTouched || form.host !== 'claude-code') return;
    const info = hostInfo();
    if (!info) return;
    form.claude.limit = startsWithoutCap(info.sign_in) ? 'none' : 'set';
  }

  function update() {
    const errors = formErrors(form);
    keyField.setError(errors.agent_key ?? null);
    roleField.setError(errors.role ?? null);
    budgetField?.setError(errors.max_budget_usd ?? null);
    if (errors.max_budget_usd) options.open = true;
    const info = hostInfo();
    const label = HOSTS.find((x) => x.host === form.host)?.label ?? form.host;
    if (hostsFailed)
      hostNote.textContent = 'Friday could not check the installed hosts; it checks again when the agent starts.';
    else if (hosts === null) hostNote.textContent = 'Checking which hosts are installed…';
    else if (!info) hostNote.textContent = 'Friday did not report this host.';
    else if (!info.found) hostNote.textContent = `Not found: ${plain(info.reason ?? 'it is not installed', 300)}`;
    else if (!info.supported)
      hostNote.textContent = `Found${info.version ? ` ${plain(info.version, 40)}` : ''}, which Friday cannot start: ${plain(info.reason ?? 'unknown version', 200)}. Update ${label}, then Check again.`;
    else
      hostNote.textContent = `Found${info.version ? ` ${plain(info.version, 40)}` : ''}${info.path ? ` at ${visible(truncate(info.path, 120))}` : ''}`;
    const said = info?.found ? signInLine(info, label) : null;
    signInNote.hidden = !said;
    signInNote.textContent = said ?? '';
    signInNote.classList.toggle('field-error', info?.sign_in === 'none');
    // A host Friday did not find, or cannot start as it is, starts nothing: said above, not on a click.
    const unavailable = !editing && !!info && (!info.found || !info.supported);
    submitBtn.disabled = busy || Object.keys(errors).length > 0 || unavailable || (editing && !profile);
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
        const known = HOSTS.find((x) => x.host === opt.value);
        if (!known) continue;
        const info = hosts.find((x) => x.host === opt.value);
        opt.disabled = !!info && !info.found;
        opt.textContent = `${known.label}${info && !info.found ? ' (not found)' : ''}`;
      }
      // Choose an installed host when the chosen one is missing (unless the opener named it).
      const current = hostInfo();
      const found = hosts.find((x) => x.found && HOSTS.some((k) => k.host === x.host));
      if (!editing && !preset && current && !current.found && found) {
        form.host = found.host;
        hostSelect.value = found.host;
        refreshKey();
      }
      applySignIn();
      renderOptions();
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
    const onError = (e: { status?: number | null; code?: string | null; message: string }) => {
      // A 409 says who holds the key: shown as the daemon wrote it.
      serverError.hidden = false;
      serverError.textContent =
        e.status === 409 ? plain(e.message, 1000) : `${e.code ? `${e.code}: ` : ''}${plain(e.message, 1000)}`;
    };
    let done = false;
    if (editing && profile) {
      const was = profile;
      const r = await actWithError(
        ctx,
        'Save the agent',
        () => ctx.api.updateAgent(was.agent_key, updateBody(form, was)),
        onError,
        (x) =>
          x.running
            ? `Saved. A new spending limit applies from the next attempt of ${was.agent_key}; the rest from its next start (Stop, then Start again)`
            : `Saved: ${was.agent_key} starts with it next time`,
      );
      done = Boolean(r);
    } else {
      const body = launchBody(form);
      const r = await actWithError(
        ctx,
        'Start the agent',
        () => ctx.api.launchAgent(body),
        onError,
        `Started ${body.agent_key}`,
      );
      done = Boolean(r);
    }
    busy = false;
    if (td.done) return;
    update();
    if (!done) return;
    ctx.refresh();
    close();
  }

  const el = panel(
    'pn-start-agent',
    hostField.el,
    h('div', { class: 'pn-grid2' }, keyField.el, roleField.el),
    autostartBox,
    note(
      editing
        ? 'A new spending limit applies from the agent’s next attempt. Everything else applies the next time it starts; what it runs with now stays as it is.'
        : 'Friday remembers this agent; with "Start with Friday" it starts whenever Friday does.',
    ),
    options,
    editing
      ? null
      : h(
          'div',
          { class: 'pn-models-note' },
          note(
            'There is no model to choose here: Friday picks the model for each task. To use one model for everything, or for one kind of work, open Settings → Models.',
          ),
          // A drawer under a dialog takes no input: the dialog closes first (plan §7.4).
          linkButton('Open the model choices', () => {
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
      if (editing) {
        profile = view?.profiles.find((p) => p.agent_key === editKey) ?? null;
        if (profile) {
          Object.assign(form, formOfProfile(profile));
          hostSelect.value = form.host;
          role.value = form.role;
          const box = autostartBox.querySelector('input');
          if (box) box.checked = form.autostart;
          renderOptions();
        } else {
          serverError.hidden = false;
          serverError.textContent = `Friday does not remember an agent ${plain(editKey, 80)}; it may have been forgotten meanwhile.`;
        }
      } else refreshKey();
      update();
    })
    .catch(() => {
      if (td.done || !editing) return;
      serverError.hidden = false;
      serverError.textContent = 'Friday could not read the remembered agents; close this and try again.';
      update();
    });

  return {
    title: editing ? `Edit ${editKey}` : 'Start an agent',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
