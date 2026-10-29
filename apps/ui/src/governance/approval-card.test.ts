import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeContext, type TestContext } from '../test/context.js';
import { makeAgent, makeApproval, makeSnapshot, makeTask } from '../test/fixtures.js';
import { approvalCard } from './approval-card.js';
import { takeRequestedReach } from './decisions.js';

const HOSTILE_HTML = '<img src=x onerror=alert(1)>';
const LONG = 'x'.repeat(5000);

function move(el: Element, x = 10): void {
  el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, clientX: x, clientY: 10, movementX: 1 }));
}

function arm(el: Element): void {
  move(el);
  vi.advanceTimersByTime(700);
}

function press(target: Element, key: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

function userFocus(el: HTMLElement): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  el.focus();
}

function buttonNamed(root: Element, name: string): HTMLButtonElement {
  const b = [...root.querySelectorAll('button')].find((x) => x.textContent?.startsWith(name));
  if (!b) throw new Error(`no button ${name}`);
  return b;
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('approval card', () => {
  let ctx: TestContext;
  let forward: (e: KeyboardEvent) => void;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    ctx = makeContext({
      snapshot: makeSnapshot({
        agents: [makeAgent()],
        tasks: [makeTask()],
        approvals: [makeApproval()],
      }),
      answers: { 'POST /approvals/apr_000000000000000000000ap01/approve': { ok: true, status: 'granted' } },
    });
    forward = (e) => ctx.keys.handle(e);
    document.addEventListener('keydown', forward);
  });

  afterEach(() => {
    document.removeEventListener('keydown', forward);
    document.body.replaceChildren();
    vi.useRealTimers();
  });

  function mount(a = makeApproval(), opts = {}) {
    const card = approvalCard(ctx, a, opts);
    document.body.appendChild(card.el);
    vi.advanceTimersByTime(0);
    return card;
  }

  it('shows agent, task, capability, target and purpose, with hostile text as text and visible marks', () => {
    const card = mount(
      makeApproval({
        capability: `shell.${HOSTILE_HTML}`,
        target: `${HOSTILE_HTML} rm -rf /‮txt.exe​ ${LONG}`,
        purpose: `Bash: ${HOSTILE_HTML}‮`,
        risk: 'medium',
      }),
    );
    const el = card.el;
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('claude-1');
    expect(el.textContent).toContain('Add discount codes to pricing');
    const target = el.querySelector('.gv-target .agent-text');
    expect(target?.textContent).toContain(HOSTILE_HTML);
    expect(target?.textContent).toContain('⟨U+202E⟩');
    expect(target?.textContent).toContain('⟨U+200B⟩');
    expect(target?.textContent).toContain(LONG);
    expect(el.querySelector('.gv-target .hidden-warning')).not.toBeNull();
    expect(el.querySelector('.gv-purpose .hidden-warning')).not.toBeNull();
    expect(el.querySelector('.gv-risk')?.textContent).toBe('Medium risk');
    // Too long for the card: Allow once opens the full view.
    expect(el.querySelector('.gv-path-note')?.hasAttribute('hidden')).toBe(false);
    expect(el.textContent).toContain('expires in 1 h');
    card.destroy();
  });

  it('an expired request offers no decision', () => {
    const card = mount(makeApproval({ expired: true }));
    expect(card.el.querySelector('.gv-actions')?.hasAttribute('hidden')).toBe(true);
    expect(card.el.querySelector('.gv-expiry')?.textContent).toBe('expired');
    expect(card.el.textContent).toContain('This request expired');
    card.destroy();
  });

  it('expires while shown', () => {
    const card = mount(makeApproval({ expires_at: '2026-10-17T10:00:02.000Z' }));
    expect(card.el.querySelector('.gv-actions')?.hasAttribute('hidden')).toBe(false);
    ctx.clock.now += 3000;
    vi.advanceTimersByTime(3000);
    expect(card.el.querySelector('.gv-actions')?.hasAttribute('hidden')).toBe(true);
    card.destroy();
  });

  it('Allow once on low risk is one click, but only once the card armed', async () => {
    const card = mount();
    const once = buttonNamed(card.el, 'Allow once');
    move(card.el);
    once.click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    vi.advanceTimersByTime(700);
    once.click();
    await flush();
    const [call] = ctx.transport.to('POST', '/approvals/apr_000000000000000000000ap01/approve');
    expect(call?.body).toEqual({ reuse: 'once', via: 'ui' });
    expect(ctx.reactions[0]?.kind).toBe('approved');
    card.destroy();
  });

  it('Allow once on high risk opens the modal instead', async () => {
    const a = makeApproval({ risk: 'high' });
    const card = mount(a);
    arm(card.el);
    buttonNamed(card.el, 'Allow once').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(ctx.store.select('ui').modal).toEqual({ kind: 'approval', id: a.approval_id });
    expect(takeRequestedReach(a.approval_id)).toBe('once');
    card.destroy();
  });

  it('Allow for this task always opens the modal with the task reach', async () => {
    const a = makeApproval({ risk: 'low' });
    const card = mount(a);
    arm(card.el);
    buttonNamed(card.el, 'Allow for this task').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(ctx.store.select('ui').modal?.kind).toBe('approval');
    expect(takeRequestedReach(a.approval_id)).toBe('task');
    card.destroy();
  });

  it('Deny opens a reason field; Send denial sends it as the note', async () => {
    const card = mount();
    arm(card.el);
    buttonNamed(card.el, 'Deny').click();
    const reason = card.el.querySelector<HTMLInputElement>('.gv-deny-input');
    expect(reason).not.toBeNull();
    expect(card.el.querySelector('.gv-deny')?.hasAttribute('hidden')).toBe(false);
    expect(document.activeElement).toBe(reason);
    if (reason) reason.value = `${HOSTILE_HTML} use env vars`;
    buttonNamed(card.el, 'Send denial').click();
    await flush();
    const [call] = ctx.transport.to('POST', '/approvals/apr_000000000000000000000ap01/reject');
    expect(call?.body).toEqual({ via: 'ui', note: `${HOSTILE_HTML} use env vars` });
    card.destroy();
  });

  describe('keys (plan FD-28)', () => {
    it('1 / 2 / 3 do nothing while focus is outside the card', async () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const card = mount();
      arm(card.el);
      outside.focus();
      press(outside, '1');
      press(outside, '3');
      await flush();
      expect(ctx.transport.calls).toHaveLength(0);
      expect(card.el.querySelector('.gv-deny')?.hasAttribute('hidden')).toBe(true);
      card.destroy();
    });

    it('1 allows once while focus is inside the armed card', async () => {
      const card = mount();
      const once = buttonNamed(card.el, 'Allow once');
      userFocus(once);
      press(once, '1');
      await flush();
      expect(ctx.transport.calls).toHaveLength(0); // not armed yet
      vi.advanceTimersByTime(700);
      press(once, '1');
      await flush();
      expect(ctx.transport.to('POST', '/approvals/apr_000000000000000000000ap01/approve')).toHaveLength(1);
      card.destroy();
    });

    it('2 opens the modal and 3 opens the reason field', async () => {
      const card = mount();
      const deny = buttonNamed(card.el, 'Deny');
      userFocus(deny);
      vi.advanceTimersByTime(700);
      press(deny, '3');
      expect(card.el.querySelector('.gv-deny')?.hasAttribute('hidden')).toBe(false);
      const back = buttonNamed(card.el, 'Back');
      back.click();
      press(card.el.querySelector('button') as HTMLElement, '2');
      expect(ctx.store.select('ui').modal?.kind).toBe('approval');
      card.destroy();
    });

    it('keys typed in the reason field stay text', async () => {
      const card = mount();
      const deny = buttonNamed(card.el, 'Deny');
      userFocus(deny);
      vi.advanceTimersByTime(700);
      deny.click();
      const reason = card.el.querySelector('.gv-deny-input') as HTMLInputElement;
      expect(document.activeElement).toBe(reason);
      press(reason, '1');
      press(reason, '2');
      await flush();
      expect(ctx.transport.calls).toHaveLength(0);
      expect(ctx.store.select('ui').modal).toBeNull();
      card.destroy();
    });

    it('Esc never denies', async () => {
      const card = mount();
      const deny = buttonNamed(card.el, 'Deny');
      userFocus(deny);
      vi.advanceTimersByTime(700);
      press(deny, 'Escape');
      await flush();
      expect(ctx.transport.calls).toHaveLength(0);
      expect(card.el.querySelector('.gv-deny')?.hasAttribute('hidden')).toBe(true);
      card.destroy();
    });

    it('the key scope ends when focus leaves the card', async () => {
      const outside = document.createElement('button');
      document.body.appendChild(outside);
      const card = mount();
      const once = buttonNamed(card.el, 'Allow once');
      userFocus(once);
      vi.advanceTimersByTime(700);
      outside.focus();
      press(outside, '1');
      await flush();
      expect(ctx.transport.calls).toHaveLength(0);
      card.destroy();
    });
  });

  it('showing another approval in the same card re-arms it', async () => {
    const card = mount();
    arm(card.el);
    card.update(makeApproval({ approval_id: 'apr_000000000000000000000ap01', target: 'git push --force' }));
    buttonNamed(card.el, 'Allow once').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(card.el.textContent).toContain('git push --force');
    move(card.el, 30);
    vi.advanceTimersByTime(700);
    buttonNamed(card.el, 'Allow once').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(1);
    card.destroy();
  });

  it('destroy clears its timers', () => {
    const card = mount();
    move(card.el);
    card.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(card.el.isConnected).toBe(false);
  });
});
