/**
 * Connect Antigravity: preview every file `harness config antigravity` would write (and whether git
 * tracks it), apply it on confirm, say whether it is connected and what needs attention
 * (setup-checks.ts), then the steps in Antigravity: open
 * the folder yourself, trust it, allow the friday tools, and ask the agent to take its task.
 *
 * Antigravity only attaches. Its terms keep a personal account to the Antigravity the person runs
 * themselves, so this dialog has no Start button and Friday never launches it: the dialog says so
 * instead of leaving the missing button unexplained.
 */
import type { AntigravitySetupPlan, AntigravitySetupResult, UiSnapshot } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { applyWarning, changeView } from './claude-setup.js';
import { actWithError, copyLine, field, input, note, panel, plain, section, Teardown } from './common.js';
import { setupChecksView } from './setup-checks.js';
import { AGENT_KEY_RE } from './start-agent.js';

/**
 * The name Antigravity works under where nobody chose one (2026-11-17): its own, never the `dev-1`
 * Claude Code in VS Code works under. With one name for both, whichever connected second was a
 * shadow of the first and could take no task.
 */
export const ANTIGRAVITY_SETUP_KEY = 'antigravity-1';

/**
 * The names other apps already work under on this board: an agent whose session is not
 * Antigravity's, or one Friday starts itself. Antigravity under one of them could take no task.
 */
export function namesTakenByOthers(board: UiSnapshot | null): Set<string> {
  const taken = new Set<string>();
  const antigravity = new Set(
    (board?.harnesses ?? []).filter((x) => x.vendor === 'antigravity').map((x) => x.harness_id),
  );
  for (const a of board?.agents ?? []) {
    if (a.status === 'TERMINATED') continue;
    if (a.harness_id && antigravity.has(a.harness_id)) continue;
    taken.add(a.agent_key);
  }
  return taken;
}

/** What the person types once Antigravity is open on the folder: the command of the skill the setup writes. */
export const ANTIGRAVITY_FIRST_PROMPT = '/friday';

/** The same request in words, for an Antigravity that does not show the command. */
export const ANTIGRAVITY_FALLBACK_PROMPT = 'Call friday_whoami and take your Friday task.';

/** Why there is no Start button, in the dialog and on the agents drawer's card. */
export const ANTIGRAVITY_ATTACH_NOTE =
  'You open Antigravity yourself. Its terms do not let another program start it on a personal account, so Friday gives it tasks, checks what it does and verifies the work, but never launches it.';

/** "Antigravity CLI 1.4.4 and the Antigravity App 2.0.1", or null when neither was found. */
export function foundText(found: AntigravitySetupPlan['antigravity']): string | null {
  const parts = [
    found?.cli ? `Antigravity CLI ${plain(found.cli.version ?? '(version unknown)', 40)}` : null,
    found?.app ? `the Antigravity App ${plain(found.app.version ?? '(version unknown)', 40)}` : null,
  ].filter((x): x is string => !!x);
  return parts.length ? parts.join(' and ') : null;
}

export function antigravitySetupModal(
  ctx: AppContext,
  _request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  let plan: AntigravitySetupPlan | null = null;
  let busy = false;

  const key = input({ class: 'input mono', value: ANTIGRAVITY_SETUP_KEY, maxLength: 64 });
  const keyField = field('Agent key', key, {
    hint: 'the name Antigravity works under in Friday; each connected app needs its own',
  });
  const previewBtn = button([icon('eye', 14), 'Preview'], () => void preview(), { class: 'btn' });
  const applyBtn = button([icon('check', 14), 'Apply'], () => void apply(), {
    class: 'btn btn-primary',
    disabled: true,
  });
  const planBox = h('div', { class: 'pn-setup-plan', aria: { live: 'polite' } });
  const resultBox = h('div', { class: 'pn-setup-result', aria: { live: 'polite' } });
  const serverError = h('div', { class: 'field-error pn-server-error', hidden: true, role: 'alert' });

  key.addEventListener('input', () => {
    plan = null;
    replace(planBox);
    update();
  });

  function agentKey(): string {
    return key.value.trim();
  }

  function update() {
    const shaped = AGENT_KEY_RE.test(agentKey());
    // A name another app works under would make one of the two a shadow that can take no task.
    const taken = shaped && namesTakenByOthers(ctx.store.select('board')).has(agentKey());
    const ok = shaped && !taken;
    keyField.setError(
      taken
        ? `${visible(agentKey())} is the name another agent works under; choose another, or the two cannot both take tasks`
        : shaped || !agentKey()
          ? null
          : 'use lowercase letters, digits and dashes, starting with a letter or digit',
    );
    previewBtn.disabled = busy || !ok;
    applyBtn.disabled = busy || !ok || !plan;
  }

  function showServer(message: string | null) {
    serverError.hidden = !message;
    serverError.textContent = message ?? '';
  }

  function renderPlan(p: AntigravitySetupPlan) {
    const changes = Array.isArray(p.changes) ? p.changes : [];
    const found = foundText(p.antigravity);
    replace(
      planBox,
      found
        ? h(
            'div',
            { class: 'muted' },
            `${found} found (hooks ${plain(p.antigravity?.hook_level ?? 'unknown', 20)}; experimental).`,
          )
        : h(
            'div',
            { class: 'hidden-warning' },
            'Friday did not find Antigravity on this machine; install it before the steps in Antigravity.',
          ),
      p.applied ? note('This setup is already applied; applying again rewrites the same files.') : null,
      changes.length === 0
        ? h('div', { class: 'muted' }, 'Nothing to change.')
        : h('ul', { class: 'pn-list pn-changes-files' }, changes.map(changeView)),
    );
  }

  async function preview() {
    if (busy) return;
    busy = true;
    showServer(null);
    update();
    const k = agentKey();
    const r = await actWithError(
      ctx,
      'Preview the setup',
      () => ctx.api.antigravitySetupPlan(k),
      (e) => showServer(`${e.code ? `${e.code}: ` : ''}${plain(e.message, 1000)}`),
    );
    busy = false;
    if (td.done) return;
    plan = r ?? null;
    if (plan) renderPlan(plan);
    update();
  }

  async function apply() {
    if (busy || !plan) return;
    const ok = await ctx.confirm({
      title: 'Apply the Antigravity setup?',
      body: applyWarning(Array.isArray(plan.changes) ? plan.changes : [], 'Antigravity'),
      confirmLabel: 'Apply',
    });
    if (!ok || td.done) return;
    busy = true;
    showServer(null);
    update();
    const k = agentKey();
    const r = await actWithError(
      ctx,
      'Apply the setup',
      () => ctx.api.antigravitySetupApply(k),
      (e) => showServer(`${e.code ? `${e.code}: ` : ''}${plain(e.message, 1000)}`),
      'Antigravity is set up',
    );
    busy = false;
    if (td.done) return;
    update();
    if (r) renderResult(r);
  }

  function renderResult(r: AntigravitySetupResult) {
    const root = ctx.store.select('board')?.project.root ?? '';
    replace(
      resultBox,
      section('Is it connected?', setupChecksView(r.doctor, 'Antigravity')),
      section(
        'Then, in Antigravity',
        h(
          'ol',
          { class: 'pn-steps' },
          h(
            'li',
            null,
            `Open this project folder in Antigravity yourself (the App, the IDE, or agy in a terminal)${root ? ':' : '.'}`,
            root ? copyLine(ctx, root, 'folder path') : null,
          ),
          h('li', null, 'Trust the folder when Antigravity asks: Friday’s hooks run only in a trusted folder.'),
          h('li', null, 'Allow the friday tools when Antigravity asks to use them.'),
          h(
            'li',
            null,
            'Type this to take your Friday task (each time is one task; type it again for the next):',
            copyLine(ctx, ANTIGRAVITY_FIRST_PROMPT, 'first prompt'),
            h(
              'div',
              { class: 'muted' },
              `If Antigravity does not know the command, say: “${ANTIGRAVITY_FALLBACK_PROMPT}”`,
            ),
          ),
        ),
        note(
          `Antigravity then works as ${visible(agentKey())}; it shows in the Agents list as “attached in Antigravity”. If Antigravity is open already, close it and open it again so it takes the name.`,
        ),
      ),
    );
    if (r.plan) renderPlan(r.plan);
  }

  const el = panel(
    'pn-antigravity-setup',
    note(
      'Friday writes Antigravity’s project files (its MCP server, its hooks and Friday’s guidance in AGENTS.md) so a session you open on this folder works through Friday. Preview first: nothing changes until you apply.',
    ),
    note(ANTIGRAVITY_ATTACH_NOTE),
    keyField.el,
    h('div', { class: 'pn-actions pn-actions-start' }, previewBtn, applyBtn),
    serverError,
    planBox,
    resultBox,
    h(
      'div',
      { class: 'pn-actions' },
      button('Close', () => close(), { class: 'btn btn-ghost' }),
    ),
  );
  update();

  return {
    title: 'Connect Antigravity',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
