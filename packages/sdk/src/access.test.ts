import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedPrincipals, checkPrivateAccess, protectPrivateDir, resetAccessCache } from './access.js';
import { ensurePrivateDir, writePrivateFile } from './discovery.js';

const WIN = process.platform === 'win32';
const ICACLS = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe');
const EVERYONE_READ = '*S-1-1-0:(OI)(CI)R';

let base: string;
beforeEach(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'fr-acc-'));
  resetAccessCache();
});
afterEach(() => {
  if (WIN) execFileSync(ICACLS, [base, '/reset', '/T', '/C', '/Q'], { stdio: 'ignore' });
  rmSync(base, { recursive: true, force: true });
});

/** Opens a path to Everyone, the way a careless setup or an old tool might. */
function openToEveryone(p: string, recurse = false): void {
  if (WIN) execFileSync(ICACLS, [p, '/grant', EVERYONE_READ, ...(recurse ? ['/T'] : []), '/Q'], { stdio: 'ignore' });
  else chmodSync(p, 0o755);
}

describe('private directory access (review F02)', () => {
  it('parses allow entries out of an SDDL DACL', () => {
    expect(
      allowedPrincipals(
        'O:S-1-5-21-1D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(D;;FA;;;WD)(A;OICIID;0x1301bf;;;S-1-5-21-9)',
      ),
    ).toEqual(['SY', 'BA', 'S-1-5-21-9']);
  });

  it('creates a private directory nobody else can open, whatever the parent allows', () => {
    openToEveryone(base);
    const dir = path.join(base, 'projects', 'p1');
    ensurePrivateDir(dir);
    writePrivateFile(dir, 'operator.token', 'x'.repeat(40));
    const report = checkPrivateAccess(dir);
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it('reports a reused directory that others can open, then repairs it', () => {
    const dir = path.join(base, 'credentials');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'anthropic.key'), 'sk-test\n');
    openToEveryone(dir, true);
    if (!WIN) chmodSync(path.join(dir, 'anthropic.key'), 0o644);
    const before = checkPrivateAccess(dir);
    expect(before.ok).toBe(false);
    expect(before.problems.join(' ')).toMatch(WIN ? /Everyone/ : /mode/);
    expect(protectPrivateDir(dir).ok).toBe(true);
    expect(checkPrivateAccess(dir).ok).toBe(true);
  });

  it('finds a file inside a private directory that was opened up later', () => {
    const dir = path.join(base, 'projects', 'p2');
    ensurePrivateDir(dir);
    const file = writePrivateFile(dir, 'bootstrap.token', 'y'.repeat(40));
    if (WIN) execFileSync(ICACLS, [file, '/grant', '*S-1-1-0:R', '/Q'], { stdio: 'ignore' });
    else chmodSync(file, 0o644);
    const report = checkPrivateAccess(dir);
    expect(report.ok).toBe(false);
    expect(report.problems.join(' ')).toContain('bootstrap.token');
    resetAccessCache();
    expect(protectPrivateDir(dir).ok).toBe(true);
  });

  it('says when the directory does not exist', () => {
    expect(checkPrivateAccess(path.join(base, 'missing'))).toMatchObject({ ok: false, problems: ['does not exist'] });
  });
});
