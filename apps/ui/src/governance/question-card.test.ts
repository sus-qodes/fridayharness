import type { EscalationView } from '@friday/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LET_AGENT_DECIDE } from '../model/escalations.js';
import { makeContext, type TestContext } from '../test/context.js';
import { makeAgent, makeEscalation, makeRun, makeSnapshot, makeTask } from '../test/fixtures.js';
import { questionCard } from './question-card.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const LONG = 'z'.repeat(5000);
const ESC = 'esc_000000000000000000000es01';
const TASK = 'task_0000000000000000000000aa01';
const GOAL = 'goal_0000000000000000000000gg01';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function arm(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5, movementX: 1 }));
  vi.advanceTimersByTime(700);
}

function press(target: Element, key: string, init: KeyboardEventInit = {}): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
}

function userFocus(el: HTMLElement): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  el.focus();
}

function buttonNamed(root: Element, name: string): HTMLButtonElement {
  const all = [...root.querySelectorAll('button')];
  const b = all.find((x) => x.textContent?.trim() === name) ?? all.find((x) => x.textContent?.trim().startsWith(name));
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

function answers(ctx: TestContext): unknown[] {
  return ctx.transport.to('POST', `/escalations/${ESC}/answer`).map((c) => (c.body as { answer: string }).answer);
}

describe('question cards by kind (plan FD-21)', () => {
  let ctx: TestContext;
  let forward: (e: KeyboardEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    if (forward) document.removeEventListener('keydown', forward);
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function mount(
    e: EscalationView,
    opts: Parameters<typeof questionCard>[2] = {},
    extra: Record<string, unknown> = {},
    plannerAvailable = true,
  ) {
    ctx = makeContext({
      snapshot: makeSnapshot({
        agents: [makeAgent()],
        tasks: [makeTask({ goal_id: GOAL })],
        runs: { [TASK]: makeRun({ execution_root: 'C:/wt/abc', branch_ref: 'friday/task-abc' }) },
        escalations: [e],
        brain: { planner_available: plannerAvailable, reason: plannerAvailable ? null : 'no key is stored' } as never,
      }),
      answers: { [`POST /escalations/${ESC}/answer`]: { ok: true }, ...extra },
    });
    forward = (ev) => ctx.keys.handle(ev);
    document.addEventListener('keydown', forward);
    const card = questionCard(ctx, e, opts);
    document.body.appendChild(card.el);
    vi.advanceTimersByTime(0);
    return card;
  }

  describe('an agent question', () => {
    it('renders the question, why, proposed action, evidence and chips as text with visible marks', () => {
      const card = mount(
        makeEscalation({
          question: `Which algorithm? ${HOSTILE}`,
          options: [`RS256 ${HOSTILE}`, 'HS256\u202E', `E\u200BdDSA ${LONG}`],
          details: { why: `prod ${HOSTILE}`, proposed_action: 'RS256', evidence: [`log ${HOSTILE}`] },
        }),
      );
      const el = card.el;
      expect(el.querySelector('img')).toBeNull();
      expect(el.textContent).toContain('claude-1');
      expect(el.querySelector('.gv-question-text')?.textContent).toBe(`Which algorithm? ${HOSTILE}`);
      const chips = [...el.querySelectorAll('.gv-chip-text')].map((c) => c.textContent);
      expect(chips[0]).toBe(`RS256 ${HOSTILE}`);
      expect(chips[1]).toBe('HS256⟨U+202E⟩');
      expect(chips[2]).toContain('E⟨U+200B⟩dDSA');
      expect(chips[2]).toContain(LONG);
      expect(el.textContent).toContain(`prod ${HOSTILE}`);
      expect(el.querySelector('.gv-evidence')?.textContent).toContain(HOSTILE);
      expect(el.querySelectorAll('[role="radio"]')).toHaveLength(3);
      card.destroy();
    });

    it('keys 1–4 and arrows select chips only while focus is inside; Ctrl+Enter sends', async () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const card = mount(makeEscalation({ options: ['A', 'B', 'C', 'D', 'E'] }));
      const chips = [...card.el.querySelectorAll<HTMLElement>('.gv-chip')];
      outside.focus();
      press(outside, '2');
      expect(chips[1]?.getAttribute('aria-checked')).toBe('false');
      userFocus(chips[0] as HTMLElement);
      press(chips[0] as HTMLElement, '2');
      expect(chips[1]?.getAttribute('aria-checked')).toBe('true');
      press(chips[1] as HTMLElement, 'ArrowDown');
      expect(chips[2]?.getAttribute('aria-checked')).toBe('true');
      expect(document.activeElement).toBe(chips[2]);
      press(chips[2] as HTMLElement, 'ArrowUp');
      press(chips[1] as HTMLElement, 'ArrowUp');
      press(chips[0] as HTMLElement, 'ArrowUp');
      expect(chips[4]?.getAttribute('aria-checked')).toBe('true');
      press(chips[4] as HTMLElement, '4');
      vi.advanceTimersByTime(700);
      press(chips[3] as HTMLElement, 'Enter', { ctrlKey: true });
      await flush();
      expect(answers(ctx)).toEqual(['Selected: D']);
      card.destroy();
    });

    it('typing in the write-in selects the write-in; digits typed there stay text', async () => {
      const card = mount(makeEscalation({ options: ['A', 'B'] }));
      const chips = [...card.el.querySelectorAll<HTMLElement>('.gv-chip')];
      chips[0]?.click();
      expect(chips[0]?.getAttribute('aria-checked')).toBe('true');
      const note = card.el.querySelector('.gv-write-in') as HTMLTextAreaElement;
      // The box says who reads it: the asking agent (review §4, one wording for one act).
      expect(card.el.querySelector(`label[for="${note.id}"]`)?.textContent).toBe('Reply to claude-1');
      userFocus(note);
      press(note, '2');
      expect(chips[1]?.getAttribute('aria-checked')).toBe('false');
      note.value = `use JWKS ${HOSTILE}`;
      note.dispatchEvent(new Event('input', { bubbles: true }));
      expect(chips.every((c) => c.getAttribute('aria-checked') === 'false')).toBe(true);
      vi.advanceTimersByTime(700);
      press(note, 'Enter', { ctrlKey: true });
      await flush();
      expect(answers(ctx)).toEqual([`Note: use JWKS ${HOSTILE}`]);
      card.destroy();
    });

    it('a chip plus a note sends both lines; Send waits for the card to arm', async () => {
      const card = mount(makeEscalation({ options: ['Yes', 'No'] }));
      buttonNamed(card.el, '1').click();
      const note = card.el.querySelector('.gv-write-in') as HTMLTextAreaElement;
      note.value = 'only for members';
      buttonNamed(card.el, 'Send').click();
      await flush();
      expect(answers(ctx)).toEqual([]);
      arm(card.el);
      buttonNamed(card.el, 'Send').click();
      await flush();
      expect(answers(ctx)).toEqual(['Selected: Yes\nNote: only for members']);
      expect(card.el.textContent).toContain('Answer sent');
      expect(ctx.refreshes).toBe(1);
      card.destroy();
    });

    it('Send with nothing chosen says what is missing', async () => {
      const card = mount(makeEscalation());
      arm(card.el);
      buttonNamed(card.el, 'Send').click();
      await flush();
      expect(answers(ctx)).toEqual([]);
      expect(card.el.textContent).toContain('Pick an option or write an answer first.');
      card.destroy();
    });

    it('Let the agent decide answers the fixed sentence; Later calls onLater and answers nothing', async () => {
      const onLater = vi.fn();
      const card = mount(makeEscalation(), { onLater });
      buttonNamed(card.el, 'Later').click();
      expect(onLater).toHaveBeenCalledOnce();
      arm(card.el);
      buttonNamed(card.el, 'Let the agent decide').click();
      await flush();
      expect(answers(ctx)).toEqual([LET_AGENT_DECIDE]);
      card.destroy();
    });

    it('a failed answer keeps the card usable', async () => {
      const card = mount(
        makeEscalation(),
        {},
        {
          [`POST /escalations/${ESC}/answer`]: () => {
            throw new Error('COS-2002: already answered');
          },
        },
      );
      arm(card.el);
      buttonNamed(card.el, 'Let the agent decide').click();
      await flush();
      expect(ctx.toasts.some((t) => t.kind === 'error')).toBe(true);
      expect(buttonNamed(card.el, 'Let the agent decide').disabled).toBe(false);
      card.destroy();
    });
  });

  it('system options are never chips; they are small print at most', () => {
    const card = mount(
      makeEscalation({
        kind: 'recovery_needed',
        requested_by_kind: 'system',
        options: [`friday recover ${TASK} --action reassign ${HOSTILE}`],
      }),
    );
    expect(card.el.querySelectorAll('.gv-chip')).toHaveLength(0);
    expect(card.el.querySelector('.gv-cli')?.textContent).toContain('What the CLI would do');
    expect(card.el.querySelector('.gv-cli')?.textContent).toContain(HOSTILE);
    expect(card.el.querySelector('img')).toBeNull();
    card.destroy();
  });

  it('recovery_needed: Recover opens the recovery dialog for the task', () => {
    const card = mount(makeEscalation({ kind: 'recovery_needed', options: [] }));
    buttonNamed(card.el, 'Recover').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'recover', id: TASK });
    card.destroy();
  });

  it('a stop at the agent’s spending limit offers to raise it and continue, with the other ways behind one button', () => {
    const card = mount(
      makeEscalation({
        kind: 'recovery_needed',
        requested_by_kind: 'system',
        question:
          'claude-1 stopped at its spending limit: this attempt cost $5.03, and reached the limit of $5 per attempt. The work so far is kept. Raise the limit to let the task continue, or cancel it.',
        options: [`friday recover ${TASK} --action reassign`, `friday task cancel ${TASK}`],
        details: { reason: 'budget_exceeded', scope: 'agent', agent_key: 'claude-1', cap_usd: 5, cost_usd: 5.03 },
      }),
    );
    expect(card.el.textContent).toContain('claude-1 stopped at its spending limit');
    // No terminal commands for a person who has a button, and no bare "Recover…".
    expect(card.el.querySelector('.gv-cli')).toBeNull();
    expect(card.el.textContent).not.toContain('friday recover');
    expect(
      Array.from(card.el.querySelectorAll('.gv-actions:not(.gv-actions-end) button')).map((b) => b.textContent),
    ).toEqual(['Raise the limit and continue…', 'Other options…']);
    buttonNamed(card.el, 'Raise the limit and continue').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'raise-limit', id: TASK });
    buttonNamed(card.el, 'Other options').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'recover', id: TASK });
    card.destroy();
    // The task's own cap (routing.task_budget_usd) is not an agent's limit: the recovery dialog as before.
    const taskCap = mount(
      makeEscalation({ kind: 'recovery_needed', options: [], details: { reason: 'budget_exceeded', cap_usd: 1 } }),
    );
    expect(taskCap.el.textContent).not.toContain('Raise the limit');
    buttonNamed(taskCap.el, 'Recover').click();
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'recover', id: TASK });
    taskCap.destroy();
  });

  describe('routing', () => {
    it('Why asks routing to explain the task', async () => {
      const card = mount(
        makeEscalation({ kind: 'routing_blocked' }),
        {},
        {
          [`GET /routing/explain/${TASK}`]: {
            dry_run: {
              blocked: true,
              reason: `pinned model cannot run ${HOSTILE}`,
              constraints: ['vision'],
              excluded: [{ model: 'gpt\u202E', reason: 'no vision' }],
            },
            decisions: [],
          },
        },
      );
      buttonNamed(card.el, 'Why').click();
      await flush();
      const why = card.el.querySelector('.gv-routing-why') as HTMLElement;
      expect(why.hidden).toBe(false);
      expect(why.textContent).toContain(`pinned model cannot run ${HOSTILE}`);
      expect(why.textContent).toContain('gpt⟨U+202E⟩');
      expect(why.querySelector('img')).toBeNull();
      card.destroy();
    });

    describe('a task with no agent to run it', () => {
      const blocked = (codes: string[]) =>
        makeEscalation({
          kind: 'routing_blocked',
          requested_by_kind: 'system',
          question: `${TASK} cannot start: no dispatchable candidate for role "frontend_engineer" on this harness`,
          options: [`friday routing explain ${TASK}`, 'friday routing pin --task <task> --model <model>'],
          details: { harness_id: null, reason_codes: codes },
        });
      const offer = (over: Record<string, unknown> = {}) => ({
        agent_key: 'claude-1',
        host: 'claude-code',
        attach_mode: 'spawn',
        free: true,
        blocked: false,
        model: 'claude-sonnet-5-5',
        reason: 'x',
        ...over,
      });
      const runOn = (el: Element) => [...el.querySelectorAll('.gv-run-on button')].map((b) => b.textContent);

      it('says what is wrong in words and leads with the agents it can be given to', async () => {
        const card = mount(
          blocked(['registry.none_eligible']),
          {},
          {
            [`GET /routing/explain/${TASK}`]: {
              offers: [
                offer(),
                offer({ agent_key: `codex${HOSTILE}`, host: 'codex', free: false }),
                offer({ agent_key: 'antigravity-1', host: 'antigravity', attach_mode: 'attach' }),
                // One it would not start on even so is not offered.
                offer({ agent_key: 'local-1', host: 'generic', blocked: true }),
              ],
            },
            [`POST /tasks/${TASK}/assign`]: { mode: 'assigned', task: {} },
          },
        );
        expect(card.el.querySelector('.gv-card-title')?.textContent).toBe('A task has no agent to run it');
        expect(card.el.querySelector('.gv-question-text')?.textContent).toBe(
          'None of your connected agents can take this task as things are.',
        );
        // The decision's own sentence is one step away, and no terminal command is offered.
        const details = card.el.querySelector('details.gv-details') as HTMLDetailsElement;
        expect(details.open).toBe(false);
        expect(details.textContent).toContain('no dispatchable candidate for role');
        expect(card.el.querySelector('.gv-cli')).toBeNull();
        expect(card.el.textContent).not.toContain('friday routing pin');
        expect(card.el.textContent).toContain('Looking for an agent that can take it');
        await flush();
        expect(runOn(card.el)).toEqual([
          'claude-1 (Claude Code)',
          // A busy agent and one the person runs themselves say so on the button.
          `codex${HOSTILE} (Codex, busy now)`,
          'antigravity-1 (Antigravity, your editor)',
        ]);
        expect(card.el.querySelector('img')).toBeNull();
        // One click gives it to the agent, which Friday then follows.
        arm(card.el);
        buttonNamed(card.el, 'claude-1 (Claude Code)').click();
        await flush();
        expect(ctx.transport.to('POST', `/tasks/${TASK}/assign`)[0]?.body).toEqual({ agent_key: 'claude-1' });
        expect(card.el.querySelector('.gv-status')?.textContent).toBe('Given to claude-1: it starts now.');
        card.destroy();
      });

      it('says how a kept task starts: when a busy agent is free, or when the person takes it in their editor', async () => {
        const answersFor = {
          [`GET /routing/explain/${TASK}`]: {
            offers: [
              offer({ agent_key: 'codex-1', host: 'codex', free: false }),
              offer({ agent_key: 'antigravity-1', host: 'antigravity', attach_mode: 'attach' }),
            ],
          },
          [`POST /tasks/${TASK}/assign`]: { mode: 'reserved', task: {} },
        };
        const busy = mount(blocked(['pin.unavailable']), {}, answersFor);
        expect(busy.el.querySelector('.gv-question-text')?.textContent).toBe(
          'A model was chosen for this work that the agent it reached cannot run.',
        );
        await flush();
        arm(busy.el);
        buttonNamed(busy.el, 'codex-1').click();
        await flush();
        expect(busy.el.querySelector('.gv-status')?.textContent).toBe(
          'Kept for codex-1: it starts when that agent is free.',
        );
        // The question is still open (it closes when the task starts), so nothing is switched off.
        expect(buttonNamed(busy.el, 'Cancel task').disabled).toBe(false);
        busy.destroy();
        const own = mount(blocked(['role.unsupported']), {}, answersFor);
        expect(own.el.querySelector('.gv-question-text')?.textContent).toBe(
          'Friday could not tell what kind of work this task is, so it chose no agent for it.',
        );
        await flush();
        arm(own.el);
        buttonNamed(own.el, 'antigravity-1').click();
        await flush();
        expect(own.el.querySelector('.gv-status')?.textContent).toBe(
          'Kept for antigravity-1: take it there, in Antigravity, with /friday.',
        );
        own.destroy();
      });

      it('offers to start an agent when none can take it, and stays usable when the answer does not come', async () => {
        const none = mount(
          blocked(['delegation.all_blocked']),
          {},
          { [`GET /routing/explain/${TASK}`]: { offers: [] } },
        );
        await flush();
        expect(none.el.textContent).toContain('No agent is connected that can take work.');
        buttonNamed(none.el, 'Start an agent').click();
        expect(ctx.store.select('ui').modal).toEqual({ kind: 'start-agent' });
        none.destroy();
        const refused = mount(
          blocked(['constraint.sensitive']),
          {},
          { [`GET /routing/explain/${TASK}`]: { offers: [offer({ blocked: true })] } },
        );
        await flush();
        expect(refused.el.textContent).toContain('None of the connected agents can take it, whoever it is given to.');
        expect(refused.el.querySelector('.gv-question-text')?.textContent).toContain('marked sensitive');
        refused.destroy();
        // An older Friday, or an answer that failed: no agents are listed, the other ways remain.
        const silent = mount(blocked([]), {}, {});
        await flush();
        expect(runOn(silent.el)).toEqual([]);
        expect(silent.el.textContent).not.toContain('Looking for an agent');
        expect(buttonNamed(silent.el, 'Choose a model').disabled).toBe(false);
        silent.destroy();
      });

      it('chooses a model from those an agent here can run, for this task or for every task of its kind', async () => {
        const models = {
          models: [
            { id: 'claude-fable-5-1', vendors: ['claude-code'], source: 'seed' },
            { id: 'z-ai/glm-5.3', vendors: ['opencode'], source: 'seed' },
            { id: 'claude-sonnet-5-5', vendors: ['claude-code'], source: 'seed' },
            { id: 'openai/gpt-6.1-sol', vendors: ['codex'], source: 'seed' },
          ],
          evidence: [],
          settings: {},
        };
        const card = mount(
          blocked(['registry.none_eligible']),
          {},
          { 'GET /models': models, 'POST /routing/pins': { pin: {} } },
        );
        buttonNamed(card.el, 'Choose a model').click();
        await flush();
        const select = card.el.querySelector('.gv-pin-select') as HTMLSelectElement;
        // Names, the app that runs each, the everyday model first and chosen; nothing no agent here runs.
        expect([...select.options].map((o) => o.textContent)).toEqual([
          'Claude Sonnet 5.5 (Claude Code)',
          'Claude Fable 5.1 (Claude Code)',
          'GPT-6.1 Sol (Codex)',
        ]);
        expect(select.value).toBe('claude-sonnet-5-5');
        expect(card.el.textContent).toContain('Use it for every coding task, not only this one');
        arm(card.el);
        buttonNamed(card.el, 'Use this model').click();
        await flush();
        expect(ctx.transport.to('POST', '/routing/pins')[0]?.body).toMatchObject({
          scope: 'task',
          target: TASK,
          model: 'claude-sonnet-5-5',
        });
        card.destroy();
        const every = mount(
          blocked(['registry.none_eligible']),
          {},
          { 'GET /models': models, 'POST /routing/pins': { pin: {} } },
        );
        buttonNamed(every.el, 'Choose a model').click();
        await flush();
        (every.el.querySelector('.gv-pin-select') as HTMLSelectElement).value = 'openai/gpt-6.1-sol';
        (every.el.querySelector('.gv-pin-all input') as HTMLInputElement).checked = true;
        arm(every.el);
        buttonNamed(every.el, 'Use this model').click();
        await flush();
        expect(ctx.transport.to('POST', '/routing/pins')[0]?.body).toMatchObject({
          scope: 'kind',
          target: 'implementation',
          model: 'openai/gpt-6.1-sol',
        });
        expect(ctx.toasts.at(-1)?.text).toBe('GPT-6.1 Sol for every coding task');
        every.destroy();
      });
    });

    it('says which host is kept out and why, and tries it again when the person signed in', async () => {
      const card = mount(makeEscalation({ kind: 'routing_blocked' }), {}, { 'POST /readiness/clear': { ended: [] } });
      // Nothing is kept out: the card is as before.
      expect(card.el.querySelector('.gv-host-block')).toBeNull();
      card.destroy();
      const blocked = mount(
        makeEscalation({ kind: 'routing_blocked' }),
        {},
        { 'POST /readiness/clear': { ended: [] } },
      );
      blocked.destroy();
      ctx = makeContext({
        snapshot: makeSnapshot({
          agents: [makeAgent()],
          tasks: [makeTask({ goal_id: GOAL })],
          escalations: [makeEscalation({ kind: 'routing_blocked' })],
          host_blocks: [
            {
              host: 'claude-code',
              model: null,
              kind: 'sign_in',
              detail: 'auth: Not logged in',
              since: '2026-11-17T09:00:00.000Z',
              until: null,
            },
          ],
        }),
        answers: { 'POST /readiness/clear': { ended: [{ evidence_id: 'rdy_1' }] } },
      });
      const withBlock = questionCard(ctx, makeEscalation({ kind: 'routing_blocked' }));
      document.body.append(withBlock.el);
      const row = withBlock.el.querySelector('.gv-host-block') as HTMLElement;
      expect(row.textContent).toContain('Claude Code is not signed in, so Friday gives it no work');
      buttonNamed(withBlock.el, 'I signed in: try again').click();
      await flush();
      expect(ctx.transport.to('POST', '/readiness/clear').map((c) => c.body)).toEqual([
        { host: 'claude-code', model: null },
      ]);
      expect(ctx.refreshes).toBe(1);
      expect(withBlock.el.textContent).toContain('Friday offers the task again now');
      withBlock.destroy();
    });

    it('Pin a model for this task lists the models and pins one to the task', async () => {
      const card = mount(
        makeEscalation({ kind: 'routing_violated' }),
        {},
        {
          'GET /models': { models: [{ id: 'claude-sonnet-5' }, { id: 'gpt-5.6' }], evidence: [], settings: {} },
          'POST /routing/pins': { pin: {} },
        },
      );
      buttonNamed(card.el, 'Pin a model for this task').click();
      await flush();
      const select = card.el.querySelector('.gv-pin-select') as HTMLSelectElement;
      expect([...select.options].map((o) => o.value)).toEqual(['claude-sonnet-5', 'gpt-5.6']);
      select.value = 'gpt-5.6';
      arm(card.el);
      buttonNamed(card.el, 'Pin').click();
      await flush();
      expect(ctx.transport.to('POST', '/routing/pins')[0]?.body).toMatchObject({
        scope: 'task',
        target: TASK,
        model: 'gpt-5.6',
      });
      card.destroy();
    });

    it('Cancel task asks first', async () => {
      const card = mount(
        makeEscalation({ kind: 'routing_blocked' }),
        {},
        { [`POST /tasks/${TASK}/cancel`]: { task: {} } },
      );
      arm(card.el);
      ctx.confirmAnswer = false;
      buttonNamed(card.el, 'Cancel task').click();
      await flush();
      expect(ctx.confirms).toHaveLength(1);
      expect(ctx.transport.to('POST', `/tasks/${TASK}/cancel`)).toHaveLength(0);
      ctx.confirmAnswer = true;
      buttonNamed(card.el, 'Cancel task').click();
      await flush();
      expect(ctx.transport.to('POST', `/tasks/${TASK}/cancel`)).toHaveLength(1);
      card.destroy();
    });
  });

  describe('integration', () => {
    function mountIntegration() {
      const e = makeEscalation({ kind: 'integration_conflict', goal_id: GOAL, options: ['cancel the goal'] });
      const card = mount(
        e,
        {},
        {
          [`POST /tasks/${TASK}/integrate`]: (c: { body: unknown }) => ({
            integration: {
              status: (c.body as { repaired?: boolean }).repaired ? 'integrated' : 'conflicted',
              summary: 'x',
            },
          }),
          [`POST /goals/${GOAL}/cancel`]: { goal_id: GOAL },
        },
      );
      ctx.store.setState({
        board: {
          ...(ctx.store.select('board') as NonNullable<ReturnType<typeof ctx.store.select<'board'>>>),
          integrations: {
            [TASK]: {
              integration_id: 'int_1',
              goal_id: GOAL,
              task_id: TASK,
              status: 'conflicted',
              branch: `friday/goal-${GOAL}`,
              task_commit: 'c',
              base_commit: 'b',
              merged_commit: null,
              conflicts: [`src/${HOSTILE}\u202E.ts`, 'package.json'],
              checks: [],
              summary: null,
              created_at: '2026-10-17T10:00:00.000Z',
            },
          },
        },
      });
      card.destroy();
      const fresh = questionCard(ctx, e);
      document.body.appendChild(fresh.el);
      vi.advanceTimersByTime(0);
      return fresh;
    }

    it('shows the conflicting files, both branches and the worktree, as text with visible marks', () => {
      const card = mountIntegration();
      const text = card.el.textContent ?? '';
      expect(card.el.querySelector('img')).toBeNull();
      expect(text).toContain(`src/${HOSTILE}⟨U+202E⟩.ts`);
      expect(text).toContain('package.json');
      expect(text).toContain('friday/task-abc');
      expect(text).toContain(`friday/goal-${GOAL}`);
      expect(text).toContain('C:/wt/abc');
      card.destroy();
    });

    it('Open in VS Code opens the worktree', () => {
      const card = mountIntegration();
      const open = vi.spyOn(ctx.platform, 'openInEditor');
      buttonNamed(card.el, 'Open in VS Code').click();
      expect(open).toHaveBeenCalledWith('C:/wt/abc');
      card.destroy();
    });

    it('Integrate again and Integrate my repair call integrate, the repair with repaired: true', async () => {
      const card = mountIntegration();
      arm(card.el);
      buttonNamed(card.el, 'Integrate again').click();
      await flush();
      expect(card.el.textContent).toContain('Integration conflicted');
      buttonNamed(card.el, 'Integrate my repair').click();
      await flush();
      expect(ctx.transport.to('POST', `/tasks/${TASK}/integrate`).map((c) => c.body)).toEqual([{}, { repaired: true }]);
      expect(card.el.textContent).toContain('Integrated');
      card.destroy();
    });

    it('Cancel goal asks first', async () => {
      const card = mountIntegration();
      arm(card.el);
      buttonNamed(card.el, 'Cancel goal').click();
      await flush();
      expect(ctx.confirms[0]?.danger).toBe(true);
      expect(ctx.transport.to('POST', `/goals/${GOAL}/cancel`)).toHaveLength(1);
      card.destroy();
    });
  });

  it('unanswered_request: shows the original request and sends the reply as the answer', async () => {
    const card = mount(
      makeEscalation({
        kind: 'unanswered_request',
        question: 'claude-1 is waiting for an answer from codex-1',
        options: ['answer here: the answer is sent to the waiting agent'],
        details: { evidence: [`Which currency? ${HOSTILE}`], requested_by: 'claude-1' },
      }),
    );
    expect(card.el.querySelector('.gv-quote')?.textContent).toBe(`Which currency? ${HOSTILE}`);
    expect(card.el.querySelectorAll('.gv-chip')).toHaveLength(0);
    const reply = card.el.querySelector('textarea') as HTMLTextAreaElement;
    expect(card.el.querySelector(`label[for="${reply.id}"]`)?.textContent).toBe('Reply to claude-1');
    reply.value = 'EUR';
    arm(card.el);
    buttonNamed(card.el, 'Send reply').click();
    await flush();
    expect(answers(ctx)).toEqual(['EUR']);
    card.destroy();
  });

  describe('a check that failed where the install failed (2026-11-17)', () => {
    const SETUP = `POST /tasks/${TASK}/setup`;
    const failedSetup = (over: Partial<EscalationView> = {}) =>
      makeEscalation({
        kind: 'setup_failed',
        goal_id: GOAL,
        requested_by_kind: 'master_brain',
        question:
          'The checks of the task failed, and its dependencies were not installed in its folder (npm exited with 1). This looks like a setup problem.',
        options: ['fix what kept it from installing, then install again ("friday task setup <task>")'],
        details: {
          why: 'npm exited with 1',
          proposed_action: 'wait: another attempt would fail the same way',
          evidence: ['install: npm ci', `install output: npm ERR! network ${HOSTILE}`],
        },
        ...over,
      });

    it('says it is the setup, not the work, and leads with installing again', () => {
      const card = mount(failedSetup());
      expect(card.el.querySelector('.gv-card-title')?.textContent).toBe("A task's dependencies were not installed");
      expect(card.el.textContent).toContain('most likely a setup problem, not the work of the agent');
      expect(card.el.textContent).toContain('The install: npm exited with 1');
      // The buttons that do something here, and none that would revise the plan or check a failed task again.
      const names = [...card.el.querySelectorAll('.gv-actions button')].map((b) => b.textContent?.trim());
      expect(names).toEqual([
        'Install again',
        'Send it back to the agent',
        'Open the folder in VS Code',
        'Cancel task',
        'Later',
      ]);
      expect(buttonNamed(card.el, 'Install again').classList.contains('btn-primary')).toBe(true);
      expect(card.el.querySelector('textarea')).toBeNull();
      // What the install ran and printed is one step away, as text.
      const details = card.el.querySelector('.gv-details') as HTMLElement;
      expect(details.textContent).toContain('npm ci');
      expect(details.textContent).toContain(`npm ERR! network ${HOSTILE}`);
      expect(card.el.querySelector('img')).toBeNull();
      card.destroy();
    });

    it('Install again runs the install; when it fails again it says why and shows what it printed', async () => {
      const card = mount(
        failedSetup(),
        {},
        {
          [SETUP]: {
            setup: {
              status: 'failed',
              reason: 'npm exited with 1',
              command: 'npm',
              args: ['ci'],
              output_tail: 'npm ERR! still offline',
            },
          },
        },
      );
      arm(card.el);
      buttonNamed(card.el, 'Install again').click();
      await flush();
      expect(ctx.transport.to('POST', `/tasks/${TASK}/setup`)).toHaveLength(1);
      const result = card.el.querySelector('.gv-setup-result') as HTMLElement;
      expect(result.querySelector('.field-error')?.textContent).toBe('The install did not finish: npm exited with 1.');
      expect(result.textContent).toContain('npm ERR! still offline');
      // Still the first thing to do, and nothing was sent back or answered.
      expect(buttonNamed(card.el, 'Install again').classList.contains('btn-primary')).toBe(true);
      expect(ctx.transport.to('POST', `/tasks/${TASK}/rework`)).toHaveLength(0);
      expect(answers(ctx)).toEqual([]);
      card.destroy();
    });

    it('once it installs, sending the task back becomes the next step, and tells the agent why', async () => {
      const card = mount(
        failedSetup(),
        {},
        {
          [SETUP]: { setup: { status: 'passed', reason: 'ok', command: 'npm', args: ['ci'], output_tail: null } },
          [`POST /tasks/${TASK}/rework`]: { task: { task_id: TASK } },
        },
      );
      arm(card.el);
      buttonNamed(card.el, 'Install again').click();
      await flush();
      expect(card.el.querySelector('.gv-setup-ok')?.textContent).toContain(
        'Installed. Send the task back to its agent',
      );
      expect(buttonNamed(card.el, 'Install again').classList.contains('btn-primary')).toBe(false);
      const back = buttonNamed(card.el, 'Send it back to the agent');
      expect(back.classList.contains('btn-primary')).toBe(true);
      back.click();
      await flush();
      const sent = ctx.transport.to('POST', `/tasks/${TASK}/rework`);
      expect(sent).toHaveLength(1);
      expect((sent[0]?.body as { reason?: string } | undefined)?.reason).toContain(
        'The dependencies are installed in the task folder now',
      );
      card.destroy();
    });

    it('sends it back as it is when a person chooses to, and says the install was not fixed', async () => {
      const card = mount(failedSetup(), {}, { [`POST /tasks/${TASK}/rework`]: { task: { task_id: TASK } } });
      arm(card.el);
      buttonNamed(card.el, 'Send it back to the agent').click();
      await flush();
      const sent = ctx.transport.to('POST', `/tasks/${TASK}/rework`);
      expect((sent[0]?.body as { reason?: string } | undefined)?.reason).toContain('were not installed');
      expect(ctx.transport.to('POST', `/tasks/${TASK}/setup`)).toHaveLength(0);
      card.destroy();
    });

    it('says so when the project declares nothing to install', async () => {
      const card = mount(failedSetup(), {}, { [SETUP]: { setup: null } });
      arm(card.el);
      buttonNamed(card.el, 'Install again').click();
      await flush();
      expect(card.el.querySelector('.gv-setup-result')?.textContent).toContain(
        'Nothing was installed: this project declares no install for a task folder.',
      );
      card.destroy();
    });
  });

  describe('Master Brain kinds', () => {
    it('with a planner: Revise with a note answers the question, which revises the plan', async () => {
      const card = mount(
        makeEscalation({
          kind: 'replan_limit',
          goal_id: GOAL,
          requested_by_kind: 'master_brain',
          options: ['revise again ("friday goal replan --note …")'],
        }),
        {},
        {},
      );
      expect(card.el.querySelectorAll('.gv-chip')).toHaveLength(0);
      const note = card.el.querySelector('textarea') as HTMLTextAreaElement;
      note.value = 'split the API task';
      arm(card.el);
      buttonNamed(card.el, 'Revise with a note').click();
      await flush();
      expect(answers(ctx)).toEqual(['split the API task']);
      expect(ctx.transport.to('POST', '/replan')).toHaveLength(0);
      card.destroy();
    });

    it('without a planner: Write a revision opens the plan editor in revision mode', () => {
      const card = mount(makeEscalation({ kind: 'replan_limit', goal_id: GOAL, task_id: null }), {}, {}, false);
      expect(card.el.textContent).toContain('no key is stored');
      buttonNamed(card.el, 'Write a revision').click();
      expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: GOAL, mode: 'revision' });
      card.destroy();
    });

    describe('planning itself failed', () => {
      const failed = (kind: string, why: string) =>
        makeEscalation({
          kind,
          goal_id: GOAL,
          task_id: null,
          requested_by_kind: 'master_brain',
          question: `Friday cannot plan goal ${GOAL} (Add Stripe…): ${why}. How should it continue?`,
          options: ['enable the provider, then run "friday goal replan"', 'write the plan with "friday plan propose"'],
          details: { why, proposed_action: 'wait for a planner or a human-written plan', evidence: [] },
        });
      const buttons = (el: Element) =>
        [...el.querySelectorAll('.gv-actions:not(.gv-actions-end) button')].map((b) => b.textContent);

      it('says what happened in words, and asks the planner again from the card', async () => {
        const card = mount(failed('planner_unavailable', 'Claude Code said: Not logged in · Please run /login'));
        expect(card.el.querySelector('.gv-question-text')?.textContent).toBe('Friday could not plan this goal.');
        expect(card.el.querySelector('.gv-why')?.textContent).toBe(
          'The planner is not signed in. Sign in to it (for Claude Code: open Claude Code once and sign in), then try again.',
        );
        // The daemon's own sentence, with its ids and terminal commands, is one step away.
        const details = card.el.querySelector('details.gv-details') as HTMLDetailsElement;
        expect(details.open).toBe(false);
        expect(details.textContent).toContain(`Friday cannot plan goal ${GOAL}`);
        expect(card.el.querySelector('.gv-cli')).toBeNull();
        expect(card.el.textContent).not.toContain('friday goal replan');
        expect(buttons(card.el)).toEqual(['Try again', 'Write the plan myself', 'Planner settings']);
        arm(card.el);
        buttonNamed(card.el, 'Try again').click();
        await flush();
        // Answering is what makes the daemon plan again; a separate request would leave the question open.
        expect(answers(ctx)).toEqual(['Try again.']);
        expect(ctx.transport.calls.filter((c) => c.path.endsWith('/replan'))).toHaveLength(0);
        expect(card.el.querySelector('.gv-status')?.textContent).toContain('The planner was asked again');
        card.destroy();
      });

      it('sends what the person adds for the planner, and names each kind of trouble', async () => {
        const noted = mount(failed('invalid_plan', 'the output did not match the schema'));
        expect(noted.el.querySelector('.gv-why')?.textContent).toContain(
          'The planner answered, but not with a plan Friday could use.',
        );
        expect(buttons(noted.el)).toEqual(['Try again', 'Write the plan myself']);
        (noted.el.querySelector('textarea') as HTMLTextAreaElement).value = '  two tasks at most  ';
        arm(noted.el);
        buttonNamed(noted.el, 'Try again').click();
        await flush();
        expect(answers(ctx)).toEqual(['two tasks at most']);
        noted.destroy();
        for (const [kind, why, said, settings] of [
          ['planner_unavailable', 'Claude AI usage limit reached|1731855600', 'reached a usage limit', false],
          ['budget_exceeded', '$5.00 of $5.00 spent', 'spending limit for planning is used up', true],
          [
            'action_failed',
            `plan kept failing (4 attempts): boom ${HOSTILE}`,
            `The planner could not finish: plan kept failing (4 attempts): boom ${HOSTILE}`,
            false,
          ],
        ] as const) {
          const card = mount(failed(kind, why));
          expect(card.el.querySelector('.gv-why')?.textContent, kind).toContain(said);
          expect(buttons(card.el).includes('Planner settings'), kind).toBe(settings);
          expect(card.el.querySelector('img')).toBeNull();
          card.destroy();
        }
      });

      it('without a planner leads with writing the plan, and with Planner settings', () => {
        const card = mount(failed('planner_unavailable', 'no planner is configured'), {}, {}, false);
        expect(card.el.querySelector('.gv-why')?.textContent).toContain('No planner is ready on this computer.');
        expect(buttons(card.el)).toEqual(['Write the plan myself', 'Planner settings']);
        expect(buttonNamed(card.el, 'Write the plan myself').classList.contains('btn-primary')).toBe(true);
        buttonNamed(card.el, 'Write the plan myself').click();
        // A goal without a plan gets its first plan, not a "revision" of nothing.
        expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: GOAL, mode: 'first' });
        buttonNamed(card.el, 'Planner settings').click();
        expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'planner' });
        card.destroy();
      });

      it('keeps the task’s own buttons when the failure is about a task', () => {
        const card = mount(
          makeEscalation({ kind: 'planner_unavailable', goal_id: GOAL, details: { why: 'no planner is configured' } }),
        );
        expect(buttonNamed(card.el, 'Rework the task')).toBeTruthy();
        expect(card.el.textContent).not.toContain('Friday could not plan this goal.');
        card.destroy();
      });
    });

    it('Rework sends the task back; Planner settings opens the settings', async () => {
      const card = mount(
        makeEscalation({ kind: 'repeated_verification_failures', goal_id: GOAL }),
        {},
        { [`POST /tasks/${TASK}/rework`]: { task: {} } },
      );
      arm(card.el);
      buttonNamed(card.el, 'Rework the task').click();
      await flush();
      expect(ctx.transport.to('POST', `/tasks/${TASK}/rework`)).toHaveLength(1);
      card.destroy();
      const p = mount(makeEscalation({ kind: 'planner_unavailable', goal_id: null, task_id: null }));
      buttonNamed(p.el, 'Planner settings').click();
      expect(ctx.store.select('ui').drawer).toEqual({ kind: 'settings', tab: 'planner' });
      p.destroy();
    });
  });

  it('destroy removes its key scope and timers', () => {
    const card = mount(makeEscalation({ options: ['A'] }));
    const chip = card.el.querySelector('.gv-chip') as HTMLElement;
    userFocus(chip);
    card.destroy();
    expect(vi.getTimerCount()).toBe(0);
    const stray = document.createElement('button');
    document.body.appendChild(stray);
    press(stray, '1');
    expect(chip.getAttribute('aria-checked')).toBe('false');
  });
});
