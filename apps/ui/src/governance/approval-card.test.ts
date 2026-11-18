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

  it('says what the agent asks as the act it is, and keeps the policy’s name for it one hover away (2026-11-17)', () => {
    const card = approvalCard(ctx, makeApproval({ capability: 'package.install', target: 'npm install zod' }));
    document.body.appendChild(card.el);
    const rows = [...card.el.querySelectorAll('.gv-meta-row')].map((r) => [
      r.querySelector('dt')?.textContent,
      r.querySelector('dd')?.textContent,
    ]);
    expect(rows.at(-1)).toEqual(['Asks to', 'Install packages']);
    const asks = card.el.querySelector('.gv-meta-row:last-child dd') as HTMLElement;
    expect(asks.title).toBe('package.install');
    expect(asks.classList.contains('mono')).toBe(false);
    // Exactly what would run is shown in full under it, as before.
    expect(card.el.querySelector('.gv-target')?.textContent).toContain('Exactly this');
    expect(card.el.querySelector('.gv-target')?.textContent).toContain('npm install zod');
    expect(card.el.querySelector('.gv-purpose')?.textContent).toContain('The agent’s reason');
    card.destroy();
    // One Friday has no words for is shown as the policy names it.
    const other = approvalCard(ctx, makeApproval({ capability: 'future.thing' }));
    const dd = other.el.querySelector('.gv-meta-row:last-child dd') as HTMLElement;
    expect(dd.textContent).toBe('future.thing');
    expect(dd.classList.contains('mono')).toBe(true);
    other.destroy();
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

  // Friday asks for an agent it started that was stopped at the edge of its task's files
  // (2026-11-18): the file, for the rest of the task, is the first choice.
  it('offers the file for the task first when the request is for one file outside the task', async () => {
    const a = makeApproval({
      capability: 'file.write',
      target: 'packages/config/eslint/boundaries.js',
      purpose: 'Edit: packages/config/eslint/boundaries.js is outside the files this task may change (src/**).',
      reuse: 'task',
      risk: 'low',
    });
    const card = mount(a);
    const names = [...card.el.querySelectorAll('.gv-actions:not([hidden]) > button')].map(
      (b) => b.querySelector('span')?.textContent,
    );
    expect(names.slice(0, 3)).toEqual(['Allow this file…', 'Just this edit', 'Deny']);
    expect(buttonNamed(card.el, 'Allow this file…').classList.contains('btn-primary')).toBe(true);
    expect(buttonNamed(card.el, 'Just this edit').classList.contains('btn-primary')).toBe(false);
    expect(buttonNamed(card.el, 'Allow this file…').getAttribute('aria-keyshortcuts')).toBe('1');
    arm(card.el);
    ctx.confirmAnswer = true;
    buttonNamed(card.el, 'Allow this file…').click();
    await flush();
    expect(ctx.transport.to('POST', `/approvals/${a.approval_id}/approve`).map((c) => c.body)).toEqual([
      expect.objectContaining({ reuse: 'task' }),
    ]);
    // Shown another request, the same card goes back to its usual order.
    card.update(
      makeApproval({ approval_id: 'apr_other', capability: 'shell.npm.run', target: 'npm test', reuse: 'once' }),
    );
    expect(
      [...card.el.querySelectorAll('.gv-actions:not([hidden]) > button')]
        .map((b) => b.querySelector('span')?.textContent)
        .slice(0, 2),
    ).toEqual(['Allow once', 'Allow for this task…']);
    expect(buttonNamed(card.el, 'Allow once').classList.contains('btn-primary')).toBe(true);
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

  it('Allow for this task… (the dots: one confirmation follows) grants for the task from the card (2026-11-18)', async () => {
    const a = makeApproval({ risk: 'low' });
    const card = mount(a);
    arm(card.el);
    expect(buttonNamed(card.el, 'Allow for this task').textContent).toContain('Allow for this task…');
    // Saying no changes nothing.
    ctx.confirmAnswer = false;
    buttonNamed(card.el, 'Allow for this task…').click();
    await flush();
    expect(ctx.confirms.at(-1)?.title).toBe('Allow this for the whole task?');
    expect([ctx.confirms.at(-1)?.body].flat().join(' ')).toContain('again on this task without asking');
    expect(ctx.transport.calls).toHaveLength(0);
    // A yes grants it: no second view, no hold.
    ctx.confirmAnswer = true;
    buttonNamed(card.el, 'Allow for this task…').click();
    await flush();
    expect(ctx.store.select('ui').modal).toBeFalsy();
    const sent = ctx.transport.to('POST', `/approvals/${a.approval_id}/approve`);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toMatchObject({ reuse: 'task' });
    card.destroy();
  });

  it('on the desktop asks nothing itself: the shell shows its own confirmation for the whole task', async () => {
    const a = makeApproval({ risk: 'medium' });
    const card = mount(a);
    (ctx as { platform: unknown }).platform = { ...ctx.platform, kind: 'tauri', desktop: {} };
    arm(card.el);
    buttonNamed(card.el, 'Allow for this task…').click();
    await flush();
    expect(ctx.confirms).toHaveLength(0);
    expect(ctx.transport.to('POST', `/approvals/${a.approval_id}/approve`).map((c) => c.body)).toMatchObject([
      { reuse: 'task' },
    ]);
    card.destroy();
  });

  it('a high-risk request still goes to the full view for the whole task, where its host opens it', async () => {
    const a = makeApproval({ risk: 'high' });
    const card = mount(a);
    arm(card.el);
    buttonNamed(card.el, 'Allow for this task…').click();
    await flush();
    expect(ctx.transport.calls).toHaveLength(0);
    expect(ctx.store.select('ui').modal?.kind).toBe('approval');
    expect(takeRequestedReach(a.approval_id)).toBe('task');
    card.destroy();
    // In the Notch the full view is the Studio's: the card asks its host for it, and opens nothing itself.
    const opened: string[] = [];
    const inNotch = approvalCard(ctx, makeApproval({ risk: 'high', approval_id: 'apr_notch' }), {
      compact: true,
      onFull: () => opened.push('studio'),
    });
    document.body.appendChild(inNotch.el);
    ctx.store.patch('ui', { modal: null });
    vi.advanceTimersByTime(0);
    arm(inNotch.el);
    buttonNamed(inNotch.el, 'Allow for this task…').click();
    await flush();
    expect(opened).toEqual(['studio']);
    expect(ctx.store.select('ui').modal).toBeFalsy();
    inNotch.destroy();
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
      await flush();
      // The same as its button: one confirmation, then the grant for the task.
      expect(ctx.confirms.at(-1)?.title).toBe('Allow this for the whole task?');
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
