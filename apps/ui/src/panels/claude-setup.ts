/**
 * Claude Code in VS Code (plan §5.10, §7.7): preview every file `harness config claude-code`
 * would write (and whether git tracks it), apply it on confirm, say whether it is connected and
 * what needs attention (setup-checks.ts), then the steps in VS Code: open the folder, accept the folder-trust and MCP prompts, type
 * `/friday start`.
 */
import type { ClaudeSetupChange, ClaudeSetupPlan, ClaudeSetupResult } from '@friday/protocol';
import { visible } from '../model/text.js';
import type { AppContext, Component, ModalRequest } from '../shell/context.js';
import { button, h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import {
  actWithError,
  agentText,
  badge,
  copyLine,
  field,
  input,
  note,
  panel,
  pathText,
  plain,
  section,
  Teardown,
} from './common.js';
import { doctorTone, setupChecksView } from './setup-checks.js';
import { AGENT_KEY_RE } from './start-agent.js';

export { doctorTone };

export const DEFAULT_SETUP_KEY = 'dev-1';

/** The confirmation's lines: tracked files are named, since they change for everyone who pulls. */
export function applyWarning(changes: readonly ClaudeSetupChange[], host = 'Claude Code'): string[] {
  const tracked = changes.filter((c) => c.tracked);
  const lines = [
    `Friday writes ${changes.length === 1 ? '1 file' : `${changes.length} files`} for ${host} in this project.`,
  ];
  if (tracked.length) {
    lines.push(`Git tracks ${tracked.length === 1 ? 'this one' : 'these'}, so the change shows in your next commit:`);
    for (const c of tracked) lines.push(`  ${visible(c.path)}`);
  } else lines.push('None of them is tracked by git.');
  return lines;
}

/** One file of a setup plan: what happens to it, whether git tracks it, and its diff. */
export function changeView(c: ClaudeSetupChange): HTMLElement {
  return h(
    'li',
    { class: 'pn-item pn-change' },
    h(
      'div',
      { class: 'row' },
      badge(plain(c.action, 30) || 'change', 'info'),
      pathText(c.path, 'pn-grow'),
      c.tracked ? badge('tracked by git', 'warn') : badge('not tracked', 'muted'),
    ),
    c.note ? h('div', { class: 'muted' }, plain(c.note, 600)) : null,
    c.diff ? agentText(c.diff, 'pre') : null,
  );
}

export function claudeSetupModal(
  ctx: AppContext,
  _request: ModalRequest,
  close: () => void,
): Component & { title: string; size: 'md' } {
  const td = new Teardown();
  let plan: ClaudeSetupPlan | null = null;
  let busy = false;

  const key = input({ class: 'input mono', value: DEFAULT_SETUP_KEY, maxLength: 64 });
  const keyField = field('Agent key', key, { hint: 'the agent this Claude Code session works as' });
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

  function renderPlan(p: ClaudeSetupPlan) {
    const changes = Array.isArray(p.changes) ? p.changes : [];
    replace(
      planBox,
      p.claude_code
        ? h('div', { class: 'muted' }, `Claude Code ${plain(p.claude_code.version, 40)} found.`)
        : h(
            'div',
            { class: 'hidden-warning' },
            'Friday did not find Claude Code on this machine; install it before the VS Code steps.',
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
      () => ctx.api.claudeSetupPlan(k),
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
      title: 'Apply the Claude Code setup?',
      body: applyWarning(Array.isArray(plan.changes) ? plan.changes : []),
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
      () => ctx.api.claudeSetupApply(k),
      (e) => showServer(`${e.code ? `${e.code}: ` : ''}${plain(e.message, 1000)}`),
      'Claude Code is set up',
    );
    busy = false;
    if (td.done) return;
    update();
    if (r) renderResult(r);
  }

  function renderResult(r: ClaudeSetupResult) {
    const root = ctx.store.select('board')?.project.root ?? '';
    replace(
      resultBox,
      section('Is it connected?', setupChecksView(r.doctor, 'Claude Code')),
      section(
        'Then, in VS Code',
        h(
          'ol',
          { class: 'pn-steps' },
          h(
            'li',
            null,
            'Open this project folder in VS Code',
            root ? [': ', pathText(root)] : '.',
            root
              ? button('Open in VS Code', () => ctx.platform.openInEditor(root), { class: 'btn btn-ghost pn-link' })
              : null,
          ),
          h('li', null, 'Accept the folder-trust prompt, then the prompt that asks to use the MCP server "friday".'),
          h('li', null, 'In the Claude Code panel, type:', copyLine(ctx, '/friday start', 'start command')),
        ),
        note(
          `Claude Code then works as ${visible(agentKey())}; it shows in the Agents list as “connected from VS Code”.`,
        ),
      ),
    );
    if (r.plan) renderPlan(r.plan);
  }

  const el = panel(
    'pn-claude-setup',
    note(
      'Friday writes Claude Code’s project settings so that a session you open in VS Code works through Friday: it takes its tasks from Friday, and Friday sees and checks what it does. Preview first: nothing changes until you apply.',
    ),
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
    title: 'Set up Claude Code in VS Code',
    size: 'md',
    el,
    destroy() {
      td.run();
      el.remove();
    },
  };
}
