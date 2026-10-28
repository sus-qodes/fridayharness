import { useTestWorkspace, waitForPidGone } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { runCheck, summarizeOutcome } from './index.js';

describe('runCheck', () => {
  const ws = useTestWorkspace();
  const node = (code: string, extra: Partial<Parameters<typeof runCheck>[0]> = {}) =>
    runCheck({ name: 'check', command: process.execPath, args: ['-e', code], cwd: ws().projectDir, ...extra });

  it('passes on exit 0 and captures output', async () => {
    const o = await node('console.log("3 tests passed")');
    expect(o).toMatchObject({ passed: true, exit_code: 0, timed_out: false, spawn_error: null });
    expect(o.output).toContain('3 tests passed');
    expect(summarizeOutcome(o)).toMatch(/^passed in \d+ ms: 3 tests passed$/);
  });

  it('fails on a non-zero exit', async () => {
    const o = await node('console.error("1 test failed"); process.exit(3)');
    expect(o).toMatchObject({ passed: false, exit_code: 3 });
    expect(summarizeOutcome(o)).toContain('failed (exit 3)');
  });

  it('kills the process tree on timeout', async () => {
    const o = await node(
      'const c=require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore"});console.log("child",c.pid);setInterval(()=>{},1000)',
      { timeoutMs: 800 },
    );
    expect(o).toMatchObject({ passed: false, timed_out: true });
    const child = Number(/child (\d+)/.exec(o.output)?.[1]);
    expect(child).toBeGreaterThan(0);
    expect(await waitForPidGone(child, 5000)).toBe(true);
    expect(summarizeOutcome(o)).toMatch(/timed out/);
  });

  it('reports a command that cannot start', async () => {
    const o = await runCheck({ name: 'missing', command: 'friday-no-such-binary', cwd: ws().projectDir });
    expect(o.passed).toBe(false);
    expect(o.spawn_error).toBeTruthy();
  });

  it('keeps only the tail of very large output', async () => {
    const o = await node('process.stdout.write("x".repeat(50000) + "END")', { maxOutputBytes: 1000 });
    expect(o.output_truncated).toBe(true);
    expect(o.output.length).toBe(1000);
    expect(o.output.endsWith('END')).toBe(true);
  });
});
