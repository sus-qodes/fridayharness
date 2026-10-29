import { describe, expect, it } from 'vitest';
import { notStartedText, statusLook, TASK_STATUS, waitsForHuman } from './status.js';
import { fits, hasHidden, mark, visible } from './text.js';

describe('visible escapes (plan §6.2)', () => {
  it('shows bidi, zero-width and control characters as marks and keeps tabs and newlines', () => {
    expect(visible('rm -rf /‮txt.exe')).toBe('rm -rf /⟨U+202E⟩txt.exe');
    expect(visible('a​b﻿c')).toBe('a⟨U+200B⟩b⟨U+FEFF⟩c');
    expect(visible('x\u0007y\u0085z')).toBe('x⟨U+0007⟩y⟨U+0085⟩z');
    expect(visible('a\tb\nc')).toBe('a\tb\nc');
    expect(visible('⁦left⁩')).toBe('⟨U+2066⟩left⟨U+2069⟩');
    expect(mark('‎')).toBe('⟨U+200E⟩');
  });

  it('says whether hidden characters are present, repeatedly', () => {
    expect(hasHidden('plain text')).toBe(false);
    expect(hasHidden('a‮b')).toBe(true);
    expect(hasHidden('a‮b')).toBe(true);
  });

  it('marks every character the desktop dialog marks, and the tag characters (review M9i)', () => {
    // The Arabic letter mark reorders "1 2" to read "2 1"; separators hide a tail; tags hide a message.
    expect(visible('cp ؜1 2')).toBe('cp ⟨U+061C⟩1 2');
    expect(visible('a­b᠎c')).toBe('a⟨U+00AD⟩b⟨U+180E⟩c');
    expect(visible('ok rm -rf / ')).toBe('ok⟨U+2028⟩rm -rf /⟨U+2029⟩');
    expect(visible('yes\u{e0041}\u{e0042}')).toBe('yes⟨U+E0041⟩⟨U+E0042⟩');
    expect(hasHidden('cp ؜1 2')).toBe(true);
    // Line separators no longer count as one line: their marks are counted where they stand.
    expect(fits(`ok${' '.repeat(60)}`)).toBe(false);
  });

  it('judges whether a target fits the card', () => {
    expect(fits('npm test')).toBe(true);
    expect(fits('x'.repeat(48 * 6))).toBe(true);
    expect(fits('x'.repeat(48 * 6 + 1))).toBe(false);
    expect(fits(['a', 'b', 'c', 'd', 'e', 'f', 'g'].join('\n'))).toBe(false);
  });
});

describe('status looks', () => {
  it("says why a READY task has not started, without the rule's own prefix", () => {
    expect(notStartedText('waits: its write scope overlaps a task that is running')).toBe(
      'Not started yet: its write scope overlaps a task that is running',
    );
    expect(notStartedText('no agent of role qa is free')).toBe('Not started yet: no agent of role qa is free');
  });

  it('covers every task status Friday uses', () => {
    for (const s of [
      'PROPOSED',
      'READY',
      'ASSIGNED',
      'RUNNING',
      'WAITING',
      'READY_FOR_VERIFICATION',
      'VERIFYING',
      'COMPLETED',
      'FAILED',
      'REWORK',
      'HARNESS_LOST',
      'CANCELLED',
    ]) {
      expect(TASK_STATUS[s as keyof typeof TASK_STATUS]?.color).toMatch(/^var\(--/);
    }
    expect(statusLook('SOMETHING_NEW').label).toBe('SOMETHING_NEW');
  });

  it('counts blocked agents and approval waits as waiting for a human', () => {
    expect(waitsForHuman({ status: 'WAITING', waiting_reason: 'blocked' })).toBe(true);
    expect(waitsForHuman({ status: 'WAITING', waiting_reason: 'dependency_wait' })).toBe(false);
    expect(waitsForHuman({ status: 'RUNNING', waiting_reason: null })).toBe(false);
  });
});
