/**
 * Connect Antigravity: preview every file `harness config antigravity` would write (and whether git
 * tracks it), apply it on confirm, show the doctor's answer, then the steps in Antigravity: open
 * the folder yourself, trust it, allow the friday tools, and ask the agent to take its task.
 *
 * Antigravity only attaches. Its terms keep a personal account to the Antigravity the person runs
 * themselves, so this dialog has no Start button and Friday never launches it: the dialog says so
 * instead of leaving the missing button unexplained.
 */
import type { AntigravitySetupPlan, AntigravitySetupResult } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { applyWarning, changeView, DEFAULT_SETUP_KEY, doctorTone } from './claude-setup.js';
import { actWithError, badge, copyLine, field, input, note, panel, plain, section, Teardown } from './common.js';
import { AGENT_KEY_RE } from './start-agent.js';

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

  const key = input({ class: 'input mono', value: DEFAULT_SETUP_KEY, maxLength: 64 });
  const keyField = field('Agent key', key, { hint: 'the agent this Antigravity session works as' });
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
    const ok = AGENT_KEY_RE.test(agentKey());
    keyField.setError(
      ok || !agentKey() ? null : 'use lowercase letters, digits and dashes, starting with a letter or digit',
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
    const doctor = r.doctor;
    const checks = Array.isArray(doctor?.checks) ? doctor.checks : [];
    const root = ctx.store.select('board')?.project.root ?? '';
    replace(
      resultBox,
      section(
        'What the doctor says',
        doctor && !doctor.error
          ? h(
              'div',
              null,
              doctor.achieved
                ? h(
                    'div',
                    { class: 'row' },
                    h('span', { class: 'field-label' }, 'Enforcement'),
                    badge(plain(String(doctor.achieved), 30), 'info'),
                  )
                : null,
              h(
                'ul',
                { class: 'pn-list' },
                checks.map((c) =>
                  h(
                    'li',
                    { class: 'pn-item' },
                    badge(plain(c.status, 20), doctorTone(c.status)),
                    h('span', { class: 'mono' }, plain(c.id, 120)),
                    c.message ? h('span', { class: 'muted pn-grow' }, plain(c.message, 600)) : null,
                    c.fix ? h('div', { class: 'muted' }, `Fix: ${plain(c.fix, 400)}`) : null,
                  ),
                ),
              ),
            )
          : h(
              'div',
              { class: 'muted' },
              doctor?.error ? `The doctor gave no answer: ${plain(doctor.error, 400)}` : 'The doctor gave no answer.',
            ),
      ),
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
          `Antigravity then works as ${visible(agentKey())}; it shows in the agents drawer as “attached in Antigravity”.`,
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
