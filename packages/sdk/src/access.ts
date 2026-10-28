import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Who may open Friday's private directories (ADR-0008, review F02). Tokens and provider keys
 * live there, so a directory is accepted only when nobody but the current user can read it:
 *
 * - Windows: every allow entry of the directory and of everything in it names the current user,
 *   SYSTEM or the local Administrators group (administrators can take ownership of any file, so
 *   excluding them would promise nothing). Profile folders often grant more than that, so Friday
 *   sets an explicit, non-inherited ACL on each directory it owns.
 * - POSIX: the directory is owned by the current user with mode 0700, files 0600.
 */
export interface AccessReport {
  path: string;
  /** True when only the allowed principals can open the directory and its files. */
  ok: boolean;
  /** One line per problem, in terms a user can act on. */
  problems: string[];
  /** How the check was made. */
  method: 'windows-acl' | 'posix-mode';
}

const SYSTEM32 = path.join(process.env.SystemRoot ?? process.env.SYSTEMROOT ?? 'C:\\Windows', 'System32');
const ICACLS = path.join(SYSTEM32, 'icacls.exe');
const WHOAMI = path.join(SYSTEM32, 'whoami.exe');

/** Well-known principals that may hold access besides the user (SDDL aliases and their SIDs). */
const ALLOWED_WELL_KNOWN = new Set(['SY', 'S-1-5-18', 'BA', 'S-1-5-32-544', 'CO', 'S-1-3-0', 'OW', 'S-1-3-4']);
const NAMES: Record<string, string> = {
  WD: 'Everyone',
  'S-1-1-0': 'Everyone',
  AU: 'Authenticated Users',
  'S-1-5-11': 'Authenticated Users',
  BU: 'Users',
  'S-1-5-32-545': 'Users',
  IU: 'Interactive users',
  AN: 'Anonymous',
  BG: 'Guests',
};

let userSid: string | undefined;

/** The current user's SID (`whoami /user`), from System32 so a Git Bash `whoami` is never used. */
export function currentUserSid(): string {
  if (userSid) return userSid;
  const out = execFileSync(WHOAMI, ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10_000,
  });
  const sid = /"(S-1-[0-9-]+)"/.exec(out)?.[1];
  if (!sid) throw new Error(`could not read the current user's SID from whoami: ${out.trim()}`);
  userSid = sid;
  return sid;
}

interface Entry {
  name: string;
  sddl: string;
}

/** DACLs of a directory and everything below it, as SDDL (`icacls /save`, locale-independent). */
function readAcls(dir: string): Entry[] {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fr-acl-'));
  const out = path.join(tmp, 'acl.txt');
  try {
    execFileSync(ICACLS, [dir, '/save', out, '/T', '/C', '/Q'], {
      windowsHide: true,
      timeout: 20_000,
      stdio: 'ignore',
    });
    const lines = readFileSync(out, 'utf16le')
      .replace(/^\uFEFF/, '')
      .split(/\r?\n/);
    const entries: Entry[] = [];
    for (let i = 0; i + 1 < lines.length; i += 2) {
      const name = lines[i] ?? '';
      const sddl = lines[i + 1] ?? '';
      if (name) entries.push({ name, sddl });
    }
    return entries;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Principals with an allow entry in an SDDL DACL (`D:` part). */
export function allowedPrincipals(sddl: string): string[] {
  const dacl = sddl.slice(sddl.indexOf('D:') + 2).split(/S:/)[0] ?? '';
  const out: string[] = [];
  for (const m of dacl.matchAll(/\(([^)]*)\)/g)) {
    const fields = (m[1] ?? '').split(';');
    if (fields[0] === 'A' && fields[5]) out.push(fields[5]);
  }
  return out;
}

function principalName(sid: string): string {
  return NAMES[sid] ?? sid;
}

function checkWindows(dir: string): AccessReport {
  const me = currentUserSid();
  const problems: string[] = [];
  let entries: Entry[];
  try {
    entries = readAcls(dir);
  } catch (e) {
    return { path: dir, ok: false, problems: [`cannot read the ACL: ${(e as Error).message}`], method: 'windows-acl' };
  }
  if (entries.length === 0) problems.push('icacls returned no ACL');
  for (const e of entries) {
    const others = [...new Set(allowedPrincipals(e.sddl))].filter((s) => s !== me && !ALLOWED_WELL_KNOWN.has(s));
    if (others.length) {
      const where = e.name === path.basename(dir) || entries.indexOf(e) === 0 ? 'the directory' : e.name;
      problems.push(`${where} is also open to ${others.map(principalName).join(', ')}`);
    }
  }
  return { path: dir, ok: problems.length === 0, problems: problems.slice(0, 10), method: 'windows-acl' };
}

function checkPosix(dir: string): AccessReport {
  const problems: string[] = [];
  const uid = process.getuid?.();
  const walk = (p: string, depth: number) => {
    const st = statSync(p);
    if (uid !== undefined && st.uid !== uid) problems.push(`${p} is owned by uid ${st.uid}, not ${uid}`);
    if ((st.mode & 0o077) !== 0)
      problems.push(`${p} has mode ${(st.mode & 0o777).toString(8)} (group or others can access it)`);
    if (st.isDirectory() && depth < 4) for (const n of readdirSync(p)) walk(path.join(p, n), depth + 1);
  };
  try {
    walk(dir, 0);
  } catch (e) {
    problems.push(`cannot inspect: ${(e as Error).message}`);
  }
  return { path: dir, ok: problems.length === 0, problems: problems.slice(0, 10), method: 'posix-mode' };
}

/** Read-only check of a private directory (for `friday doctor`). */
export function checkPrivateAccess(dir: string): AccessReport {
  if (!existsSync(dir)) return { path: dir, ok: false, problems: ['does not exist'], method: methodFor() };
  return process.platform === 'win32' ? checkWindows(dir) : checkPosix(dir);
}

function methodFor(): AccessReport['method'] {
  return process.platform === 'win32' ? 'windows-acl' : 'posix-mode';
}

function protectWindows(dir: string): void {
  const me = currentUserSid();
  const grants = [`*${me}:(OI)(CI)F`, '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F'];
  const run = (args: string[]) =>
    execFileSync(ICACLS, [dir, ...args], { windowsHide: true, timeout: 20_000, stdio: 'ignore' });
  // Children first back to plain inheritance (drops explicit entries anyone added), then the
  // directory gets its own ACL that no longer inherits from the profile.
  run(['/reset', '/T', '/C', '/Q']);
  run(['/inheritance:r', '/grant:r', ...grants, '/Q']);
}

function protectPosix(dir: string): void {
  const walk = (p: string, depth: number) => {
    const st = statSync(p);
    chmodSync(p, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory() && depth < 4) for (const n of readdirSync(p)) walk(path.join(p, n), depth + 1);
  };
  walk(dir, 0);
}

const verified = new Set<string>();

/**
 * Makes a directory Friday owns private and verifies the result (review F02). Cheap after the
 * first call in a process. Throws when the directory still is not private, so callers never
 * write a token or key into a place other accounts can read.
 */
export function protectPrivateDir(dir: string): AccessReport {
  const key = path.resolve(dir).toLowerCase();
  if (verified.has(key)) return { path: dir, ok: true, problems: [], method: methodFor() };
  let report = checkPrivateAccess(dir);
  if (!report.ok) {
    try {
      if (process.platform === 'win32') protectWindows(dir);
      else protectPosix(dir);
    } catch (e) {
      throw new Error(`cannot make ${dir} private: ${(e as Error).message}`);
    }
    report = checkPrivateAccess(dir);
    if (!report.ok) throw new Error(`cannot make ${dir} private: ${report.problems.join('; ')}`);
  }
  verified.add(key);
  return report;
}

/** Forgets earlier verifications (tests change ACLs behind Friday's back). */
export function resetAccessCache(): void {
  verified.clear();
}
