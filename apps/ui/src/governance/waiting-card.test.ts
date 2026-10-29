import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeApproval, makeSnapshot, makeTask } from '../test/fixtures.js';
import { ATTACHED_HINT, waitingCard } from './waiting-card.js';

const HOSTILE = '<img src=x onerror=alert(1)>';
const TASK = 'task_0000000000000000000000aa01';

const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

function arm(el: Element): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: 5, clientY: 5, movementX: 1 }));
  vi.advanceTimersByTime(700);
}

function buttonNamed(root: Element, name: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.trim() === name);
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

describe('waiting card (plan §7.5, FD-22)', () => {
  let ctx: TestContext;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  });
  afterEach(() => {
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  const waiting = (over = {}) =>
    makeTask({
      status: 'WAITING',
      waiting_reason: 'blocked',
      agent_key: 'codex-1',
      waiting_note: `Which plan names? ${HOSTILE}‮​ ${'n'.repeat(5000)}`,
      ...over,
    });

  function mount(
    task = waiting(),
    answers: Record<string, unknown> = {},
    approvals = [] as ReturnType<typeof makeApproval>[],
  ) {
    ctx = makeContext({
      snapshot: makeSnapshot({ tasks: [task], approvals }),
      answers: {
        [`POST /tasks/${TASK}/continue`]: { continued: true, reason: null, task },
        [`POST /tasks/${TASK}/release`]: { task },
        [`POST /tasks/${TASK}/cancel`]: { task },
        ...answers,
      },
    });
    const card = waitingCard(ctx, task);
    document.body.appendChild(card.el);
    vi.advanceTimersByTime(0);
    return card;
  }

  it('shows the agent’s note in full with visible marks, as text', () => {
    const card = mount();
    const note = card.el.querySelector('.gv-waiting-note .agent-text')?.textContent ?? '';
    expect(card.el.querySelector('img')).toBeNull();
    expect(note).toContain(HOSTILE);
    expect(note).toContain('⟨U+202E⟩');
    expect(note).toContain('⟨U+200B⟩');
    expect(note).toContain('n'.repeat(5000));
    expect(card.el.querySelector('.gv-waiting-note .hidden-warning')).not.toBeNull();
    expect(card.el.textContent).toContain('codex-1');
    expect(card.el.textContent).toContain('An agent waits for you');
    card.destroy();
  });

  it('Answer and continue sends the note; Continue sends none', async () => {
    const card = mount();
    arm(card.el);
    buttonNamed(card.el, 'Answer and continue').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(card.el.textContent).toContain('Write the answer first.');
    (card.el.querySelector('textarea') as HTMLTextAreaElement).value = 'Basic and Pro';
    buttonNamed(card.el, 'Answer and continue').click();
    await flush();
    buttonNamed(card.el, 'Continue').click();
    await flush();
    expect(ctx.transport.to('POST', `/tasks/${TASK}/continue`).map((c) => c.body)).toEqual([
      { note: 'Basic and Pro' },
      {},
    ]);
    expect(ctx.refreshes).toBe(2);
    card.destroy();
  });

  it('when Friday cannot continue the session, it shows why and says to prompt it in VS Code', async () => {
    const card = mount(waiting(), {
      [`POST /tasks/${TASK}/continue`]: {
        continued: false,
        reason: `its session runs in an editor: ask it there to continue ${HOSTILE}`,
        task: waiting(),
      },
    });
    arm(card.el);
    buttonNamed(card.el, 'Continue').click();
    await flush();
    const box = card.el.querySelector('.gv-continue-reason') as HTMLElement;
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain('its session runs in an editor');
    expect(box.textContent).toContain(ATTACHED_HINT);
    expect(box.querySelector('img')).toBeNull();
    card.destroy();
  });

  it('decisions wait for the card to arm', async () => {
    const card = mount();
    buttonNamed(card.el, 'Continue').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    card.destroy();
  });

  it('Release and Cancel ask first', async () => {
    const card = mount();
    arm(card.el);
    ctx.confirmAnswer = false;
    buttonNamed(card.el, 'Release').click();
    await flush();
    buttonNamed(card.el, 'Cancel task').click();
    await flush();
    expect(ctx.confirms).toHaveLength(2);
    expect(ctx.transport.calls).toHaveLength(0);
    ctx.confirmAnswer = true;
    buttonNamed(card.el, 'Release').click();
    await flush();
    buttonNamed(card.el, 'Cancel task').click();
    await flush();
    expect(ctx.transport.calls.map((c) => c.path.split('/').slice(-1)[0])).toEqual(['release', 'cancel']);
    card.destroy();
  });

  it('a task waiting for an approval points to the approval', () => {
    const card = mount(waiting({ waiting_reason: 'human_approval' }), {}, [makeApproval({ task_id: TASK })]);
    expect(card.el.textContent).toContain('An agent waits for an approval');
    expect(card.el.textContent).toContain('Its approval request waits in the list');
    card.destroy();
  });
});
