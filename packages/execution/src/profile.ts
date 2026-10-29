import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { isInside, sensitiveInText } from '@friday/policy';

/**
 * The execution profile (ADR-0029 §4, `L2-profile`): what checks and operations run with. The
 * command is a binary on the profile's list, resolved to a real path outside the project; the
 * process gets a minimal environment instead of the daemon's; its arguments may not name Friday's
 * private state. It does not stop the process from reading the user's other files or using the
 * network, and the processes it starts may run any binary: isolation by the OS is M9.
 */
export interface ExecutionProfile {
  /** Binary names the profile runs (without `.exe` and the like). */
  binaries: readonly string[];
  /** Variables of the daemon's environment passed through as they are (trusted loosening). */
  envPassthrough: readonly string[];
  /** Folders a binary must not come from: the project, its task worktrees, Friday's state. */
  forbiddenRoots: readonly string[];
  /** The daemon's environment: its PATH finds the binaries, its system variables are kept. */
  base: NodeJS.ProcessEnv;
  /** Friday's per-user state folder: arguments may not name it. */
  stateDir?: string;
  /** Platform override for tests. */
  windows?: boolean;
}

/** A command the profile refused, with the rule that refused it. */
export class ProfileError extends Error {
  constructor(
    readonly rule: string,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileError';
  }
}

export interface ResolvedBinary {
  /** The binary's name on the list. */
  name: string;
  /** Absolute real path. */
  path: string;
  /** A Windows `.cmd` or `.bat` shim: runs through `cmd.exe`. */
  viaCmd: boolean;
}

const isWindows = (p: ExecutionProfile) => p.windows ?? process.platform === 'win32';

/** A variable of an environment object, ignoring case on Windows as Windows does. */
export function envValue(env: NodeJS.ProcessEnv, name: string, windows: boolean): string | undefined {
  if (!windows) return env[name];
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

const WIN_EXT = /\.(?:exe|cmd|bat|com)$/i;

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function realOf(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/** The folders a binary may not come from, as given and as real paths. */
function forbidden(profile: ExecutionProfile): string[] {
  const roots = profile.stateDir ? [...profile.forbiddenRoots, profile.stateDir] : [...profile.forbiddenRoots];
  return [...new Set(roots.flatMap((r) => [r, realOf(r)]))];
}

/**
 * Resolves a command to a binary on the profile's list: a bare name is looked up on the daemon's
 * PATH (with PATHEXT on Windows), an absolute path is taken as it is. A copy inside the project, a
 * task worktree or Friday's state folder is never used.
 */
export function resolveBinary(command: string, profile: ExecutionProfile): ResolvedBinary {
  const windows = isWindows(profile);
  const lib = windows ? path.win32 : path.posix;
  const absolute = lib.isAbsolute(command);
  if (!absolute && /[\\/]/.test(command)) {
    throw new ProfileError(
      'binary.relative',
      `"${command}" is a path inside the checkout; checks and operations run a binary such as "node"`,
    );
  }
  const base = lib.basename(command);
  const name = windows ? base.replace(WIN_EXT, '') : base;
  const listed = profile.binaries.some((b) => (windows ? b.toLowerCase() === name.toLowerCase() : b === name));
  if (!listed) {
    throw new ProfileError(
      'binary.not_listed',
      `${name} is not on the execution profile's binary list (${profile.binaries.join(', ')}); a project adds one with execution.binaries`,
    );
  }
  const exts = windows
    ? WIN_EXT.test(base)
      ? ['']
      : (envValue(profile.base, 'PATHEXT', true) ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .map((e) => e.trim())
          .filter((e) => /^\.[A-Za-z0-9]+$/.test(e) && WIN_EXT.test(`x${e}`))
    : [''];
  const dirs = absolute
    ? [lib.dirname(command)]
    : (envValue(profile.base, 'PATH', windows) ?? '')
        .split(windows ? ';' : ':')
        .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
        // A relative entry such as "." would find whatever the working folder holds.
        .filter((d) => d && lib.isAbsolute(d));
  const blocked = forbidden(profile);
  let skipped: string | null = null;
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = lib.join(dir, `${base}${ext}`);
      if (!isFile(candidate)) continue;
      const real = realOf(candidate);
      if (blocked.some((root) => isInside(real, root, windows) || isInside(candidate, root, windows))) {
        skipped ??= candidate;
        continue;
      }
      return { name, path: real, viaCmd: windows && /\.(?:cmd|bat)$/i.test(real) };
    }
  }
  throw new ProfileError(
    'binary.not_found',
    skipped
      ? `${name} was only found inside the project or Friday's folders (${skipped}), which the profile never runs`
      : `${name} was not found on the daemon's PATH`,
  );
}

/** Windows variables a toolchain needs; nothing that holds a credential. */
const WINDOWS_VARS = [
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'USERNAME',
  'USERDOMAIN',
  'COMPUTERNAME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramW6432',
  'CommonProgramFiles',
  'CommonProgramFiles(x86)',
  'CommonProgramW6432',
  'TZ',
];
const POSIX_VARS = [
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TZ',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'XDG_RUNTIME_DIR',
];

const paths = new WeakMap<ExecutionProfile, string>();

/** The PATH the process gets: the system folders and the folders of the profile's binaries. */
export function profilePath(profile: ExecutionProfile): string {
  const known = paths.get(profile);
  if (known !== undefined) return known;
  const windows = isWindows(profile);
  const lib = windows ? path.win32 : path.posix;
  const system = windows
    ? (() => {
        const root = envValue(profile.base, 'SystemRoot', true) ?? 'C:\\Windows';
        return [
          lib.join(root, 'System32'),
          root,
          lib.join(root, 'System32', 'Wbem'),
          lib.join(root, 'System32', 'WindowsPowerShell', 'v1.0'),
        ];
      })()
    : ['/usr/local/bin', '/usr/bin', '/bin'];
  const binaryDirs: string[] = [];
  for (const b of profile.binaries) {
    try {
      binaryDirs.push(lib.dirname(resolveBinary(b, profile).path));
    } catch {
      // not installed on this machine
    }
  }
  const seen = new Set<string>();
  const joined = [...binaryDirs, ...system]
    .filter((d) => {
      const k = windows ? d.toLowerCase() : d;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(windows ? ';' : ':');
  paths.set(profile, joined);
  return joined;
}

/**
 * The environment a check or an operation runs with: the system variables, a fresh temporary
 * folder, the profile's PATH, the passed-through names, then the run's own variables. Nothing of
 * Friday's (no `FRIDAY_` variable, no token, no provider key) and nothing else of the daemon's.
 */
export function profileEnvironment(
  profile: ExecutionProfile,
  opts: { tempDir: string; env?: Record<string, string>; credentials?: Record<string, string> },
): NodeJS.ProcessEnv {
  const windows = isWindows(profile);
  const out: NodeJS.ProcessEnv = {};
  for (const name of [...(windows ? WINDOWS_VARS : POSIX_VARS), ...profile.envPassthrough]) {
    if (/^FRIDAY_/i.test(name)) continue;
    const v = envValue(profile.base, name, windows);
    if (v !== undefined) out[name] = v;
  }
  out.PATH = profilePath(profile);
  if (windows) {
    out.TEMP = opts.tempDir;
    out.TMP = opts.tempDir;
  } else {
    out.TMPDIR = opts.tempDir;
  }
  return { ...out, ...(opts.env ?? {}), ...(opts.credentials ?? {}) };
}

/** Characters `cmd.exe` would expand or that would end a quoted argument. */
const CMD_UNSAFE = /["%\r\n\0]/;

/**
 * Arguments and the working folder: neither may name Friday's private state or the main checkout's
 * runtime files, and the folder stays inside the checkout. Through `cmd.exe`, an argument it would
 * expand is refused.
 */
export function checkArguments(
  args: readonly string[],
  cwd: string,
  root: string,
  profile: ExecutionProfile,
  viaCmd = false,
): void {
  const windows = isWindows(profile);
  const ctx = { projectRoot: root, windows, ...(profile.stateDir ? { stateDir: profile.stateDir } : {}) };
  args.forEach((a, i) => {
    const hit = sensitiveInText(a, ctx);
    if (hit && (hit.class === 'friday.private' || hit.class === 'friday.runtime')) {
      throw new ProfileError('argument.private', `argument ${i + 1} names Friday's private state (${hit.class})`);
    }
    if (viaCmd && CMD_UNSAFE.test(a)) {
      throw new ProfileError(
        'argument.cmd_unsafe',
        `argument ${i + 1} holds a character cmd.exe would expand (" or %), which a .cmd binary cannot be given safely`,
      );
    }
  });
  if (!isInside(cwd, root, windows)) {
    throw new ProfileError('cwd.outside', `the working folder ${cwd} is outside the checkout ${root}`);
  }
  if (profile.stateDir && isInside(cwd, profile.stateDir, windows)) {
    throw new ProfileError('cwd.private', "the working folder is inside Friday's private state");
  }
  if (!existsSync(cwd)) throw new ProfileError('cwd.missing', `the working folder ${cwd} does not exist`);
}
