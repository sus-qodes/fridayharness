import { describe, expect, it } from 'vitest';
import { achievedWords, doctorTone, fixWords, setupChecksView } from './setup-checks.js';
import { HOSTILE } from './test-support.js';

describe('a setup’s health check, in words', () => {
  it('says what each result means for the person', () => {
    expect(achievedWords('L1 enforcing', 'Claude Code')).toEqual({
      tone: 'good',
      text: 'Ready. Friday checks what Claude Code does before it happens.',
    });
    expect(achievedWords('L1 degraded', 'Claude Code')?.tone).toBe('warn');
    expect(achievedWords('L1 unverified', 'Antigravity')?.text).toContain('marks its work “Unverified”');
    expect(achievedWords('L0 observed', 'Antigravity')?.text).toContain('can only watch Antigravity');
    expect(achievedWords('not attached', 'Claude Code')).toMatchObject({ tone: 'danger' });
    expect(achievedWords(' NOT ATTACHED ', 'Claude Code')?.text).toContain('Not connected yet');
    // A result this page does not know is shown as it is, never dropped.
    expect(achievedWords(`L9 ${HOSTILE}`, 'x')).toEqual({ tone: 'muted', text: `L9 ${HOSTILE}` });
    expect(achievedWords(undefined, 'x')).toBeNull();
    expect(achievedWords('', 'x')).toBeNull();
  });

  it('turns the check’s terminal commands into what the dialog offers', () => {
    expect(fixWords('re-run "friday harness config claude-code"', 'Claude Code')).toBe(
      'Apply this setup again: Preview, then Apply.',
    );
    expect(fixWords('re-run "friday harness config antigravity"', 'Antigravity')).toBe(
      'Apply this setup again: Preview, then Apply.',
    );
    expect(fixWords('run "friday run"', 'Claude Code')).toBe('Start Friday again, then Preview.');
    expect(fixWords('restart with "friday run"', 'Claude Code')).toBe('Start Friday again, then Preview.');
    expect(fixWords('run "pnpm build" in the Friday repository, then "friday setup"', 'Claude Code')).toBe(
      'Friday is not completely installed on this computer: install it again.',
    );
    expect(fixWords('install Claude Code, or set CLAUDE_CODE_BIN', 'Claude Code')).toBe(
      'Install Claude Code, then Preview again.',
    );
    expect(fixWords('update Claude Code', 'Claude Code')).toBe('Update Claude Code, then Preview again.');
    expect(
      fixWords(
        'open Claude Code here once and accept the trust prompt; headless runs can pass --allowedTools',
        'Claude Code',
      ),
    ).toBe('Open Claude Code on this folder once and accept its trust prompt.');
    // Anything else is said as the check said it.
    expect(fixWords(`trust the folder ${HOSTILE}`, 'Antigravity')).toBe(`trust the folder ${HOSTILE}`);
  });

  it('reads a status as a tone', () => {
    expect(['ok', 'PASS', 'warn', 'fail', 'error', 'info', ''].map(doctorTone)).toEqual([
      'good',
      'good',
      'warn',
      'danger',
      'danger',
      'muted',
      'muted',
    ]);
  });

  it('shows what needs attention, the failures first, and folds the rest', () => {
    const el = setupChecksView(
      {
        achieved: 'not attached',
        checks: [
          { id: 'cc.binary', status: 'ok', message: 'Claude Code 2.1.301' },
          {
            id: 'cc.skill',
            status: 'warn',
            message: 'the friday skill is missing',
            fix: 're-run "friday harness config claude-code"',
          },
          { id: 'cc.daemon', status: 'fail', message: `the daemon is not running ${HOSTILE}`, fix: 'run "friday run"' },
          { id: 'cc.old', status: 'fail', detail: 'an older answer keeps its detail' },
          { id: 'cc.silent', status: 'warn' },
        ],
      },
      'Claude Code',
    );
    expect(el.querySelector('.pn-checks-summary')?.textContent).toContain('Not connected yet');
    expect(el.querySelector('.pn-checks-summary')?.classList.contains('pn-tone-danger')).toBe(true);
    const items = Array.from(el.querySelectorAll('.pn-checks-attention > li'));
    expect(items.map((li) => li.getAttribute('title'))).toEqual(['cc.daemon', 'cc.old', 'cc.skill', 'cc.silent']);
    expect(items[0]?.textContent).toBe(
      `Needs fixingthe daemon is not running ${HOSTILE}What to do: Start Friday again, then Preview.`,
    );
    expect(items[1]?.textContent).toBe('Needs fixingan older answer keeps its detail');
    expect(items[3]?.textContent).toBe('Worth a lookThis check gave no detail.');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('details.pn-checks-passed summary')?.textContent).toBe('1 check with nothing to do');
    expect(el.textContent).not.toContain('cc.');
  });

  it('says when nothing needs attention, and when the check gave no answer', () => {
    const fine = setupChecksView(
      { achieved: 'L1 enforcing', checks: [{ id: 'a', status: 'ok', message: 'fine' }] },
      'Claude Code',
    );
    expect(fine.textContent).toContain('Ready. Friday checks what Claude Code does before it happens.');
    expect(fine.textContent).toContain('Nothing needs attention.');
    expect(fine.querySelector('.pn-checks-attention')).toBeNull();
    const empty = setupChecksView({ achieved: 'L1 enforcing', checks: [] }, 'Claude Code');
    expect(empty.textContent).not.toContain('Nothing needs attention.');
    expect(empty.querySelector('details')).toBeNull();
    expect(setupChecksView(null, 'Claude Code').textContent).toBe('Friday could not check the setup.');
    expect(setupChecksView(undefined, 'Claude Code').textContent).toBe('Friday could not check the setup.');
    const failed = setupChecksView({ error: `timed out ${HOSTILE}` }, 'Claude Code');
    expect(failed.textContent).toBe(`Friday could not check the setup: timed out ${HOSTILE}`);
    expect(failed.querySelector('img')).toBeNull();
  });
});
