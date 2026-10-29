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
      const card = mount(makeEscalation({ kind: 'invalid_plan', goal_id: GOAL, task_id: null }), {}, {}, false);
      expect(card.el.textContent).toContain('no key is stored');
      buttonNamed(card.el, 'Write a revision').click();
      expect(ctx.store.select('ui').modal).toEqual({ kind: 'plan-editor', id: GOAL, mode: 'revision' });
      card.destroy();
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
