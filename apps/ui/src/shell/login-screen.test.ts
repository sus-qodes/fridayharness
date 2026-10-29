import { describe, expect, it, vi } from 'vitest';
import { type LoginReason, loginCopy, loginScreen, NO_SESSION_MESSAGE, USED_LINK_MESSAGE } from './login-screen.js';

const REASONS: LoginReason[] = [
  'no-session',
  'used-link',
  'sw-removed',
  'unreachable',
  'stopped',
  'signed-out',
  'error',
];
const HOSTILE = '<img src=x onerror=alert(1)>';

describe('login screens (plan §7.1)', () => {
  it('says what to do for every reason, and that a session lasts at most 12 hours', () => {
    for (const reason of REASONS) {
      const screen = loginScreen(reason);
      const text = screen.el.textContent ?? '';
      expect(text).toContain('at most 12 hours');
      expect(screen.el.querySelector('h1')?.textContent).toBe(loginCopy(reason).title);
      screen.destroy();
    }
  });

  it('uses the plan wording', () => {
    expect(NO_SESSION_MESSAGE).toBe(
      'Open Friday from its shortcut or the desktop app, or run friday ui in the project.',
    );
    expect(USED_LINK_MESSAGE).toBe('This link was already used or has expired; open Friday again.');
    expect(loginScreen('no-session').el.querySelector('.sh-login-command')?.textContent).toBe('friday ui');
    expect(loginScreen('used-link').el.textContent).toContain(USED_LINK_MESSAGE);
    expect(loginScreen('sw-removed').el.textContent).toContain(
      'Friday removed a leftover service worker for this address; open Friday again.',
    );
    expect(loginScreen('unreachable').el.textContent).toContain('Friday is not reachable here');
  });

  it('shows a hostile project name and detail as text, hidden characters made visible', () => {
    const screen = loginScreen('signed-out', {
      projectName: `${HOSTILE}‮​${'x'.repeat(5000)}`,
      detail: `${HOSTILE}‮${'y'.repeat(5000)}`,
    });
    expect(screen.el.querySelector('img')).toBeNull();
    const project = screen.el.querySelector('.sh-login-for strong')?.textContent ?? '';
    expect(project.startsWith(HOSTILE)).toBe(true);
    expect(project).toContain('⟨U+200B⟩');
    const detail = screen.el.querySelector('.sh-login-detail')?.textContent ?? '';
    expect(detail.startsWith(HOSTILE)).toBe(true);
    expect(detail).not.toContain('‮');
    expect(Array.from(detail).length).toBeLessThanOrEqual(400);
  });

  it('names the project in the sign-in sentence when known', () => {
    const screen = loginScreen('no-session', { projectName: 'shop' });
    expect(screen.el.querySelector('.sh-login-message')?.textContent).toBe(
      'Open Friday from its shortcut or the desktop app, or run friday ui in the project shop.',
    );
  });

  it('offers its action as a real button', () => {
    const run = vi.fn();
    const screen = loginScreen('unreachable', { action: { label: 'Try again', run } });
    const b = screen.el.querySelector('button') as HTMLButtonElement;
    expect(b.type).toBe('button');
    b.click();
    expect(run).toHaveBeenCalledOnce();
    expect(loginScreen('no-session').el.querySelector('button')).toBeNull();
  });
});
