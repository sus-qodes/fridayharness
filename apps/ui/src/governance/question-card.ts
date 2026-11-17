/**
 * Question cards act by kind (plan FD-21, §7.5). An agent's question and `ambiguous_intent` get
 * option chips (keys 1–4 and arrows while the card has focus), a reply box (typing selects it) and
 * Send (`Ctrl+Enter`), which composes `Selected: …` and `Note: …`; Later folds the card; Let the
 * agent decide answers "No preference; use your judgement". Every other kind gets the buttons that
 * do the work — recover, explain and pin routing, integrate again, revise the plan, rework, cancel —
 * and Friday settles the question when its cause is resolved (plan §5.7). The option strings of
 * Friday's own kinds are CLI instructions: never choices, at most small print. Every box a person
 * types an answer into is labelled "Reply to <agent>": one wording for one act.
 */

import type { EscalationView, RoutingOfferView } from '@friday/protocol';
import { classifyEscalation, composeAnswer, LET_AGENT_DECIDE, type QuestionSpec } from '../model/escalations.js';
import { blockSentence, hostBlocks, hostName, liftLabel } from '../model/host-blocks.js';
import { defaultModel, hostLabel, modelLabel, modelName, usableModels } from '../model/models.js';
import { fixedInSettings, PLANNER_FAILURES, plannerTrouble, plannerTroubleWords } from '../model/planner-words.js';
import { kindWord, routingBlockWords } from '../model/routing-words.js';
import { hasHidden, visible } from '../model/text.js';
import { cancelTask } from '../shell/cancel-task.js';
import { type AppContext, type Component, openDrawer, openModal } from '../shell/context.js';
import { append, button, h, replace, setText } from '../ui/dom.js';
import { cleanText, stripEscapes, timeAgo, truncate } from '../ui/format.js';
import type { Binding } from '../ui/keys.js';
import { icon } from '../ui/svg.js';
import { ARMING_TEXT, type ArmingController, armDecisions, type Clock } from './arming.js';
import { agentKeyOf, agentText, decisionText, HIDDEN_WARNING, nextId, taskLine, taskOf } from './common.js';

export interface QuestionCardOptions {
  /** The Notch's smaller card. */
  compact?: boolean;
  /** "Later": the Notch folds the card, the Studio closes it. The question stays pending. */
  onLater?: () => void;
  /** After the question was answered or acted on from this card. */
  onDone?: () => void;
  clock?: Clock;
}

interface Built {
  body: HTMLElement[];
  /** Decision buttons the card arms. */
  decisions: HTMLButtonElement[];
  /** Keys while focus is inside the card. */
  bindings?: Binding[];
}

interface Kit {
  ctx: AppContext;
  e: EscalationView;
  spec: QuestionSpec;
  arming: () => ArmingController;
  status: HTMLElement;
  done: (text: string) => void;
  opts: QuestionCardOptions;
}

function askerText(ctx: AppContext, e: EscalationView, spec: QuestionSpec): string {
  if (spec.asker === 'agent') return agentKeyOf(ctx.store.select('board'), e.requested_by_id) ?? 'an agent';
  if (spec.asker === 'master_brain') return 'the Master Brain';
  return 'Friday';
}

/** The label of a reply box: who reads what is typed there, with visible escapes. */
export function replyLabel(to: string): string {
  return `Reply to ${visible(to)}`;
}

export function questionCard(ctx: AppContext, escalation: EscalationView, opts: QuestionCardOptions = {}): Component {
  const e = escalation;
  const board = ctx.store.select('board');
  const spec = classifyEscalation(e, { plannerAvailable: !!board?.brain?.planner_available });
  const titleId = nextId('question-title');
  const hint = h('div', { class: 'gv-arming-hint', aria: { live: 'polite' } }, ARMING_TEXT);
  const status = h('div', { class: 'gv-status', role: 'status', aria: { live: 'polite' } });
  let popScope: (() => void) | null = null;
  let settled = false;

  const el = h('section', {
    class: ['gv-card', 'gv-question', `gv-question-${spec.card}`, opts.compact && 'gv-compact'],
    role: 'group',
    aria: { labelledby: titleId },
    dataset: { escalationId: e.escalation_id, kind: e.kind ?? 'agent' },
  });

  let arming: ArmingController | null = null;
  const kit: Kit = {
    ctx,
    e,
    spec,
    arming: () => arming as ArmingController,
    status,
    opts,
    done: (text) => {
      settled = true;
      setText(status, text);
      for (const b of built.decisions) b.disabled = true;
      ctx.refresh();
      opts.onDone?.();
    },
  };

  const head = h(
    'header',
    { class: 'gv-card-head' },
    h('span', { class: 'gv-card-icon gv-tone-question' }, icon('question', 16)),
    h('h3', { class: 'gv-card-title', id: titleId }, spec.title),
    h('span', { class: 'spacer' }),
    h('span', { class: 'gv-age muted' }, timeAgo(e.created_at, ctx.now())),
  );
  const from = h(
    'p',
    { class: 'gv-from' },
    'From ',
    h('strong', { class: 'mono' }, visible(askerText(ctx, e, spec))),
    e.task_id ? [' · ', taskLine(board, e.task_id)] : null,
  );

  const built = buildBody(kit);
  const later = button('Later', () => opts.onLater?.(), { class: 'btn btn-ghost gv-later' });

  append(el, head, from, ...built.body, h('div', { class: 'gv-actions gv-actions-end' }, later), hint, status);
  arming = armDecisions(el, {
    key: JSON.stringify([e.escalation_id, e.question, e.options, e.kind]),
    hint,
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  for (const b of built.decisions) arming.register(b);

  const onFocusIn = (): void => {
    if (popScope || !built.bindings?.length || settled) return;
    popScope = ctx.keys.push({ name: 'question-card', bindings: built.bindings });
  };
  const onFocusOut = (ev: FocusEvent): void => {
    const next = ev.relatedTarget as Node | null;
    if (next && el.contains(next)) return;
    popScope?.();
    popScope = null;
  };
  el.addEventListener('focusin', onFocusIn);
  el.addEventListener('focusout', onFocusOut as EventListener);

  return {
    el,
    destroy(): void {
      popScope?.();
      popScope = null;
      arming?.destroy();
      el.removeEventListener('focusin', onFocusIn);
      el.removeEventListener('focusout', onFocusOut as EventListener);
      el.remove();
    },
  };
}

// ---------------------------------------------------------------------------------------------

/** The elements that exist (builders return null for what does not apply). */
function present(items: (HTMLElement | null)[]): HTMLElement[] {
  return items.filter((x): x is HTMLElement => x !== null);
}

function buildBody(kit: Kit): Built {
  switch (kit.spec.card) {
    case 'free':
      return freeBody(kit);
    case 'recovery':
      return recoveryBody(kit);
    case 'routing':
      // A task with no agent to run it gets the card that leads with "Run it on …"; a host that ran
      // a model its constraints forbid keeps the card that explains and pins.
      return kit.spec.kind === 'routing_blocked' ? routingBlockedBody(kit) : routingBody(kit);
    case 'integration':
      return integrationBody(kit);
    case 'unanswered':
      return unansweredBody(kit);
    case 'setup':
      return setupBody(kit);
    case 'brain':
      return brainBody(kit);
  }
}

/** The question, why, proposed action and evidence. */
function context(spec: QuestionSpec): HTMLElement[] {
  // What the human answers: shown with hidden characters marked, never silently shortened (FD-28).
  const out: HTMLElement[] = [];
  out.push(h('p', { class: 'gv-question-text' }, decisionText(spec.question)));
  if (spec.why) out.push(h('p', { class: 'gv-why' }, h('span', { class: 'gv-k' }, 'Why: '), decisionText(spec.why)));
  if (spec.proposedAction)
    out.push(
      h('p', { class: 'gv-why' }, h('span', { class: 'gv-k' }, 'Proposed: '), decisionText(spec.proposedAction)),
    );
  if (spec.evidence.length)
    out.push(
      h(
        'details',
        { class: 'gv-evidence' },
        h('summary', null, `Evidence (${spec.evidence.length})`),
        h('ul', null, ...spec.evidence.slice(0, 8).map((x) => h('li', null, truncate(decisionText(x), 500)))),
      ),
    );
  const seen = [spec.question, spec.why, spec.proposedAction, ...spec.evidence].filter((x): x is string => !!x);
  if (seen.some((x) => hasHidden(stripEscapes(x))))
    out.push(h('div', { class: 'hidden-warning', role: 'note' }, HIDDEN_WARNING));
  return out;
}

/** The CLI instructions of a system kind, as small print (never as choices). */
function cliHints(spec: QuestionSpec): HTMLElement | null {
  if (!spec.cliHints.length) return null;
  return h(
    'details',
    { class: 'gv-cli' },
    h('summary', null, 'What the CLI would do'),
    h('ul', null, ...spec.cliHints.map((x) => h('li', { class: 'mono' }, truncate(visible(x), 300)))),
  );
}

async function answer(kit: Kit, text: string, sent: string, button?: HTMLButtonElement): Promise<boolean> {
  if (!text.trim()) return false;
  if (button) button.disabled = true;
  setText(kit.status, 'Sending…');
  const r = await kit.ctx.act('Answer the question', () => kit.ctx.api.answer(kit.e.escalation_id, text));
  if (r === undefined) {
    if (button) button.disabled = false;
    setText(kit.status, '');
    return false;
  }
  kit.done(sent);
  return true;
}

function decisionButton(
  label: string,
  kit: Kit,
  run: (b: HTMLButtonElement) => void | Promise<void>,
  cls = 'btn',
): HTMLButtonElement {
  const b = button(label, () => undefined, { class: `${cls} gv-decide` });
  b.addEventListener('click', (ev) => {
    if (b.disabled) return;
    kit.arming().guard(() => void run(b))(ev);
  });
  return b;
}

// ---- an agent's question and ambiguous_intent

function freeBody(kit: Kit): Built {
  const { spec } = kit;
  let selected: number | null = null;
  const groupId = nextId('choices');
  const chips = spec.choices.map((option, i) => {
    const chip = h(
      'button',
      {
        type: 'button',
        class: 'gv-chip',
        role: 'radio',
        aria: { checked: 'false' },
        tabIndex: i === 0 ? 0 : -1,
        dataset: { index: String(i) },
      },
      i < 4 ? h('span', { class: 'kbd', aria: { hidden: 'true' } }, String(i + 1)) : null,
      h('span', { class: 'gv-chip-text' }, visible(option)),
    );
    chip.addEventListener('click', () => select(i));
    return chip;
  });
  const noteId = nextId('write-in');
  const note = h('textarea', {
    class: 'textarea gv-write-in',
    id: noteId,
    rows: 2,
    maxLength: 4000,
    placeholder: spec.choices.length ? 'Or write your own answer…' : 'Your answer…',
  });
  const send = decisionButton(
    'Send',
    kit,
    async (b) => {
      const text = composeAnswer(selected === null ? null : (spec.choices[selected] ?? null), note.value);
      if (!text) {
        setText(kit.status, 'Pick an option or write an answer first.');
        return;
      }
      await answer(kit, text, 'Answer sent', b);
    },
    'btn btn-primary',
  );
  send.append(' ', h('span', { class: 'kbd', aria: { hidden: 'true' } }, 'Ctrl+Enter'));
  send.setAttribute('aria-keyshortcuts', 'Control+Enter');
  const letDecide = decisionButton('Let the agent decide', kit, async (b) => {
    await answer(kit, LET_AGENT_DECIDE, 'The agent decides', b);
  });

  const select = (i: number | null): void => {
    selected = i;
    chips.forEach((c, j) => {
      c.setAttribute('aria-checked', j === i ? 'true' : 'false');
      c.classList.toggle('gv-chip-on', j === i);
      c.tabIndex = j === (i ?? 0) ? 0 : -1;
    });
    note.classList.toggle('gv-write-in-on', i === null && note.value.trim().length > 0);
  };
  // Typing in the write-in selects the write-in.
  note.addEventListener('input', () => {
    if (note.value.trim()) select(null);
    else note.classList.remove('gv-write-in-on');
  });

  const move = (delta: number) => () => {
    if (!chips.length) return;
    const from = selected ?? (delta > 0 ? -1 : 0);
    const next = (from + delta + chips.length) % chips.length;
    select(next);
    chips[next]?.focus();
  };

  const bindings = [
    ...chips.slice(0, 4).map((_, i) => ({ key: String(i + 1), run: () => select(i), description: `Option ${i + 1}` })),
    { key: 'ArrowDown', run: move(1) },
    { key: 'ArrowRight', run: move(1) },
    { key: 'ArrowUp', run: move(-1) },
    { key: 'ArrowLeft', run: move(-1) },
    { key: 'Enter', ctrl: true, inFields: true, run: () => send.click(), description: 'Send' },
  ];

  return {
    body: present([
      ...context(spec),
      chips.length
        ? h('div', { class: 'gv-chips', role: 'radiogroup', aria: { label: 'Options' }, id: groupId }, ...chips)
        : h('p', { class: 'muted gv-no-options' }, 'No options were given: write an answer.'),
      h(
        'div',
        { class: 'field gv-write-in-field' },
        h('label', { class: 'field-label', for: noteId }, replyLabel(askerText(kit.ctx, kit.e, spec))),
        note,
      ),
      h('div', { class: 'gv-actions' }, send, letDecide),
      waitingHint(kit),
    ]),
    decisions: [send, letDecide],
    bindings,
  };
}

/**
 * An agent that ended its turn to wait (plan FD-22): a spawned one continues in its session with the
 * answer as its next message; an attached session in an editor reads it when asked there.
 */
function waitingHint(kit: Kit): HTMLElement | null {
  const board = kit.ctx.store.select('board');
  const task = taskOf(board, kit.e.task_id);
  if (task?.status !== 'WAITING') return null;
  const harness = board?.harnesses.find((x) => x.harness_id === task.assigned_harness_id);
  const text =
    harness?.attach_mode === 'spawn'
      ? 'This agent stopped its turn to wait. Your answer starts it again in its session.'
      : 'This agent works in an editor. After answering, ask it there to check its Friday inbox.';
  return h('p', { class: 'field-hint' }, text);
}

// ---- recovery_needed

function recoveryBody(kit: Kit): Built {
  const { spec, ctx } = kit;
  const d = (kit.e.details ?? {}) as Record<string, unknown>;
  // The agent's host stopped the attempt at the agent's own spending limit (2026-11-17): one
  // button raises the limit and lets the task continue; the other ways stay behind "Other options".
  if (spec.taskId && d.reason === 'budget_exceeded' && d.scope === 'agent') {
    const taskId = spec.taskId;
    const raise = button(
      [icon('rework', 14), 'Raise the limit and continue…'],
      () => openModal(ctx, { kind: 'raise-limit', id: taskId }),
      { class: 'btn btn-primary' },
    );
    const other = button('Other options…', () => openModal(ctx, { kind: 'recover', id: taskId }), { class: 'btn' });
    return {
      body: present([
        ...context(spec),
        h(
          'p',
          { class: 'field-hint' },
          'Nothing runs again on its own here: another attempt at the same limit would stop at the same place.',
        ),
        h('div', { class: 'gv-actions' }, raise, other),
      ]),
      decisions: [],
    };
  }
  const recover = button(
    [icon('rework', 14), 'Recover…'],
    () => {
      if (spec.taskId) openModal(ctx, { kind: 'recover', id: spec.taskId });
    },
    { class: 'btn btn-primary' },
  );
  return {
    body: present([
      ...context(spec),
      typeof d.preserved_ref === 'string' ? agentText('Earlier work kept at', d.preserved_ref) : null,
      h(
        'p',
        { class: 'field-hint' },
        'The recovery dialog shows each option with why it is or is not available. The question closes once a recovery runs.',
      ),
      spec.taskId ? h('div', { class: 'gv-actions' }, recover) : null,
      cliHints(spec),
    ]),
    decisions: [],
  };
}

// ---- routing_blocked: who runs this task? (2026-11-17)

/**
 * A task routing does not let start. The card said the decision's own sentence, offered "Why" and a
 * list of every model id in the catalog (the dearest first, most of which no agent here could run),
 * and fixed one task at a time. It now says what is wrong in a person's words and leads with the way
 * out: give the task to a connected agent ("Run it on …"), which Friday follows with that agent's
 * model. Choosing a model, for this task or for every task of its kind, and the decision's own
 * words are one step further.
 */
function routingBlockedBody(kit: Kit): Built {
  const { spec, ctx } = kit;
  const taskId = spec.taskId ?? '';
  const d = (kit.e.details ?? {}) as Record<string, unknown>;
  const codes = Array.isArray(d.reason_codes) ? (d.reason_codes as unknown[]).filter((c) => typeof c === 'string') : [];
  const task = ctx.store.select('board')?.tasks.find((t) => t.task_id === taskId);
  const said = h('p', { class: 'gv-question-text' }, routingBlockWords(codes as string[]));
  const details = h(
    'details',
    { class: 'gv-details' },
    h('summary', null, 'Details'),
    h('p', { class: 'muted' }, decisionText(spec.question)),
  );
  const runOn = h(
    'div',
    { class: 'gv-run-on', aria: { live: 'polite' } },
    taskId ? h('p', { class: 'muted' }, 'Looking for an agent that can take it…') : null,
  );
  const whyBox = h('div', { class: 'gv-routing-why', hidden: true });
  const pinBox = h('div', { class: 'gv-pin', hidden: true });

  const give = (offer: RoutingOfferView): HTMLButtonElement => {
    const own = offer.attach_mode !== 'spawn';
    // What happens on the click is in the label: the arming of a decision owns the button's tooltip.
    const how = own ? ', your editor' : offer.free ? '' : ', busy now';
    const b = decisionButton(
      `${visible(offer.agent_key)} (${hostLabel(offer.host)}${how})`,
      kit,
      async (btn) => {
        btn.disabled = true;
        const r = await ctx.act('Give the task to an agent', () => ctx.api.assign(taskId, offer.agent_key));
        if (!r) {
          btn.disabled = false;
          return;
        }
        if (r.mode === 'assigned') {
          kit.done(`Given to ${visible(offer.agent_key)}: it starts now.`);
          return;
        }
        // Kept for the agent: the question closes by itself when the task starts there.
        ctx.refresh();
        setText(
          kit.status,
          own
            ? `Kept for ${visible(offer.agent_key)}: take it there, in ${hostLabel(offer.host)}, with /friday.`
            : `Kept for ${visible(offer.agent_key)}: it starts when that agent is free.`,
        );
      },
      'btn btn-primary',
    );
    return b;
  };

  const showOffers = (offers: RoutingOfferView[] | null): void => {
    if (offers === null) {
      // The answer did not come: the other ways below still work.
      replace(runOn);
      return;
    }
    const can = offers.filter((o) => !o.blocked);
    if (!can.length) {
      replace(
        runOn,
        h(
          'p',
          null,
          offers.length
            ? 'None of the connected agents can take it, whoever it is given to.'
            : 'No agent is connected that can take work.',
        ),
        h(
          'div',
          { class: 'gv-actions' },
          button('Start an agent', () => openModal(ctx, { kind: 'start-agent' }), { class: 'btn btn-primary' }),
        ),
      );
      return;
    }
    const buttons = can.slice(0, 6).map(give);
    for (const b of buttons) kit.arming().register(b);
    replace(runOn, h('p', { class: 'field-label' }, 'Run it on'), h('div', { class: 'gv-actions' }, ...buttons));
    kit.arming().check();
  };
  if (taskId) {
    ctx.api.get<RoutingExplain>(`/routing/explain/${encodeURIComponent(taskId)}`).then(
      (r) => showOffers(Array.isArray(r?.offers) ? r.offers : null),
      () => showOffers(null),
    );
  }

  const pinOpen = button(
    'Choose a model…',
    async () => {
      pinBox.hidden = false;
      replace(pinBox, h('p', { class: 'muted' }, 'Reading the models…'));
      const r = await ctx.act('Read the models', () => ctx.api.models());
      const models = usableModels(r?.models);
      if (!r || !models.length) {
        replace(
          pinBox,
          h(
            'p',
            { class: 'muted' },
            r ? 'Friday knows no model an agent here can run.' : 'The models could not be read.',
          ),
        );
        return;
      }
      const selectId = nextId('pin-model');
      const select = h(
        'select',
        { class: 'select gv-pin-select', id: selectId },
        ...models.map((m) => h('option', { value: m.id }, visible(modelLabel(m)))),
      );
      select.value = defaultModel(models);
      const allId = nextId('pin-all');
      const all = h('input', { type: 'checkbox', id: allId });
      const pin = decisionButton(
        'Use this model',
        kit,
        async (b) => {
          const model = select.value;
          if (!model) return;
          const kind = all.checked && task?.kind ? task.kind : null;
          b.disabled = true;
          const ok = await ctx.act(
            'Choose a model',
            () =>
              ctx.api.pin(
                kind
                  ? { scope: 'kind', target: kind, model, note: 'chosen for a task that had no agent' }
                  : { scope: 'task', target: taskId, model, note: 'chosen for a task that had no agent' },
              ),
            kind ? `${modelName(model)} for every ${kindWord(kind)} task` : `${modelName(model)} for this task`,
          );
          b.disabled = false;
          if (ok) kit.done(`${modelName(model)} is chosen; the question closes when the task starts.`);
        },
        'btn btn-primary',
      );
      kit.arming().register(pin);
      replace(
        pinBox,
        h('label', { class: 'field-label', for: selectId }, 'Model'),
        h('div', { class: 'row' }, select, pin),
        task?.kind
          ? h(
              'label',
              { class: 'check gv-pin-all', for: allId },
              all,
              h('span', null, `Use it for every ${kindWord(task.kind)} task, not only this one`),
            )
          : null,
        h(
          'p',
          { class: 'muted gv-pin-home' },
          'Only an agent that can run the model takes the work. Choices are kept in Settings → Models.',
        ),
      );
      kit.arming().check();
    },
    { class: 'btn' },
  );
  const why = button(
    'Why',
    async () => {
      whyBox.hidden = false;
      replace(whyBox, h('p', { class: 'muted' }, 'Asking routing…'));
      const r = await ctx.act('Explain routing', () =>
        ctx.api.get<RoutingExplain>(`/routing/explain/${encodeURIComponent(taskId)}`),
      );
      replace(whyBox, r ? explainView(r) : h('p', { class: 'muted' }, 'Routing did not answer.'));
    },
    { class: 'btn btn-ghost' },
  );
  const cancel = cancelTaskButton(kit);
  const blockRows = hostBlockRows(kit);
  return {
    body: present([
      said,
      ...blockRows,
      taskId ? runOn : null,
      taskId ? h('div', { class: 'gv-actions' }, pinOpen, why, cancel) : null,
      pinBox,
      whyBox,
      details,
    ]),
    decisions: [cancel],
  };
}

/** A host that is kept out (not signed in, a limit), each with the button that tries it again. */
function hostBlockRows(kit: Kit): HTMLElement[] {
  const { ctx } = kit;
  return hostBlocks(ctx.store.select('board')).map((b) => {
    const lift = button(
      liftLabel(b),
      async () => {
        lift.disabled = true;
        const done = await ctx.act(
          b.kind === 'sign_in' ? 'Try the sign-in again' : 'Try the host again',
          () => ctx.api.clearReadiness(b.host, b.model),
          `${hostName(b.host)} is tried again with the next task`,
        );
        if (done) {
          ctx.refresh();
          kit.status.textContent = 'Friday offers the task again now; this question closes when it starts.';
        } else lift.disabled = false;
      },
      { class: b.kind === 'sign_in' ? 'btn btn-primary' : 'btn' },
    );
    return h(
      'div',
      { class: 'gv-host-block', dataset: { host: b.host, kind: b.kind } },
      h('p', null, blockSentence(b)),
      h('div', { class: 'gv-actions' }, lift),
    );
  });
}

// ---- routing_violated

interface RoutingExplain {
  /** The connected agents the task could be given to, and whether it would start there. */
  offers?: RoutingOfferView[];
  dry_run?: {
    blocked?: boolean;
    reason?: string;
    source?: string;
    model?: string | null;
    constraints?: string[];
    excluded?: { model: string; reason: string }[];
  };
}

function routingBody(kit: Kit): Built {
  const { spec, ctx } = kit;
  const taskId = spec.taskId ?? '';
  const whyBox = h('div', { class: 'gv-routing-why', hidden: true });
  const pinBox = h('div', { class: 'gv-pin', hidden: true });
  const why = button(
    'Why',
    async () => {
      whyBox.hidden = false;
      replace(whyBox, h('p', { class: 'muted' }, 'Asking routing…'));
      const r = await ctx.act('Explain routing', () =>
        ctx.api.get<RoutingExplain>(`/routing/explain/${encodeURIComponent(taskId)}`),
      );
      if (!r) {
        replace(whyBox, h('p', { class: 'muted' }, 'Routing did not answer.'));
        return;
      }
      replace(whyBox, explainView(r));
    },
    { class: 'btn btn-ghost' },
  );
  const pinOpen = button(
    'Pin a model for this task',
    async () => {
      pinBox.hidden = false;
      replace(pinBox, h('p', { class: 'muted' }, 'Reading the models…'));
      const r = await ctx.act('Read the models', () => ctx.api.models());
      if (!r) {
        replace(pinBox, h('p', { class: 'muted' }, 'The models could not be read.'));
        return;
      }
      const selectId = nextId('pin-model');
      const select = h(
        'select',
        { class: 'select gv-pin-select', id: selectId },
        ...r.models.map((m) => h('option', { value: m.id }, visible(m.id))),
      );
      const pin = decisionButton(
        'Pin',
        kit,
        async (b) => {
          const model = select.value;
          if (!model) return;
          b.disabled = true;
          const ok = await ctx.act(
            'Pin a model',
            () => ctx.api.pin({ scope: 'task', target: taskId, model, note: 'pinned from a routing question' }),
            `Pinned ${model} for this task`,
          );
          b.disabled = false;
          if (ok) kit.done(`Pinned ${model}; the question closes when the task gets a run.`);
        },
        'btn btn-primary',
      );
      kit.arming().register(pin);
      replace(
        pinBox,
        r.models.length
          ? [
              h('label', { class: 'field-label', for: selectId }, 'Model'),
              h('div', { class: 'row' }, select, pin),
              // The card keeps its own Pin (review §5); the pins' home is Settings → Routing (M9k.4).
              h('p', { class: 'muted gv-pin-home' }, 'Pins are kept in Settings → Models.'),
            ]
          : h('p', { class: 'muted' }, 'Friday knows no models to pin.'),
      );
    },
    { class: 'btn' },
  );
  const cancel = cancelTaskButton(kit);
  // A host that is kept out (not signed in, a limit) is often why no agent may run the task: said
  // in plain words, with the button that tries it again (2026-11-17).
  const blockRows = hostBlockRows(kit);
  return {
    body: present([
      ...context(spec),
      ...blockRows,
      taskId ? h('div', { class: 'gv-actions' }, why, pinOpen, cancel) : null,
      whyBox,
      pinBox,
      cliHints(spec),
    ]),
    decisions: [cancel],
  };
}

function explainView(r: RoutingExplain): HTMLElement {
  const d = r.dry_run ?? {};
  return h(
    'div',
    { class: 'gv-explain' },
    h(
      'p',
      null,
      d.blocked
        ? h('span', { class: 'badge badge-danger' }, 'blocked')
        : h('span', { class: 'badge badge-good' }, 'can start'),
      ' ',
      cleanText(String(d.reason ?? 'no reason given')),
    ),
    d.model ? h('p', { class: 'mono' }, `Model: ${visible(String(d.model))}`) : null,
    Array.isArray(d.constraints) && d.constraints.length
      ? h('p', null, 'Constraints: ', h('span', { class: 'mono' }, visible(d.constraints.join(', '))))
      : null,
    Array.isArray(d.excluded) && d.excluded.length
      ? h(
          'ul',
          { class: 'gv-excluded' },
          ...d.excluded
            .slice(0, 12)
            .map((x) =>
              h('li', null, h('span', { class: 'mono' }, visible(String(x.model))), ': ', cleanText(String(x.reason))),
            ),
        )
      : null,
  );
}

function cancelTaskButton(kit: Kit): HTMLButtonElement {
  const { ctx, spec } = kit;
  return decisionButton(
    'Cancel task',
    kit,
    async (b) => {
      if (!spec.taskId) return;
      const taskId = spec.taskId;
      b.disabled = true;
      const summary = ctx.store.select('board')?.tasks.find((t) => t.task_id === taskId)?.summary ?? null;
      const done = await cancelTask(
        ctx,
        { task_id: taskId, summary },
        { line: taskLine(ctx.store.select('board'), taskId) },
      );
      b.disabled = false;
      if (done) kit.done('Task cancelled');
    },
    'btn btn-danger',
  );
}

// ---- setup_failed: the checks failed where the install failed (2026-11-17)

/** The install's command and the end of what it printed, from a question's evidence lines. */
export function installEvidence(evidence: string[]): { command: string | null; output: string | null } {
  const of = (prefix: string): string | null => {
    const line = evidence.find((x) => x.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() || null : null;
  };
  return { command: of('install:'), output: of('install output:') };
}

/**
 * A task failed its checks in a folder whose dependencies were never installed. That read "A task
 * keeps failing verification" after the agent had been sent back to fail the same way; the planner
 * now stops at the first such failure and asks. The card says so in a person's words and leads with
 * the way out: **Install again** (after fixing what kept it from installing: the network, a
 * registry, a lockfile), then **Send it back to the agent**, whose next result is checked in the
 * installed folder. A failed task cannot be checked again as it stands, so there is no such button.
 */
function setupBody(kit: Kit): Built {
  const { spec, ctx } = kit;
  const taskId = spec.taskId ?? '';
  const board = ctx.store.select('board');
  const root = board?.runs[taskId]?.execution_root ?? null;
  const first = installEvidence(spec.evidence);
  const result = h('div', { class: 'gv-setup-result', role: 'status' });
  let installed = false;

  const rework = decisionButton('Send it back to the agent', kit, async (b) => {
    b.disabled = true;
    const reason = installed
      ? 'The dependencies are installed in the task folder now. The earlier check most likely failed for want of them: run the checks, fix what still fails, and finish.'
      : 'Sent back by a person. The dependencies of the task folder were not installed, so a check may fail for that reason.';
    const r = await ctx.act(
      'Send the task back',
      () => ctx.api.taskAction(taskId, 'rework', reason),
      'Sent back to the agent',
    );
    b.disabled = false;
    if (r) kit.done('Sent back to the agent');
  });

  const install = decisionButton(
    'Install again',
    kit,
    async (b) => {
      b.disabled = true;
      setText(kit.status, 'Installing… (this can take a few minutes)');
      const r = await ctx.act('Install again', () => ctx.api.setupWorktree(taskId));
      b.disabled = false;
      setText(kit.status, '');
      if (r === undefined) return;
      const s = r.setup;
      if (s?.status === 'passed') {
        installed = true;
        install.classList.remove('btn-primary');
        rework.classList.add('btn-primary');
        replace(
          result,
          h(
            'p',
            { class: 'gv-setup-ok' },
            'Installed. Send the task back to its agent: its next result is checked in the installed folder.',
          ),
        );
        return;
      }
      installed = false;
      replace(
        result,
        h(
          'p',
          { class: 'field-error' },
          s
            ? `The install did not finish: ${truncate(cleanText(s.reason), 300)}.`
            : 'Nothing was installed: this project declares no install for a task folder.',
        ),
        s?.output_tail ? agentText('What the install printed', s.output_tail.slice(-1500)) : null,
      );
    },
    'btn btn-primary',
  );

  const open = root
    ? button([icon('expand', 14), 'Open the folder in VS Code'], () => ctx.platform.openInEditor(root), {
        class: 'btn btn-ghost',
      })
    : null;
  const cancel = cancelTaskButton(kit);

  return {
    body: present([
      h(
        'p',
        { class: 'gv-question-text' },
        'This task failed its checks, and the dependencies of its folder were not installed. That is most likely a setup problem, not the work of the agent.',
      ),
      spec.why
        ? h('p', { class: 'gv-why' }, h('span', { class: 'gv-k' }, 'The install: '), decisionText(spec.why))
        : null,
      h(
        'p',
        { class: 'field-hint' },
        'Fix what kept it from installing (the network, a registry, a lockfile), then install again. Friday sends nothing back on its own here: another attempt would fail the same way.',
      ),
      taskId ? h('div', { class: 'gv-actions' }, install, rework, open, cancel) : null,
      result,
      h(
        'details',
        { class: 'gv-details' },
        h('summary', null, 'Details'),
        h('p', { class: 'muted' }, decisionText(spec.question)),
        first.command ? agentText('The install command', first.command) : null,
        first.output ? agentText('What the install printed', first.output) : null,
        root ? agentText('The task folder', root) : null,
      ),
      cliHints(spec),
    ]),
    decisions: taskId ? [install, rework, cancel] : [],
  };
}

// ---- integration_conflict, integration_failed

function integrationBody(kit: Kit): Built {
  const { spec, ctx } = kit;
  const board = ctx.store.select('board');
  const taskId = spec.taskId;
  const integration = taskId ? (board?.integrations[taskId] ?? null) : null;
  const run = taskId ? (board?.runs[taskId] ?? null) : null;
  const d = (kit.e.details ?? {}) as Record<string, unknown>;
  const conflicts = integration?.conflicts?.length
    ? integration.conflicts
    : Array.isArray(d.conflicts)
      ? (d.conflicts as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
  const goalId = spec.goalId ?? integration?.goal_id ?? null;
  const root = run?.execution_root ?? null;

  const again = decisionButton('Integrate again', kit, (b) => integrate(kit, b, false), 'btn btn-primary');
  const repair = decisionButton('Integrate my repair', kit, (b) => integrate(kit, b, true));
  const cancelGoal = decisionButton(
    'Cancel goal',
    kit,
    async (b) => {
      if (!goalId) return;
      const ok = await ctx.confirm({
        title: 'Cancel the goal?',
        body: [
          'Every open task of the goal is cancelled. The goal branch and its commits are kept.',
          'Nothing is merged into your branches.',
        ],
        confirmLabel: 'Cancel goal',
        cancelLabel: 'Keep it',
        danger: true,
      });
      if (!ok) return;
      b.disabled = true;
      const r = await ctx.act('Cancel the goal', () => ctx.api.cancelGoal(goalId), 'Goal cancelled');
      b.disabled = false;
      if (r) kit.done('Goal cancelled');
    },
    'btn btn-danger',
  );
  const openWorktree = root
    ? button([icon('expand', 14), 'Open in VS Code'], () => ctx.platform.openInEditor(root), { class: 'btn btn-ghost' })
    : null;

  const fileRow = (f: string) =>
    h(
      'li',
      { class: 'gv-file' },
      h('span', { class: 'gv-file-path mono' }, visible(f)),
      root
        ? button(icon('expand', 12), () => ctx.platform.openInEditor(`${root.replace(/[\\/]+$/, '')}/${f}`), {
            class: 'btn btn-ghost btn-icon',
            ariaLabel: `Open ${visible(f)} in VS Code`,
          })
        : null,
    );

  return {
    body: present([
      ...context(spec),
      conflicts.length
        ? h(
            'div',
            { class: 'gv-field' },
            h('div', { class: 'gv-field-label' }, `Conflicting files (${conflicts.length})`),
            h('ul', { class: 'gv-file-list' }, ...conflicts.slice(0, 50).map(fileRow)),
          )
        : integration?.summary
          ? agentText('What failed', integration.summary)
          : null,
      h(
        'dl',
        { class: 'gv-meta' },
        h(
          'div',
          { class: 'gv-meta-row' },
          h('dt', null, 'Task branch'),
          h('dd', { class: 'mono' }, visible(run?.branch_ref ?? '—')),
        ),
        h(
          'div',
          { class: 'gv-meta-row' },
          h('dt', null, 'Goal branch'),
          h('dd', { class: 'mono' }, visible(integration?.branch ?? (goalId ? `friday/goal-${goalId}` : '—'))),
        ),
        h('div', { class: 'gv-meta-row' }, h('dt', null, 'Worktree'), h('dd', { class: 'mono' }, visible(root ?? '—'))),
      ),
      h(
        'p',
        { class: 'field-hint' },
        'Repair the task branch in its worktree, commit, then choose Integrate my repair. Friday never merges into your own branches.',
      ),
      h(
        'div',
        { class: 'gv-actions' },
        taskId ? again : null,
        taskId ? repair : null,
        openWorktree,
        goalId ? cancelGoal : null,
      ),
      cliHints(spec),
    ]),
    decisions: [again, repair, cancelGoal],
  };
}

async function integrate(kit: Kit, b: HTMLButtonElement, repaired: boolean): Promise<void> {
  const { ctx, spec } = kit;
  if (!spec.taskId) return;
  const taskId = spec.taskId;
  b.disabled = true;
  setText(
    kit.status,
    repaired ? 'Integrating your repair… (checks may take a while)' : 'Integrating… (checks may take a while)',
  );
  const r = await ctx.act(repaired ? 'Integrate the repair' : 'Integrate again', () =>
    ctx.api.integrate(taskId, repaired),
  );
  b.disabled = false;
  if (!r) {
    setText(kit.status, '');
    return;
  }
  const s = r.integration?.status;
  if (s === 'integrated' || s === 'not_needed') kit.done(s === 'integrated' ? 'Integrated' : 'Nothing to integrate');
  else {
    setText(kit.status, `Integration ${s ?? 'ended'}: ${cleanText(r.integration?.summary ?? 'see the task')}`);
    ctx.refresh();
  }
}

// ---- unanswered_request

function unansweredBody(kit: Kit): Built {
  const { spec } = kit;
  const d = (kit.e.details ?? {}) as Record<string, unknown>;
  const original = spec.evidence[0] ?? null;
  const replyId = nextId('reply');
  const reply = h('textarea', { class: 'textarea', id: replyId, rows: 3, maxLength: 4000, placeholder: 'Your reply…' });
  const send = decisionButton(
    'Send reply',
    kit,
    async (b) => {
      if (!reply.value.trim()) {
        setText(kit.status, 'Write the reply first.');
        return;
      }
      await answer(kit, reply.value.trim(), 'Reply sent to the waiting agent', b);
    },
    'btn btn-primary',
  );
  return {
    body: present([
      h('p', { class: 'gv-question-text' }, cleanText(spec.question)),
      original
        ? h(
            'div',
            { class: 'gv-field' },
            h('div', { class: 'gv-field-label' }, 'Their request'),
            h('blockquote', { class: 'gv-quote' }, cleanText(original)),
          )
        : null,
      h(
        'div',
        { class: 'field' },
        h(
          'label',
          { class: 'field-label', for: replyId },
          replyLabel(typeof d.requested_by === 'string' ? cleanText(d.requested_by) : 'the waiting agent'),
        ),
        reply,
      ),
      h('div', { class: 'gv-actions' }, send),
    ]),
    decisions: [send],
  };
}

// ---- planning itself failed (2026-11-17)

/**
 * The planner could not plan a goal: what happened in a person's words, then the buttons that fit.
 * "Try again" (with an optional note) while a planner is ready, which answers the question so the
 * daemon plans from the answer; "Write the plan myself" always; "Planner settings" where the cause
 * is fixed there. The daemon's own sentence, with its ids, is under "Details".
 */
function plannerFailureBody(kit: Kit, goalId: string): Built {
  const { spec, ctx } = kit;
  const board = ctx.store.select('board');
  const goal = board?.goals.find((g) => g.goal_id === goalId) ?? null;
  const revising = !!board?.plans[goalId]?.active;
  const ready = board?.brain?.planner_available === true;
  const trouble = plannerTrouble(spec.kind, spec.why);
  const decisions: HTMLButtonElement[] = [];
  const row = h('div', { class: 'gv-actions' });
  const body: (HTMLElement | null)[] = [
    h(
      'p',
      { class: 'gv-question-text' },
      revising ? 'Friday could not change the plan of this goal.' : 'Friday could not plan this goal.',
    ),
    goal ? h('p', { class: 'gv-from' }, 'Goal: ', truncate(cleanText(goal.request), 300)) : null,
    h('p', { class: 'gv-why' }, plannerTroubleWords(trouble, spec.why)),
  ];
  if (ready) {
    const noteId = nextId('plan-again-note');
    const note = h('textarea', {
      class: 'textarea',
      id: noteId,
      rows: 2,
      maxLength: 2000,
      placeholder: 'For example: keep it to two tasks',
    });
    const again = decisionButton(
      'Try again',
      kit,
      async (b) => {
        b.disabled = true;
        setText(kit.status, 'Asking the planner again… (a model call can take a minute)');
        // Answering settles the question, and the daemon plans from the answer (ADR-0015).
        const r = await ctx.act('Ask the planner again', () =>
          ctx.api.answer(kit.e.escalation_id, note.value.trim() || 'Try again.'),
        );
        b.disabled = false;
        if (r) kit.done('The planner was asked again: its plan appears on the board for you to review.');
        else setText(kit.status, '');
      },
      'btn btn-primary',
    );
    body.push(
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field-label', for: noteId }, 'Anything the planner should know (optional)'),
        note,
      ),
    );
    row.append(again);
    decisions.push(again);
  }
  row.append(
    button(
      revising ? 'Write the change myself' : 'Write the plan myself',
      () => openModal(ctx, { kind: 'plan-editor', id: goalId, mode: revising ? 'revision' : 'first' }),
      { class: ready ? 'btn' : 'btn btn-primary' },
    ),
  );
  if (!ready || fixedInSettings(trouble)) {
    row.append(
      button('Planner settings', () => openDrawer(ctx, { kind: 'settings', tab: 'planner' }), {
        class: 'btn btn-ghost',
      }),
    );
  }
  body.push(
    row,
    h(
      'details',
      { class: 'gv-details' },
      h('summary', null, 'Details'),
      h('p', { class: 'muted' }, decisionText(spec.question)),
      spec.why ? h('p', { class: 'muted' }, decisionText(spec.why)) : null,
    ),
  );
  return { body: present(body), decisions };
}

// ---- the Master Brain's other kinds

function brainBody(kit: Kit): Built {
  const { spec, ctx } = kit;
  // Planning itself failed for a goal: its own card. With a task in it (a failed check nobody could
  // re-plan), the buttons below (rework, cancel) are what applies.
  if (spec.kind && PLANNER_FAILURES.includes(spec.kind) && spec.goalId && !spec.taskId) {
    return plannerFailureBody(kit, spec.goalId);
  }
  const body: (HTMLElement | null)[] = [...context(spec)];
  const decisions: HTMLButtonElement[] = [];
  const row = h('div', { class: 'gv-actions' });

  if (spec.actions.includes('revise-note') && spec.goalId) {
    const goalId = spec.goalId;
    const noteId = nextId('revise-note');
    const note = h('textarea', {
      class: 'textarea',
      id: noteId,
      rows: 3,
      maxLength: 2000,
      placeholder: 'Guidance for the Master Brain’s next revision…',
    });
    const revise = decisionButton(
      'Revise with a note',
      kit,
      async (b) => {
        b.disabled = true;
        setText(kit.status, 'Asking the Master Brain for a revision… (a model call can take a minute)');
        // Answering settles the question, and the daemon revises the goal's plan from the answer
        // (ADR-0015); a separate replan would leave the question open.
        const text = note.value.trim() || 'Revise the plan.';
        const r = await ctx.act('Revise the plan', () => ctx.api.answer(kit.e.escalation_id, text));
        b.disabled = false;
        if (r) kit.done(`Revision requested for ${cleanText(goalId)}`);
        else setText(kit.status, '');
      },
      'btn btn-primary',
    );
    body.push(
      h('div', { class: 'field' }, h('label', { class: 'field-label', for: noteId }, 'Note for the revision'), note),
    );
    row.append(revise);
    decisions.push(revise);
  }
  if (spec.actions.includes('write-revision') && spec.goalId) {
    const goalId = spec.goalId;
    row.append(
      button('Write a revision', () => openModal(ctx, { kind: 'plan-editor', id: goalId, mode: 'revision' }), {
        class: 'btn btn-primary',
      }),
    );
    const reason = ctx.store.select('board')?.brain?.reason;
    body.push(
      h(
        'p',
        { class: 'field-hint' },
        `No planner is ready${reason ? `: ${cleanText(reason)}` : ''}. Write the revision yourself.`,
      ),
    );
  }
  if (spec.actions.includes('rework-task') && spec.taskId) {
    const taskId = spec.taskId;
    const rework = decisionButton('Rework the task', kit, async (b) => {
      b.disabled = true;
      const r = await ctx.act('Rework the task', () => ctx.api.taskAction(taskId, 'rework'), 'Sent back for rework');
      b.disabled = false;
      if (r) kit.done('Sent back for rework');
    });
    row.append(rework);
    decisions.push(rework);
  }
  if (spec.actions.includes('cancel-task') && spec.taskId) {
    const cancel = cancelTaskButton(kit);
    row.append(cancel);
    decisions.push(cancel);
  }
  if (spec.actions.includes('planner-settings')) {
    row.append(
      button('Planner settings', () => openDrawer(ctx, { kind: 'settings', tab: 'planner' }), {
        class: 'btn btn-ghost',
      }),
    );
  }
  if (spec.actions.includes('reply')) {
    const replyId = nextId('brain-reply');
    const reply = h('textarea', {
      class: 'textarea',
      id: replyId,
      rows: 3,
      maxLength: 4000,
      placeholder: 'Your answer…',
    });
    const send = decisionButton(
      'Send answer',
      kit,
      async (b) => {
        if (!reply.value.trim()) {
          setText(kit.status, 'Write the answer first.');
          return;
        }
        await answer(kit, reply.value.trim(), 'Answer recorded', b);
      },
      'btn btn-primary',
    );
    body.push(
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field-label', for: replyId }, replyLabel('the Master Brain')),
        reply,
      ),
    );
    row.append(send);
    decisions.push(send);
  }
  body.push(row, cliHints(spec));
  return { body: present(body), decisions };
}
