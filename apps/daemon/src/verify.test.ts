import { describe, expect, it } from 'vitest';
import { evidenceOfRunning } from './verify.js';

/** Evidence that the work was run: what the hooks saw, bounded by what the claim says (S07). */
describe('evidence that the work was run', () => {
  const sh = (text: string, command_class: string | null) => ({ text, command_class });

  it('fails a claim that names no check when no test, build or lint command ran', () => {
    const r = evidenceOfRunning({
      claimed: [],
      executed: [sh('cat src/a.py', 'read.local'), sh('git status', 'git.read')],
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toBe('nothing shows the work was run');
    expect(r.findings).toEqual([expect.objectContaining({ rule: 'evidence.none', severity: 'fail' })]);
  });

  it('passes on a test, build or lint command the hooks saw, whatever the claim says', () => {
    const r = evidenceOfRunning({ claimed: [], executed: [sh('pytest -q', 'test.local')] });
    expect(r).toEqual({ ok: true, summary: '1 test, build or lint command(s) ran', findings: [] });
    expect(evidenceOfRunning({ claimed: [], executed: [sh('python3 -m py_compile a.py', 'lint.local')] }).ok).toBe(
      true,
    );
  });

  it('passes on a check the claim names, confirmed by a command seen, else with a warning', () => {
    const seen = sh('cd /tmp && python3 /app/filter.py t.html && cat t.html', 'git.mutate');
    const confirmed = evidenceOfRunning({
      claimed: [{ name: 'filter on a sample', command: 'python3 /app/filter.py t.html', outcome: 'passed' }],
      executed: [seen],
    });
    expect(confirmed).toEqual({ ok: true, summary: 'the claim names 1 check(s)', findings: [] });
    const unseen = evidenceOfRunning({
      claimed: [{ name: 'the suite', command: 'pytest tests/', outcome: 'passed' }],
      executed: [seen],
    });
    expect(unseen.ok).toBe(true);
    expect(unseen.summary).toBe('the claim names 1 check(s), 1 not seen run');
    expect(unseen.findings).toEqual([expect.objectContaining({ rule: 'evidence.unconfirmed', severity: 'warn' })]);
    // A check without a command is the agent's word: accepted, nothing to confirm.
    expect(evidenceOfRunning({ claimed: [{ name: 'ran it by hand', outcome: 'passed' }], executed: [] }).ok).toBe(true);
  });

  it('counts a skipped check as no evidence', () => {
    const r = evidenceOfRunning({ claimed: [{ name: 'tests', outcome: 'skipped' }], executed: [] });
    expect(r.ok).toBe(false);
  });
});
