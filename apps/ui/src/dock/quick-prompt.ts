/**
 * The Notch's quick prompt (plan FD-14, §7.6, ERRATA F21): one line that runs a fixed set of
 * commands and otherwise offers to create a goal from the text. It never claims to understand free
 * language. `approve` and `deny` name the approval first; only a second `Enter` on the unchanged
 * line decides it, and only while the waiting approvals are the ones that were shown (FD-28).
 */
import { hasHidden } from '../model/text.js';
import { type AppContext, type Component, openDrawer } from '../shell/context.js';
import { h, replace } from '../ui/dom.js';
import { icon } from '../ui/svg.js';
import { openHalt, pauseFriday, pauseText, resumeFriday, resumeText } from './actions.js';
import {
  checkProposal,
  type DecisionProposal,
  findTask,
  HELP,
  parseQuickPrompt,
  proposeDecision,
  statusLine,
} from './quick-prompt-parse.js';

type Tone = 'hint' | 'ok' | 'error' | 'ask';

type Pending = { type: 'decision'; proposal: DecisionProposal; hidden: boolean } | { type: 'goal'; text: string };

export interface QuickPromptOptions {
  /** Called after a command ran (the Notch folds the card); not while a proposal waits for Enter. */
  onDone?: () => void;
}

let counter = 0;

export const QUICK_PLACEHOLDER = 'pause, status, approve, open <task>, goal <text>…';

export function quickPrompt(ctx: AppContext, opts: QuickPromptOptions = {}): Component {
  const feedbackId = `dk-qp-feedback-${++counter}`;
  const input = h('input', {
    class: 'input dk-qp-input',
    type: 'text',
    placeholder: QUICK_PLACEHOLDER,
    autocomplete: 'off',
    spellcheck: false,
    maxLength: 2000,
    aria: { label: 'Quick prompt: a Friday command, or a goal to create', describedby: feedbackId },
  });
  const feedback = h('div', { class: 'dk-qp-feedback', id: feedbackId, role: 'status', aria: { live: 'polite' } });
  const el = h(
    'div',
    { class: 'dk-qp' },
    h('div', { class: 'dk-qp-row' }, h('span', { class: 'dk-qp-mark' }, icon('bolt', 14)), input),
    feedback,
  );

  let pending: Pending | null = null;
  let pendingText = '';
  let busy = false;
  let destroyed = false;

  function show(tone: Tone, ...content: (Node | string)[]): void {
    feedback.className = `dk-qp-feedback dk-qp-${tone}`;
    replace(feedback, ...content);
  }

  function clearFeedback(): void {
    feedback.className = 'dk-qp-feedback';
    replace(feedback);
  }

  function done(message: string): void {
    if (destroyed) return;
    input.value = '';
    pending = null;
    show('ok', message);
    opts.onDone?.();
  }

  function renderDecision(p: DecisionProposal, hidden: boolean): void {
    const verb = p.kind === 'approve' ? 'Approve once' : 'Deny';
    show(
      'ask',
      h(
        'span',
        { class: 'dk-qp-ask' },
        `${verb} `,
        h('code', { class: 'dk-qp-cap' }, p.capability),
        p.target !== null ? ' ' : '',
        p.target !== null ? h('span', { class: 'agent-text dk-qp-target' }, p.target) : '',
        ` (${p.approvalId})`,
        p.reason ? h('span', null, ' with the reason ', h('span', { class: 'agent-text dk-qp-target' }, p.reason)) : '',
        '? ',
        h('strong', null, 'Press Enter again'),
      ),
      hidden ? h('span', { class: 'hidden-warning dk-qp-warning' }, 'Hidden characters are shown as ⟨U+…⟩.') : '',
    );
  }

  async function createGoal(text: string): Promise<void> {
    const board = ctx.store.select('board');
    const plan = board?.brain?.planner_available ?? false;
    const r = await ctx.act(
      'Create a goal',
      () => ctx.api.createGoal({ request: text, constraints: [], outcomes: [], priority: 'normal', plan }),
      plan ? 'Goal created: the Master Brain plans it' : 'Goal created: write its plan in the Studio',
    );
    if (r) {
      ctx.refresh();
      done('Goal created.');
    } else show('error', 'The goal was not created.');
  }

  async function confirmPending(p: Pending): Promise<void> {
    pending = null;
    if (p.type === 'goal') {
      await createGoal(p.text);
      return;
    }
    const proposal = p.proposal;
    const refusal = checkProposal(proposal, ctx.store.select('board'), ctx.now());
    if (refusal) {
      show('error', refusal);
      return;
    }
    if (proposal.kind === 'approve') {
      const r = await ctx.act(
        'Approve',
        () => ctx.api.approve(proposal.approvalId, 'once'),
        `Approved once: ${proposal.approvalId}`,
      );
      if (!r) return show('error', 'Nothing was approved.');
      ctx.react('approved', proposal.capability);
      ctx.refresh();
      done(`Approved once: ${proposal.approvalId}`);
    } else {
      const r = await ctx.act(
        'Deny',
        () => ctx.api.reject(proposal.approvalId, proposal.reason ?? undefined),
        `Denied: ${proposal.approvalId}`,
      );
      if (!r) return show('error', 'Nothing was denied.');
      ctx.react('denied', proposal.capability);
      ctx.refresh();
      done(`Denied: ${proposal.approvalId}`);
    }
  }

  async function submit(): Promise<void> {
    const text = input.value;
    if (pending && text === pendingText) {
      await confirmPending(pending);
      return;
    }
    pending = null;
    const cmd = parseQuickPrompt(text);
    switch (cmd.kind) {
      case 'empty':
        show('hint', HELP);
        return;
      case 'pause': {
        const r = await pauseFriday(ctx);
        if (r) done(pauseText(r));
        return;
      }
      case 'resume': {
        const board = ctx.store.select('board');
        const r = await resumeFriday(ctx);
        if (r) done(resumeText(board));
        return;
      }
      case 'halt':
        openHalt(ctx);
        done('The halt dialog is open.');
        return;
      case 'status': {
        const s = statusLine(ctx.store.select('board'), ctx.now());
        ctx.toast({ kind: 'info', text: s.text, ...(s.detail ? { detail: s.detail } : {}) });
        done(s.text);
        return;
      }
      case 'approve':
      case 'deny': {
        const r = proposeDecision(
          cmd.kind,
          ctx.store.select('board'),
          ctx.now(),
          cmd.kind === 'deny' ? cmd.reason : null,
        );
        if (!r.ok) return show('error', r.message);
        const raw = ctx.store.select('board')?.approvals.find((a) => a.approval_id === r.proposal.approvalId);
        const hidden =
          !!raw &&
          (hasHidden(raw.capability) ||
            hasHidden(raw.target ?? '') ||
            (cmd.kind === 'deny' && hasHidden(cmd.reason ?? '')));
        pending = { type: 'decision', proposal: r.proposal, hidden };
        pendingText = text;
        renderDecision(r.proposal, hidden);
        return;
      }
      case 'open': {
        const found = findTask(ctx.store.select('board'), cmd.ref);
        if (!found.ok) return show('error', found.message);
        ctx.store.patch('ui', { selectedTaskId: found.taskId });
        openDrawer(ctx, { kind: 'inspector', id: found.taskId });
        done(`Opened ${found.taskId}`);
        return;
      }
      case 'start': {
        const role = cmd.role ?? 'developer';
        const r = await ctx.act(
          `Start ${cmd.agentKey}`,
          () => ctx.api.launchAgent({ host: cmd.host, agent_key: cmd.agentKey, role }),
          `Starting ${cmd.agentKey} (${cmd.host}, ${role})`,
        );
        if (r) {
          ctx.refresh();
          done(`Starting ${cmd.agentKey} (${cmd.host}, ${role}).`);
        } else show('error', `${cmd.agentKey} was not started.`);
        return;
      }
      case 'goal':
        await createGoal(cmd.text);
        return;
      case 'propose-goal':
        pending = { type: 'goal', text: cmd.text };
        pendingText = text;
        show(
          'ask',
          h(
            'span',
            { class: 'dk-qp-ask' },
            'Not a command. Create a goal: ',
            h('span', { class: 'dk-qp-goal' }, cmd.text),
            '? ',
            h('strong', null, 'Press Enter'),
          ),
          h('span', { class: 'dk-qp-help' }, HELP),
        );
        return;
      case 'invalid':
        show('error', cmd.message);
        return;
    }
  }

  async function onEnter(): Promise<void> {
    if (busy) return;
    busy = true;
    el.classList.add('dk-qp-busy');
    try {
      await submit();
    } finally {
      busy = false;
      el.classList.remove('dk-qp-busy');
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.isComposing) return;
    if (event.key === 'Enter') {
      // The prompt owns Enter: it never reaches an approval card's keys (plan FD-28).
      event.preventDefault();
      event.stopPropagation();
      void onEnter();
    } else if (event.key === 'Escape' && (input.value || pending)) {
      event.preventDefault();
      event.stopPropagation();
      input.value = '';
      pending = null;
      clearFeedback();
    }
  }

  function onInput(): void {
    if (pending && input.value !== pendingText) {
      pending = null;
      clearFeedback();
    }
  }

  input.addEventListener('keydown', onKey);
  input.addEventListener('input', onInput);

  return {
    el,
    destroy() {
      destroyed = true;
      input.removeEventListener('keydown', onKey);
      input.removeEventListener('input', onInput);
      el.remove();
    },
  };
}
