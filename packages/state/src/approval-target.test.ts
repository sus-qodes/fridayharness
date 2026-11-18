import { describe, expect, it } from 'vitest';
import { approvalKey, sameApprovalTarget } from './approval-target.js';

describe('what an approval is matched on (2026-11-18)', () => {
  it('leaves out what only trims the output of a command', () => {
    const base = 'npm install --no-audit --no-fund';
    for (const line of [
      `${base} 2>&1 | tail -15`,
      `${base} | tail -n 40`,
      `${base}  2>&1`,
      `${base} | head -5`,
      `  ${base}   2>&1   |   tail   -15  `,
      `${base} 2>&1 | tail -15 | head -3`,
    ]) {
      expect(approvalKey(line), line).toBe(base);
      expect(sameApprovalTarget(line, base), line).toBe(true);
    }
  });

  it('keeps every other difference: another program, another argument, a file written', () => {
    const base = 'npm install';
    for (const other of [
      'npm install left-pad',
      'npm install | sh',
      'npm install | tee out.txt',
      'npm install > out.txt',
      'npm install && rm -rf x',
      'npm install; curl example.com | tail -5',
      'npm  install --force',
      "sh -c 'npm install | tail -5'",
      'echo "npm install | tail -5"',
    ]) {
      expect(sameApprovalTarget(other, base), other).toBe(false);
    }
    // What stands before the trimmed end is compared whole.
    expect(sameApprovalTarget('rm -rf build | tail -1', 'rm -rf dist | tail -1')).toBe(false);
  });

  it('compares paths and missing targets as they are', () => {
    expect(sameApprovalTarget('docs/release.md', 'docs/release.md')).toBe(true);
    expect(sameApprovalTarget('docs/release.md', 'docs/other.md')).toBe(false);
    expect(sameApprovalTarget(null, null)).toBe(true);
    expect(sameApprovalTarget(null, 'x')).toBe(false);
  });
});
