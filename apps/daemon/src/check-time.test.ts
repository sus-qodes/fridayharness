/**
 * A check's time limit (2026-11-19, the trial's F8): lint took 116 s of its 120 s while another
 * agent worked, 25 s alone. A check that runs out of time gets a second try with twice the time,
 * is said as having run out of time, and the limit its times call for is suggested.
 */
import { mkdirSync } from 'node:fs';
import type { ExecutionProfile } from '@friday/execution';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { RAN_OUT_OF_TIME, runCheckWithSecondTry, suggestedLimit, timedSummary } from './check-time.js';

describe('a check that runs out of time', () => {
  const ws = useTestWorkspace();
  const profile = (): ExecutionProfile => ({
    binaries: ['node'],
    envPassthrough: [],
    forbiddenRoots: [ws().projectDir],
    base: process.env,
    stateDir: ws().stateDir,
  });
  const spec = (code: string, timeoutMs: number) => {
    const root = ws().projectDir;
    mkdirSync(root, { recursive: true });
    return { name: 'lint', command: 'node', args: ['-e', code], root, cwd: root, timeoutMs };
  };

  it('is run again with twice the time, and passing then is a pass that says so', async () => {
    // Takes 2.5 s: more than its 2 s, less than 4 s.
    const r = await runCheckWithSecondTry(profile(), spec('setTimeout(() => {}, 2500)', 2000));
    expect(r.first_limit_ms).toBe(2000);
    expect(r.outcome).toMatchObject({ passed: true, timed_out: false });
    const said = timedSummary('lint', r, 2000);
    expect(said.summary).toBe('ran out of its 2 s time limit; on a second try with 4 s it passed');
    expect(said.finding).toMatchObject({ rule: RAN_OUT_OF_TIME, severity: 'warn' });
    expect(said.finding?.message).toContain('Give it more time in Settings → Checks');
  }, 60_000);

  it('that never ends runs out of time twice, and is said as that, not as failed work', async () => {
    const r = await runCheckWithSecondTry(profile(), spec('setInterval(() => {}, 1000)', 1000));
    expect(r.first_limit_ms).toBe(1000);
    expect(r.outcome).toMatchObject({ passed: false, timed_out: true });
    const said = timedSummary('lint', r, 1000);
    expect(said.summary).toBe('ran out of time twice: stopped at its 1 s limit, then at 2 s');
    expect(said.finding).toMatchObject({ rule: RAN_OUT_OF_TIME, severity: 'fail' });
    expect(said.finding?.message).toContain('may be waiting for something');
  }, 60_000);

  it('that finishes in time is run once, and said as before', async () => {
    const r = await runCheckWithSecondTry(profile(), spec('process.exit(2)', 20_000));
    expect(r.first_limit_ms).toBeNull();
    expect(r.outcome).toMatchObject({ passed: false, timed_out: false, exit_code: 2 });
    const said = timedSummary('lint', r, 20_000);
    expect(said.summary).toMatch(/^failed \(exit 2\)/);
    expect(said.finding).toBeNull();
  }, 60_000);
});

describe('the time limit to suggest', () => {
  it('is three times the longest it took, in whole minutes, at least two, at most sixty', () => {
    // The trial: lint 116 s beside another agent; tests 64 s alone.
    expect(suggestedLimit(120_000, 116_400)).toBe(360_000);
    expect(suggestedLimit(120_000, 64_000)).toBe(240_000);
    // Quick checks need nothing more than the two minutes they have.
    expect(suggestedLimit(120_000, 25_000)).toBeNull();
    expect(suggestedLimit(60_000, 5_000)).toBe(120_000);
    // A limit already long enough is left alone; never more than an hour.
    expect(suggestedLimit(600_000, 116_400)).toBeNull();
    expect(suggestedLimit(1_800_000, 1_500_000)).toBe(3_600_000);
    expect(suggestedLimit(3_600_000, 3_600_000)).toBeNull();
    // Never run: nothing to go by.
    expect(suggestedLimit(120_000, null)).toBeNull();
    expect(suggestedLimit(120_000, 0)).toBeNull();
  });
});
