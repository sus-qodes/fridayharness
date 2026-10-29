/**
 * Shell command classification (spec Part 07 §12): command classes, not a blacklist.
 * This is a heuristic over bash, PowerShell and cmd syntax. It is documented as such
 * (ADR-0010): it narrows what an attached agent can do without asking, it is not a sandbox.
 */
export type CommandClass =
  | 'read.local'
  | 'git.read'
  | 'test.local'
  | 'build.local'
  | 'lint.local'
  | 'git.mutate'
  | 'package.install'
  | 'fs.destructive'
  | 'process.kill'
  | 'network.fetch'
  | 'unknown'
  | 'git.push'
  | 'git.force'
  | 'network.publish'
  | 'secrets.read'
  | 'friday.internal';

export type Autonomy = 'auto' | 'review' | 'manual' | 'never';

/**
 * The shell a command is written for. It decides what a backtick means: bash runs the command
 * inside a pair of them, PowerShell escapes the next character, cmd prints it. A command whose shell
 * is not known is read as POSIX, the stricter reading (LESSONS D-45).
 */
export type Shell = 'posix' | 'powershell' | 'cmd';
/** Whether POSIX syntax applies: to `posix`, and to a shell not known. */
const posixSyntax = (shell: Shell | undefined) => shell !== 'powershell' && shell !== 'cmd';
/** Where a backtick runs the command inside a pair of them (`case … esac` is a construct in the same shells). */
const runsBackticks = posixSyntax;

export const DEFAULT_AUTONOMY: Record<CommandClass, Autonomy> = {
  'read.local': 'auto',
  'git.read': 'auto',
  'test.local': 'auto',
  'build.local': 'auto',
  'lint.local': 'auto',
  'git.mutate': 'review',
  'package.install': 'review',
  'fs.destructive': 'review',
  'process.kill': 'review',
  'network.fetch': 'review',
  unknown: 'review',
  'git.push': 'manual',
  'git.force': 'manual',
  'network.publish': 'manual',
  'secrets.read': 'never',
  'friday.internal': 'never',
};

const RANK: Record<Autonomy, number> = { auto: 0, review: 1, manual: 2, never: 3 };

/**
 * Splits a command line on && || ; | & and newlines, ignoring separators inside quotes and inside
 * brackets: a PowerShell block or a subshell stays one segment, and `partsOf` judges what it holds.
 * A lone `&` ends a command that runs in the background (`(rm -rf y) &`, `nohup cmd &`) or, in cmd,
 * separates two (`dir & del x`); left in the segment it hid the command before it (M11.1 review).
 * It is kept where it belongs to a redirection (`2>&1`, `&> f`) and where it opens a segment with a
 * command after it, as PowerShell's call operator (`& "C:\…\node.exe" -v`).
 */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i] as string;
    const next = command[i + 1];
    if (quote) {
      cur += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      cur += ch;
      continue;
    }
    if (ch === '(' || ch === '{') depth += 1;
    else if ((ch === ')' || ch === '}') && depth > 0) depth -= 1;
    if (
      depth === 0 &&
      (ch === '\n' ||
        ch === ';' ||
        (ch === '&' && next === '&') ||
        (ch === '|' && next === '|') ||
        ch === '|' ||
        (ch === '&' && backgroundAmpersand(command, i, cur)))
    ) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      if ((ch === '&' || ch === '|') && next === ch) i += 1;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * Whether the `&` at `i` ends the command before it (or stands alone): not part of a redirection
 * (`2>&1`, `>&2`, `<&0`, `&>f`, `|&`), and, where nothing stands before it in the segment, not
 * followed by a command, which would make it PowerShell's call operator.
 */
function backgroundAmpersand(command: string, i: number, before: string): boolean {
  const prev = command[i - 1] ?? '';
  const next = command[i + 1] ?? '';
  if ('<>|&'.includes(prev) || next === '>' || next === '&') return false;
  return before.trim() !== '' || /^\s*(?:[;|\n]|$)/.test(command.slice(i + 1));
}

function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of segment.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/**
 * Words that only pass a command on: `sudo git push` is `git push`. Standing alone, each is judged as
 * itself: `env` with nothing after it dumps the environment, secrets included.
 */
const PASS_THROUGH = new Set(['sudo', 'npx', 'call', '&', 'time', 'nohup', 'env']);

/** Drops env assignments and wrappers (sudo, npx, pnpm exec, powershell -c, cmd /c, call, &). */
function unwrap(ws: string[]): string[] {
  let w = [...ws];
  for (let guard = 0; guard < 6; guard += 1) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] as string)) w = w.slice(1);
    // A host may name the shell by its full path (`"C:\WINDOWS\…\powershell.exe" -Command …`, ADR-0032 §4).
    const head = programName(w[0] ?? '');
    if (PASS_THROUGH.has(head) && w.length > 1) {
      w = w.slice(1);
      continue;
    }
    // POSIX `command git push`, `builtin cd x`, `exec node x` run what follows them; `command -v x`
    // only looks a program up, and is judged as itself.
    if (['command', 'builtin', 'exec'].includes(head) && !/^-[vV]$/.test(w[1] ?? '')) {
      w = w.slice(1);
      if (w[0] === '-p') w = w.slice(1);
      continue;
    }
    if (
      (head === 'pnpm' || head === 'yarn' || head === 'bun') &&
      ['exec', 'dlx', 'x'].includes((w[1] ?? '').toLowerCase())
    ) {
      w = w.slice(2);
      continue;
    }
    if (['powershell', 'pwsh', 'cmd', 'bash', 'sh'].includes(head)) {
      const idx = w.findIndex((x, i) => i > 0 && /^(-c|-command|\/c|\/k|-lc)$/i.test(x));
      // The flag with no command after it: the shell takes its command at run time (from `xargs`,
      // a terminal), which no rule knows, so the shell's own word is judged, as unknown.
      if (idx > 0 && idx === w.length - 1) return [w[0] as string];
      if (idx > 0) {
        w = words(w.slice(idx + 1).join(' '));
        continue;
      }
    }
    break;
  }
  return w;
}

const has = (ws: string[], ...flags: string[]) => ws.some((x) => flags.includes(x.toLowerCase()));

export function classifySegment(segment: string): CommandClass {
  const ws = unwrap(words(segment));
  if (ws.length === 0) return 'read.local';
  const cmd = (ws[0] as string)
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
  const sub = (ws[1] ?? '').toLowerCase();
  const rest = ws.slice(1).map((x) => x.toLowerCase());
  const text = ws.join(' ').toLowerCase();

  // Friday's own CLI acts with operator authority: an agent must use the friday_* MCP tools instead.
  if (cmd === 'friday') {
    return ['status', 'tasks', 'harnesses', 'agents', 'doctor', 'help', '--help', '-h', '--version', '-v'].includes(
      sub,
    ) ||
      (sub === 'task' && rest[1] === 'inspect') ||
      (sub === 'events' && rest[1] === 'tail')
      ? 'read.local'
      : 'friday.internal';
  }

  // Secrets and environment dumps.
  if (['printenv', 'env', 'set'].includes(cmd) && ws.length === 1) return 'secrets.read';
  if ((cmd === 'get-childitem' || cmd === 'gci' || cmd === 'dir' || cmd === 'ls') && /\benv:/.test(text))
    return 'secrets.read';
  if (/\$env:[a-z_]*(key|token|secret|password)/i.test(text)) return 'secrets.read';

  if (cmd === 'git') {
    // Options before the subcommand (`--no-pager`, `-C <dir>`) are skipped; a `-c` setting can run
    // commands (an alias, a hook path), which no rule knows.
    if (sub.startsWith('-')) {
      let k = 1;
      for (; k < ws.length && (ws[k] as string).startsWith('-'); k += 1) {
        const o = ws[k] as string;
        const lo = o.toLowerCase();
        if (o === '-c' || lo.startsWith('--config-env') || lo.startsWith('--exec-path=')) return 'unknown';
        if (o === '-C' || ['--git-dir', '--work-tree', '--namespace'].includes(lo)) k += 1;
      }
      if (k >= ws.length) return 'git.read';
      return classifySegment(['git', ...ws.slice(k)].map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' '));
    }
    if (sub === 'push')
      return has(rest, '--force', '-f', '--force-with-lease', '--mirror', '--delete') ? 'git.force' : 'git.push';
    if (sub === 'reset' && has(rest, '--hard')) return 'git.force';
    if (sub === 'clean') return 'fs.destructive';
    if ((sub === 'checkout' || sub === 'restore') && (rest.includes('--') || rest.includes('.'))) return 'git.force';
    if (sub === 'branch' && has(rest, '-d', '-D', '--delete')) return 'git.mutate';
    if (['rebase', 'filter-branch', 'filter-repo', 'update-ref', 'reflog'].includes(sub)) return 'git.force';
    if (['fetch', 'pull', 'clone', 'ls-remote', 'remote'].includes(sub))
      return sub === 'remote' && rest[1] !== 'add' && rest[1] !== 'set-url' ? 'git.read' : 'network.fetch';
    if (
      [
        'status',
        'diff',
        'log',
        'show',
        'branch',
        'rev-parse',
        'ls-files',
        'blame',
        'grep',
        'describe',
        'shortlog',
        'cat-file',
        'merge-base',
        'tag',
      ].includes(sub)
    ) {
      return sub === 'tag' && rest.length > 1 && !has(rest, '-l', '--list') ? 'git.mutate' : 'git.read';
    }
    if (sub === 'config') return has(rest, '--get', '--list', '-l', '--get-all') ? 'git.read' : 'git.mutate';
    return 'git.mutate';
  }

  if (['rm', 'rmdir', 'rd', 'del', 'erase', 'remove-item', 'ri', 'format', 'shred', 'mkfs'].includes(cmd)) {
    const recursive = has(rest, '-r', '-rf', '-fr', '-R', '/s', '-recurse', '--recursive', '-force');
    return recursive || ['format', 'shred', 'mkfs'].includes(cmd) ? 'fs.destructive' : 'git.mutate';
  }
  if (['kill', 'taskkill', 'stop-process', 'spps', 'pkill', 'killall'].includes(cmd)) return 'process.kill';

  if (
    [
      'curl',
      'wget',
      'invoke-webrequest',
      'iwr',
      'invoke-restmethod',
      'irm',
      'ssh',
      'scp',
      'sftp',
      'ftp',
      'nc',
      'ncat',
      'telnet',
      'rsync',
    ].includes(cmd)
  ) {
    const mutating = has(
      rest,
      '-x',
      '--request',
      '-d',
      '--data',
      '--data-binary',
      '--data-raw',
      '-f',
      '--form',
      '-t',
      '--upload-file',
      '-method',
      '-body',
      '-infile',
    );
    return mutating || ['scp', 'rsync'].includes(cmd) ? 'network.publish' : 'network.fetch';
  }
  if (['docker', 'podman'].includes(cmd) && ['push', 'login'].includes(sub)) return 'network.publish';
  if (cmd === 'gh' && ['release', 'pr', 'issue', 'api', 'repo', 'secret'].includes(sub)) return 'network.publish';
  if (cmd === 'twine' && sub === 'upload') return 'network.publish';

  const pkg = ['npm', 'pnpm', 'yarn', 'bun'].includes(cmd);
  if (pkg) {
    if (['publish', 'unpublish', 'deprecate', 'owner', 'dist-tag', 'login', 'adduser'].includes(sub))
      return 'network.publish';
    if (
      [
        'install',
        'i',
        'add',
        'ci',
        'update',
        'up',
        'upgrade',
        'remove',
        'rm',
        'uninstall',
        'un',
        'link',
        'dedupe',
        'approve-builds',
      ].includes(sub) ||
      (cmd === 'yarn' && ws.length === 1)
    ) {
      return 'package.install';
    }
    const script = sub === 'run' || sub === 'run-script' ? (rest[1] ?? '') : sub;
    if (/^test/.test(script) || script === 't') return 'test.local';
    if (/^(lint|format|check|typecheck|fmt)/.test(script)) return 'lint.local';
    if (/^(build|compile)/.test(script)) return 'build.local';
    if (
      [
        'ls',
        'list',
        'view',
        'info',
        'outdated',
        'why',
        'config',
        'root',
        'bin',
        'audit',
        'explain',
        '--version',
        '-v',
      ].includes(sub)
    )
      return 'read.local';
    return 'unknown';
  }
  if (
    [
      'pip',
      'pip3',
      'uv',
      'poetry',
      'pipx',
      'gem',
      'composer',
      'choco',
      'winget',
      'scoop',
      'apt',
      'apt-get',
      'brew',
      'install-module',
      'install-package',
    ].includes(cmd)
  ) {
    if (['list', 'show', 'freeze', 'search', 'info'].includes(sub)) return 'read.local';
    return 'package.install';
  }
  if (cmd === 'cargo')
    return sub === 'test'
      ? 'test.local'
      : sub === 'build' || sub === 'check'
        ? 'build.local'
        : sub === 'clippy' || sub === 'fmt'
          ? 'lint.local'
          : ['add', 'install', 'remove', 'update'].includes(sub)
            ? 'package.install'
            : sub === 'publish'
              ? 'network.publish'
              : 'unknown';
  if (cmd === 'go')
    return sub === 'test'
      ? 'test.local'
      : sub === 'build' || sub === 'vet'
        ? 'build.local'
        : ['get', 'install'].includes(sub)
          ? 'package.install'
          : 'unknown';
  if (cmd === 'dotnet')
    return sub === 'test'
      ? 'test.local'
      : sub === 'build'
        ? 'build.local'
        : ['add', 'restore', 'tool'].includes(sub)
          ? 'package.install'
          : 'unknown';

  if (cmd === 'node') {
    if (has(rest, '--test')) return 'test.local';
    if (has(rest, '--version', '-v')) return 'read.local';
    return 'unknown';
  }
  if (['vitest', 'jest', 'mocha', 'pytest', 'ava', 'tap', 'playwright'].includes(cmd)) return 'test.local';
  if (cmd === 'python' || cmd === 'python3' || cmd === 'py')
    return rest[0] === '-m' && ['pytest', 'unittest'].includes(rest[1] ?? '') ? 'test.local' : 'unknown';
  if (
    ['tsc', 'make', 'cmake', 'msbuild', 'gradle', 'mvn', 'esbuild', 'vite', 'webpack', 'rollup', 'tsup'].includes(cmd)
  ) {
    return cmd === 'tsc' && has(rest, '--noemit')
      ? 'lint.local'
      : cmd === 'gradle' || cmd === 'mvn'
        ? rest.some((r) => r.includes('test'))
          ? 'test.local'
          : 'build.local'
        : 'build.local';
  }
  if (['eslint', 'biome', 'prettier', 'ruff', 'flake8', 'black', 'mypy', 'stylelint', 'shellcheck'].includes(cmd)) {
    return has(rest, '--write', '--fix', '-w') && cmd !== 'biome' ? 'lint.local' : 'lint.local';
  }

  // `find` lists files, unless it deletes them or writes a list into a file; what `-exec` runs is a
  // segment of its own (`findParts`).
  if (cmd === 'find') {
    if (rest.includes('-delete')) return 'fs.destructive';
    if (rest.some((r) => ['-fprint', '-fprint0', '-fprintf', '-fls'].includes(r))) return 'git.mutate';
  }
  // `command -v x` and `command -V x` look a program up.
  if (cmd === 'command' && /^-[vV]$/.test(ws[1] ?? '')) return 'read.local';

  const readOnly = [
    'ls',
    'dir',
    'pwd',
    'cd',
    'chdir',
    'set-location',
    'sl',
    'echo',
    'write-output',
    'write-host',
    'cat',
    'type',
    'get-content',
    'gc',
    'more',
    'less',
    'head',
    'tail',
    'wc',
    'find',
    'grep',
    'rg',
    'findstr',
    'select-string',
    'sls',
    'tree',
    'which',
    'where',
    'get-command',
    'gcm',
    'get-childitem',
    'gci',
    'test-path',
    'resolve-path',
    'get-location',
    'gl',
    'stat',
    'file',
    'sort',
    'uniq',
    'diff',
    'fc',
    'date',
    'get-date',
    'whoami',
    'hostname',
    'uname',
    'ver',
    'true',
    'false',
    'measure-object',
    'select-object',
    'format-table',
    'ft',
    'format-list',
    'fl',
    'out-string',
    'convertfrom-json',
    'convertto-json',
    'jq',
    'sed',
    'awk',
    'cut',
    'tr',
    'basename',
    'dirname',
    // PowerShell's pipeline and path cmdlets (their script blocks are judged on their own).
    'where-object',
    '?',
    'sort-object',
    'group-object',
    'get-item',
    'gi',
    'split-path',
    'join-path',
    'get-member',
    'gm',
    'get-filehash',
    'compare-object',
    'format-wide',
    'out-null',
    'out-host',
    'write-error',
    'write-warning',
    'write-verbose',
    'write-information',
    'start-sleep',
    // POSIX tests and `read` (into a variable) run nothing; what they substitute is judged on its own.
    '[',
    '[[',
    'test',
    'read',
    // Control flow that runs nothing.
    'exit',
    'return',
    'break',
    'continue',
    'throw',
  ];
  // ForEach-Object runs its script block (judged on its own) or, given a name, a method of each item.
  if (cmd === 'foreach-object' || cmd === '%') {
    return rest.every((r) => ['-process', '-begin', '-end'].includes(r)) ? 'read.local' : 'unknown';
  }
  if (readOnly.includes(cmd)) {
    // sed -i / awk -i inplace edit files.
    if ((cmd === 'sed' && rest.some((r) => r.startsWith('-i'))) || (cmd === 'awk' && rest.includes('inplace')))
      return 'git.mutate';
    return 'read.local';
  }
  if (
    [
      'mkdir',
      'md',
      'new-item',
      'ni',
      'touch',
      'cp',
      'copy',
      'copy-item',
      'mv',
      'move',
      'move-item',
      'ren',
      'rename',
      'rename-item',
      'set-content',
      'add-content',
      'out-file',
      'tee',
      'chmod',
      'chown',
    ].includes(cmd)
  ) {
    return 'git.mutate';
  }
  return 'unknown';
}

export interface CommandClassification {
  /** Most restrictive class across all segments. */
  class: CommandClass;
  autonomy: Autonomy;
  segments: { text: string; class: CommandClass }[];
}

const SHELLS = new Set(['powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh']);

/** The tokens of a segment as written, quotes kept: `sh -c 'rm x'` must stay one argument for `wrappedCommand`. */
function tokensOf(segment: string): string[] {
  return segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
}

/** A program's name from the word that names it: without quotes, its directory or a Windows extension, in lower case. */
function programName(token: string): string {
  return token
    .replace(/^"([^"]*)"$|^'([^']*)'$/, '$1$2')
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat|ps1)$/, '');
}

/**
 * A segment without the words in front of its program that only pass it on: environment assignments
 * (`FOO=1 cmd`), the `PASS_THROUGH` wrappers, and `command`, `builtin` and `exec`. What they pass on
 * is read for what it is: `sudo find … -exec rm {} \;` deletes, `env bash -c '…'` runs a shell whose
 * command is split again. A word standing alone is kept (`env`).
 */
function afterPrefixes(segment: string): string {
  let s = segment.trimStart();
  for (;;) {
    const m = /^("[^"]*"|'[^']*'|\S+)\s+/.exec(s);
    if (!m) return s;
    const token = m[1] as string;
    const rest = s.slice(m[0].length);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
      s = rest;
      continue;
    }
    const name = programName(token);
    if (PASS_THROUGH.has(name)) {
      s = rest;
      continue;
    }
    if (['command', 'builtin', 'exec'].includes(name) && !/^-[vV](\s|$)/.test(rest)) {
      s = rest.replace(/^-p\s+/, '');
      continue;
    }
    return s;
  }
}

/**
 * Redirections at the end of a wrapper's arguments, outside its quotes (`bash -c 'cmd' >/dev/null
 * 2>&1`): the wrapper's own, judged with its segment by `writesThroughRedirect`, not part of the
 * command inside the quotes. A redirection inside the quotes ends before the closing quote, which the
 * target cannot hold.
 */
const TRAILING_REDIRECTS = /(?:\s+[0-9&*]?[<>]{1,3}&?\s*(?:"[^"]*"|'[^']*'|[^\s<>&'"]+))+\s*$/;

/** Where the quote that opened `s` closes (a backslash escapes the next character inside double quotes); -1 when it does not. */
function closingQuote(s: string): number {
  const q = s[0];
  for (let i = 1; i < s.length; i += 1) {
    if (q === '"' && s[i] === '\\') i += 1;
    else if (s[i] === q) return i;
  }
  return -1;
}

/**
 * The command a shell wrapper runs (`"C:\WINDOWS\…\powershell.exe" -NoProfile -Command '<cmd>'`,
 * `cmd /c "<cmd>"`, `bash -lc '<cmd>'`, also behind `sudo` or `env`), or null for a segment that is
 * not one. A host that wraps every command (Codex, ADR-0032 §4) must not hide a second command inside
 * the quotes: the inner command is split and judged again. For a POSIX shell the first quoted
 * argument is the command and the words after it are its positional parameters, which run nothing
 * beyond what they substitute (`bash -c 'rm -rf y' arg` deletes; so did `bash -c 'rm -rf y' &` with
 * the `&` left in the segment, M11.1 review); PowerShell and cmd read everything after the flag as
 * the command.
 */
export function wrappedCommand(segment: string): string | null {
  const m = /^(?:"([^"]+)"|(\S+))\s+([\s\S]*)$/.exec(afterPrefixes(segment));
  if (!m) return null;
  const shell = programName(m[1] ?? m[2] ?? '');
  if (!SHELLS.has(shell)) return null;
  const flag = /(?:^|\s)(-c|-command|\/c|\/k|-lc)\s+([\s\S]*)$/i.exec(m[3] as string);
  if (!flag) return null;
  let inner = (flag[2] as string).trim().replace(TRAILING_REDIRECTS, '');
  const q = inner[0];
  if (q !== "'" && q !== '"') return inner;
  if (shell === 'bash' || shell === 'sh' || shell === 'zsh') {
    const close = closingQuote(inner);
    if (close < 0) return inner;
    const body = inner.slice(1, close);
    // What the positional parameters substitute runs too (`bash -c 'cat x' $(rm -rf y)`); joined by
    // newlines, which `splitSegments` separates.
    const substituted = groupsOf(inner.slice(close + 1), 'posix')?.groups ?? [];
    return [body, ...substituted].join('\n');
  }
  if (inner.length >= 2 && inner.endsWith(q)) {
    const body = inner.slice(1, -1);
    // One quoted argument; inside PowerShell's single quotes, a quote is written twice.
    if (!body.includes(q)) inner = body;
    else if (q === "'" && !body.replace(/''/g, '').includes("'")) inner = body.replace(/''/g, "'");
  }
  return inner;
}

/** The shell a wrapper segment starts, for reading what it runs. */
function wrapperShell(segment: string): Shell {
  const head = programName(/^("[^"]+"|\S+)/.exec(afterPrefixes(segment))?.[1] ?? '');
  return head === 'powershell' || head === 'pwsh' ? 'powershell' : head === 'cmd' ? 'cmd' : 'posix';
}

/**
 * A command line's segments: every `case … esac` replaced by what it substitutes and what its
 * branches run, every shell wrapper by the segments it runs, `xargs` by the command it runs, and
 * every PowerShell block, expression, subshell, backtick substitution and `find -exec` by the
 * commands inside it.
 */
function expandedSegments(command: string, depth = 0, shell?: Shell): string[] {
  const branches = depth < 8 ? caseParts(command, shell) : null;
  if (branches) return branches.flatMap((p) => expandedSegments(p, depth + 1, shell));
  return splitSegments(command).flatMap((s) => {
    if (depth >= 8) return [s];
    const inner = wrappedCommand(s);
    if (inner !== null) return expandedSegments(inner, depth + 1, wrapperShell(s));
    const x = xargsCommand(s);
    // What `xargs` runs is judged in its place; `xargs` that runs its input is judged as written.
    if (x !== null) return 'run' in x ? expandedSegments(x.run, depth + 1, shell) : [s];
    return partsOf(s, depth, shell).flatMap((p) => findParts(p, depth, shell));
  });
}

/** Options with which `find` runs a command for each file it finds, up to `;` or `+`. */
const FIND_RUNS = new Set(['-exec', '-execdir', '-ok', '-okdir']);

/**
 * A `find` segment as its own part and what each `-exec` clause runs, as written:
 * `find . -exec rm {} \;` deletes what it finds, `find . -exec grep -l x {} +` only reads. Null for
 * a segment that is not `find`, or a `find` that runs nothing.
 */
function findRuns(segment: string): { own: string; runs: string[] } | null {
  const tokens = tokensOf(afterPrefixes(segment));
  if (programName(tokens[0] ?? '') !== 'find' || !tokens.some((t) => FIND_RUNS.has(t.toLowerCase()))) return null;
  const own: string[] = [];
  const runs: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    if (!FIND_RUNS.has(t.toLowerCase())) {
      own.push(t);
      continue;
    }
    const clause: string[] = [];
    // The clause ends at `;` (written `\;`, `';'` or `";"`; splitting at `;` may leave a lone `\`) or `+`.
    for (i += 1; i < tokens.length && !/^(\\?;|';'|";"|\+|\\)$/.test(tokens[i] as string); i += 1) {
      clause.push(tokens[i] as string);
    }
    if (clause.length) runs.push(clause.join(' '));
  }
  return { own: own.join(' '), runs };
}

/** A `find` segment, and what its `-exec` clauses run as segments of their own. */
function findParts(segment: string, depth: number, shell: Shell | undefined): string[] {
  const f = findRuns(segment);
  return f ? [f.own, ...f.runs.flatMap((r) => expandedSegments(r, depth + 1, shell))] : [segment];
}

/**
 * `xargs` options that take a value, written apart (`-I {}`, `-n 1`) or attached (`-I{}`, `-n1`);
 * `-e`, `-i` and `-l` take an optional one, attached only; the long forms take theirs apart or with `=`.
 */
const XARGS_VALUE = 'adEILnPsJRS';
const XARGS_OPTIONAL_VALUE = 'eil';
const XARGS_LONG_VALUE = new Set([
  'arg-file',
  'delimiter',
  'eof',
  'max-args',
  'max-chars',
  'max-lines',
  'max-procs',
  'process-slot-var',
]);

/** A token without the quotes around it. */
const unquote = (token: string) => token.replace(/^"([^"]*)"$|^'([^']*)'$/, '$1$2');

/**
 * What `xargs` runs: `run`, the command written after its options, with its arguments (what it
 * reads from its input is appended at run time, or stands where `-I`'s placeholder does): `find … |
 * xargs rm -rf` deletes, `… | xargs grep -l x` and `xargs -I {} git log {}` read; `xargs` with no
 * command runs `echo`. `fromInput` when the command itself is the input (`xargs -I{} {}`, `xargs sh
 * -c`, `xargs -I{} sh -c '{}'`), which no rule can read: the segment is then judged as written, and
 * asks a human (M11.1 review: the placeholder expanded to nothing, and the command passed as a
 * read). Null for a segment that is not `xargs`.
 */
function xargsCommand(segment: string): { run: string } | { fromInput: true } | null {
  const tokens = tokensOf(afterPrefixes(segment));
  if (programName(tokens[0] ?? '') !== 'xargs') return null;
  // `-I R`, `-IR`, `-i[R]` and `--replace[=R]` put each input line where `R` stands (`{}` by default).
  let placeholder: string | null = null;
  let i = 1;
  for (; i < tokens.length; i += 1) {
    const t = tokens[i] as string;
    if (t === '--') {
      i += 1;
      break;
    }
    if (!t.startsWith('-') || t === '-') break;
    if (t.startsWith('--')) {
      const eq = t.indexOf('=');
      const name = eq < 0 ? t.slice(2) : t.slice(2, eq);
      if (name === 'replace') placeholder = eq < 0 ? '{}' : unquote(t.slice(eq + 1));
      else if (eq < 0 && XARGS_LONG_VALUE.has(name)) i += 1;
      continue;
    }
    // Short options, perhaps combined (`-0r`, `-rn1`): the first that takes a value takes the rest of
    // the token, or the next token when nothing follows it.
    for (let k = 1; k < t.length; k += 1) {
      const o = t[k] as string;
      if (XARGS_VALUE.includes(o)) {
        let value = t.slice(k + 1);
        if (k === t.length - 1) {
          i += 1;
          value = tokens[i] ?? '{}';
        }
        if (o === 'I') placeholder = unquote(value);
        break;
      }
      if (XARGS_OPTIONAL_VALUE.includes(o)) {
        if (o === 'i') placeholder = k === t.length - 1 ? '{}' : unquote(t.slice(k + 1));
        break;
      }
    }
  }
  const run = tokens.slice(i).join(' ');
  if (!run) return { run: 'echo' };
  return runsItsInput(run, placeholder) ? { fromInput: true } : { run };
}

/**
 * Whether the command `xargs` runs is its input: the placeholder where the program's name stands
 * (`{}`, `{} -rf x`, `env {}`), a shell with no command text (`sh`, `bash -c`: each line, or each
 * file, becomes the command), or a shell whose command text is the placeholder (`sh -c '{}'`).
 */
function runsItsInput(run: string, placeholder: string | null): boolean {
  const first = tokensOf(afterPrefixes(run))[0] ?? '';
  if (placeholder !== null && unquote(first).includes(placeholder)) return true;
  if (!SHELLS.has(programName(first))) return false;
  const inner = wrappedCommand(run);
  return inner === null || (placeholder !== null && runsItsInput(inner, placeholder));
}

/** A `case WORD in PATTERN) LIST;; … esac` construct: where it stands in a command, and what it holds. */
interface CaseConstruct {
  start: number;
  end: number;
  word: string;
  patterns: string[];
  lists: string[];
}

/** The keywords a command may follow directly (`do case …`, `then case …`). */
const BEFORE_COMMAND = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!']);

/**
 * A command with its first `case … esac` taken out, as the pieces that run: what stands before and
 * after it, what its word and its patterns substitute (`case $(cat kind) in`), and every branch's
 * command list, which may hold a `case` of its own. Null where there is none, where it does not
 * parse (it is then judged as written, which asks a human), and in a shell without `case`
 * (PowerShell's `switch` is a block `partsOf` reads).
 */
function caseParts(command: string, shell: Shell | undefined): string[] | null {
  if (!posixSyntax(shell)) return null;
  const c = firstCase(command, shell);
  if (!c) return null;
  const substituted = [c.word, ...c.patterns].flatMap((w) => groupsOf(w, shell)?.groups ?? [w]);
  // What stands around the construct is joined, so brackets or backticks it sat in still balance.
  return [command.slice(0, c.start) + command.slice(c.end), ...substituted, ...c.lists];
}

/**
 * The first `case … esac` where a command may begin: outside quotes, or inside a `$( … )` within
 * double quotes. Brackets and backticks are seen through, since a pattern's `)` would otherwise be
 * taken for the end of a group.
 */
function firstCase(s: string, shell: Shell | undefined): CaseConstruct | null {
  let inDouble = false;
  let sub = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      i = quotedEnd(s, i);
      if (i < 0) return null;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      sub = 0;
      continue;
    }
    if (inDouble) {
      if (ch === '$' && s[i + 1] === '(') sub += 1;
      else if (ch === ')' && sub > 0) sub -= 1;
      if (sub === 0) continue;
    }
    if (keywordAt(s, i, 'case', 0)) {
      const c = parseCase(s, i, shell);
      if (c) return c;
    }
  }
  return null;
}

/** Where the quoted text opened at `i` (a quote, or a backtick that runs) closes; -1 when it does not. */
function quotedEnd(s: string, i: number): number {
  return s.indexOf(s[i] as string, i + 1);
}

/** What may follow `esac`: blank space, the end, a separator, a closing bracket, a redirection or a backtick. */
const AFTER_ESAC = /^[\s;&|)}<>`]?$/;

/**
 * Whether `case` or `esac` stands at `i` as a word of its own, where a command may begin: at the
 * start (`from`), after a separator, an opening bracket or a backtick, or after a keyword a command
 * follows.
 */
function keywordAt(s: string, i: number, word: 'case' | 'esac', from: number): boolean {
  if (!s.startsWith(word, i)) return false;
  const after = s[i + word.length] ?? '';
  if (!(word === 'case' ? /^\s$/ : AFTER_ESAC).test(after)) return false;
  if (i > 0 && /[\w$]/.test(s[i - 1] as string)) return false;
  let j = i - 1;
  while (j >= from && (s[j] === ' ' || s[j] === '\t')) j -= 1;
  if (j < from || /[;&|\n({`]/.test(s[j] as string)) return true;
  let k = j;
  while (k >= from && /[A-Za-z!]/.test(s[k] as string)) k -= 1;
  return BEFORE_COMMAND.has(s.slice(k + 1, j + 1));
}

/** Blank space, newlines included, skipped from `i`. */
function skipBlank(s: string, i: number): number {
  let j = i;
  while (j < s.length && /\s/.test(s[j] as string)) j += 1;
  return j;
}

/**
 * The construct that begins with the `case` at `at`: its word, `in`, then branches of a pattern (a
 * `(` before it is optional), `)`, a command list and `;;` (in bash also `;&` and `;;&`), up to
 * `esac`; the last branch may end without `;;`. Null when it does not parse.
 */
function parseCase(s: string, at: number, shell: Shell | undefined): CaseConstruct | null {
  let i = skipBlank(s, at + 4);
  const wordEnd = tokenEnd(s, i, shell);
  if (wordEnd <= i) return null;
  const word = s.slice(i, wordEnd);
  i = skipBlank(s, wordEnd);
  if (!s.startsWith('in', i) || !/\s/.test(s[i + 2] ?? '')) return null;
  i = skipBlank(s, i + 2);
  const patterns: string[] = [];
  const lists: string[] = [];
  for (;;) {
    if (s.startsWith('esac', i) && AFTER_ESAC.test(s[i + 4] ?? ''))
      return { start: at, end: i + 4, word, patterns, lists };
    if (s[i] === '(') i += 1;
    const close = patternEnd(s, i, shell);
    if (close < 0) return null;
    const pattern = s.slice(i, close).trim();
    if (!pattern) return null;
    patterns.push(pattern);
    const list = listEnd(s, close + 1, shell);
    if (!list) return null;
    lists.push(s.slice(close + 1, list.end));
    if (list.terminator === 'esac') return { start: at, end: list.end + 4, word, patterns, lists };
    i = skipBlank(s, list.end + list.terminator.length);
  }
}

/** Where the shell word at `i` ends (blank space, or the end, at bracket depth 0); -1 when a quote or bracket does not close. */
function tokenEnd(s: string, i: number, shell: Shell | undefined): number {
  let depth = 0;
  let j = i;
  for (; j < s.length; j += 1) {
    const ch = s[j] as string;
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && runsBackticks(shell))) {
      j = quotedEnd(s, j);
      if (j < 0) return -1;
      continue;
    }
    if (ch === '(' || ch === '{') depth += 1;
    else if (ch === ')' || ch === '}') {
      if (depth === 0) return -1;
      depth -= 1;
    } else if (depth === 0 && /\s/.test(ch)) return j;
  }
  return depth === 0 ? j : -1;
}

/** Where the pattern at `i` ends, at its `)`; -1 when it does not, or holds what no pattern holds (a newline, `;`, `&`). */
function patternEnd(s: string, i: number, shell: Shell | undefined): number {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    const ch = s[j] as string;
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && runsBackticks(shell))) {
      j = quotedEnd(s, j);
      if (j < 0) return -1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      if (depth === 0) return j;
      depth -= 1;
    } else if (depth === 0 && /[\n;&]/.test(ch)) return -1;
  }
  return -1;
}

/**
 * Where the command list at `i` ends: at `;;`, `;&` or `;;&`, or at an `esac` where a command may
 * begin (the last branch may have no `;;`). A `case … esac` inside it is stepped over whole. Null
 * when it does not end, or a bracket does not balance.
 */
function listEnd(s: string, i: number, shell: Shell | undefined): { end: number; terminator: string } | null {
  let depth = 0;
  for (let j = i; j < s.length; j += 1) {
    const ch = s[j] as string;
    if (ch === '\\') {
      j += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || (ch === '`' && runsBackticks(shell))) {
      j = quotedEnd(s, j);
      if (j < 0) return null;
      continue;
    }
    if (ch === '(' || ch === '{') depth += 1;
    else if (ch === ')' || ch === '}') {
      if (depth === 0) return null;
      depth -= 1;
    } else if (depth === 0) {
      if (ch === ';' && s[j + 1] === ';') return { end: j, terminator: s[j + 2] === '&' ? ';;&' : ';;' };
      if (ch === ';' && s[j + 1] === '&') return { end: j, terminator: ';&' };
      if (keywordAt(s, j, 'esac', i)) return { end: j, terminator: 'esac' };
      if (keywordAt(s, j, 'case', i)) {
        const nested = parseCase(s, j, shell);
        if (!nested) return null;
        j = nested.end - 1;
      }
    }
  }
  return null;
}

/**
 * A method call or a .NET member outside quotes (`$f.Delete()`, `(Get-Item x).Delete()`,
 * `[IO.File]::Delete('x')`): it can do anything, and no rule knows what.
 */
function isCall(s: string): boolean {
  const bare = s.replace(/"[^"]*"|'[^']*'/g, '""');
  return /\.\s*[A-Za-z_]\w*\s*\(/.test(bare) || bare.includes('::') || /^\$[\w:.]*\s*\(/.test(bare);
}

/** Words that open a PowerShell (or shell) construct and run nothing themselves. */
const KEYWORDS = new Set([
  'if',
  'elseif',
  'else',
  'foreach',
  'for',
  'while',
  'do',
  'until',
  'try',
  'catch',
  'finally',
  'switch',
  'trap',
  'param',
  'begin',
  'process',
  'end',
  'function',
  'filter',
  // POSIX shells.
  'then',
  'elif',
  'fi',
  'done',
  'esac',
]);

/**
 * What one segment runs (M8a live check: Codex reads files on Windows through PowerShell, as
 * `if (Test-Path x) { Get-Content x }`):
 * - a construct (`if (…) {…} else {…}`, `try {…} catch {…}`, `foreach ($f in …) {…}`): the
 *   commands inside its brackets;
 * - a command with blocks or subexpressions (`ForEach-Object { … }`, `Get-Content (Join-Path …)`,
 *   `"$( … )"`): the command and the commands inside;
 * - an expression (`$x -like '*.ts'`, a value): nothing, but an assignment runs its right side;
 * - a method call or a .NET member (`$f.Delete()`, `[IO.File]::Delete(…)`): itself, which no rule
 *   knows, so a human decides.
 */
function partsOf(segment: string, depth: number, shell?: Shell): string[] {
  const t = segment.trim();
  if (!t || VALUE.test(t)) return [];
  // A negation runs what it negates (`! rm -rf x` in a POSIX shell, `-not (Test-Path x)`).
  const negated = /^(!|-not\b)\s*([\s\S]*)$/i.exec(t);
  if (negated) return negated[2] ? partsOf(negated[2], depth + 1, shell) : [];
  const call = isCall(t);
  // A PowerShell expression begins with a variable; in a POSIX shell `$x -rf build` runs whatever
  // `$x` holds, a command no rule knows (LESSONS D-45).
  const expression = shell === 'powershell' && t.startsWith('$');
  if (!call && expression && !t.startsWith('$(')) {
    const assign = /^\$[\w:.]*(?:\[[^\]]*\])?\s*[-+*/%]?=\s*([\s\S]*)$/.exec(t);
    if (assign) return expandedSegments(assign[1] as string, depth + 1, shell);
    const within = /^\$\w+\s+in\s+([\s\S]*)$/i.exec(t);
    if (within) return expandedSegments(within[1] as string, depth + 1, shell);
  }
  const g = groupsOf(t, shell);
  if (!g) return [segment];
  const inner = g.groups.flatMap((x) => expandedSegments(x, depth + 1, shell));
  // The call is judged as it stands (unknown), and what its brackets hold as well. So is a backtick
  // substitution where the program's name stands (`` `cat cmds.txt` ``): its output is the command.
  if (call || (t.startsWith('`') && runsBackticks(shell))) return [segment, ...inner];
  // A keyword opens a construct and runs nothing, but what follows it does (`do rm x`, `then …`).
  let frame = g.frame.trim();
  for (;;) {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(frame);
    const w = (m?.[1] ?? '').toLowerCase();
    if (!m || !KEYWORDS.has(w)) break;
    // A definition's name runs nothing either (`function f { … }`).
    frame = (w === 'function' || w === 'filter' ? (m[2] ?? '').replace(/^\S+\s*/, '') : (m[2] ?? '')).trim();
    // A POSIX `for NAME in WORDS` header runs nothing; what its words substitute is in the groups.
    if (w === 'for' && /^[A-Za-z_]\w*(?:\s+in(?:\s[^`]*)?)?$/.test(frame)) frame = '';
  }
  // An expression, a value, a string PowerShell only prints, or a redirection left after a
  // construct (`done < files.txt`) runs nothing beyond its brackets; a write is judged on its own.
  if (!frame || expression || REDIRECTS.test(frame) || VALUE.test(frame) || PRINTED.test(frame) || OPERATOR.test(frame))
    return inner;
  return frame === t ? [segment] : [frame, ...inner];
}

/** Redirections only (`< files.txt`, `> out.txt 2>&1`, `<<< "$x"`). */
const REDIRECTS = /^(?:[0-9&*]?[<>]{1,3}&?\s*(?:"[^"]*"|'[^']*'|[^\s<>&]+)\s*)+$/;

/**
 * The continuation of an expression: an operator (`-gt 0`), an array or hashtable (`@( … )`), or a
 * member of what a bracket returned (`.Length`). A program path (`./x`, `/bin/rm`) is none of these.
 */
const OPERATOR = /^(-[a-z]+\b|[@,+*=]|\.[A-Za-z_])/i;

/** A literal value: a number, a string without variables, `$true`, `$false`, `$null`. */
const VALUE = /^(-?\d+(\.\d+)?|'[^']*'|"[^"$]*"|\$(true|false|null))$/i;
/**
 * A string PowerShell prints, perhaps formatted (`"--- name"`, `"{0}: {1}" -f $i, $_`): it holds a
 * space, so it names no command, and neither a path separator (`"C:\Program Files\…\node.exe"`
 * runs in cmd and POSIX shells) nor a variable, which a POSIX shell could run.
 */
const PRINTED = /^("[^"$\\/]*\s[^"$\\/]*"|'[^'\\/]*\s[^'\\/]*')(\s|$)/;

/**
 * The bracketed parts of a segment and what is left around them: `( … )` and `{ … }` outside
 * quotes, and `$( … )` inside double quotes, which runs too. Where backticks run commands (POSIX,
 * or a shell not known), `` `…` `` outside single quotes too. Null when the brackets do not balance.
 */
function groupsOf(s: string, shell?: Shell): { frame: string; groups: string[] } | null {
  const groups: string[] = [];
  let frame = '';
  let quote: string | null = null;
  const ticks = runsBackticks(shell);
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (ticks && ch === '`' && quote !== "'") {
      const end = s.indexOf('`', i + 1);
      if (end < 0) return null;
      groups.push(s.slice(i + 1, end));
      frame += ' ';
      i = end;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else if (quote === '"' && ch === '$' && s[i + 1] === '(') {
        const end = closing(s, i + 1);
        if (end < 0) return null;
        groups.push(s.slice(i + 2, end));
        frame += ' ';
        i = end;
        continue;
      }
      frame += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      frame += ch;
      continue;
    }
    if (ch === '(' || ch === '{') {
      const end = closing(s, i);
      if (end < 0) return null;
      groups.push(s.slice(i + 1, end));
      frame += ' ';
      i = end;
      continue;
    }
    if (ch === ')' || ch === '}') return null;
    frame += ch;
  }
  return quote ? null : { frame, groups };
}

/** Where the bracket at `open` closes, skipping quoted text; -1 when it does not. */
function closing(s: string, open: number): number {
  const stack: string[] = [s[open] === '(' ? ')' : '}'];
  let quote: string | null = null;
  for (let i = open + 1; i < s.length; i += 1) {
    const ch = s[i] as string;
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(') stack.push(')');
    else if (ch === '{') stack.push('}');
    else if (ch === ')' || ch === '}') {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * The class of a command line: the most restrictive class of everything it runs. `shell` is the
 * shell the host runs it in (Claude Code's `Bash` or `PowerShell` tool); a shell wrapper inside the
 * command names its own.
 */
export function classifyCommand(
  command: string,
  autonomy: Partial<Record<CommandClass, Autonomy>> = {},
  shell?: Shell,
): CommandClassification {
  const table = { ...DEFAULT_AUTONOMY, ...autonomy };
  // Classes that are never allowed cannot be relaxed by configuration.
  table['secrets.read'] = 'never';
  table['friday.internal'] = 'never';
  const segments = expandedSegments(command, 0, shell).map((text) => {
    const c = classifySegment(text);
    // A method call runs what no rule knows: at least a human's decision.
    return { text, class: isCall(text) && RANK[table[c]] < RANK[table.unknown] ? ('unknown' as const) : c };
  });
  // Judged before anything else (review M8-R01): a value PowerShell only prints runs nothing, so
  // it leaves no segment, yet `'x' > f` writes `f`. A command that leaves no segment is a read only
  // because every construct whose command comes from elsewhere (an `xargs` placeholder, a shell
  // with no `-c` text, a substitution where the program's name stands) is judged as written above.
  const writes = writesThroughRedirect(command, 0, shell);
  if (segments.length === 0 && !writes) return { class: 'read.local', autonomy: 'auto', segments };
  let worst: { text: string; class: CommandClass } = segments[0] ?? { text: command, class: 'read.local' };
  for (const s of segments) if (RANK[table[s.class]] > RANK[table[worst.class]]) worst = s;
  if (writes && RANK[table[worst.class]] < RANK.review) worst = { text: command, class: 'git.mutate' };
  return { class: worst.class, autonomy: table[worst.class], segments };
}

/**
 * Whether a command line writes a file through a redirection (`> f`, `>> f`, `2> f`, `*> f`,
 * `&> f`, a quoted `f` too), at any depth: inside a shell wrapper, a block or a subexpression, a
 * `case` branch, or what `xargs` or a `find -exec` clause runs. Output thrown away (`> $null`,
 * `2>$null`, `*> $null`, `>NUL`, `> /dev/null`) writes nothing, and neither does a redirection into
 * another stream (`2>&1`, `>&2`).
 */
function writesThroughRedirect(command: string, depth = 0, shell?: Shell): boolean {
  const branches = depth < 8 ? caseParts(command, shell) : null;
  if (branches) return branches.some((p) => writesThroughRedirect(p, depth + 1, shell));
  return splitSegments(command).some((s) => {
    const bare = s
      .replace(/"[^"]*"|'[^']*'/g, 'Q')
      .replace(/[0-9*&]?>{1,2}\s*(\$null|nul|\/dev\/null)(?![\w/.\\-])/gi, ' ');
    if (/>{1,2}(?!&)\s*[^\s&]/.test(bare)) return true;
    if (depth >= 8) return false;
    const inner = wrappedCommand(s);
    if (inner !== null) return writesThroughRedirect(inner, depth + 1, wrapperShell(s));
    const x = xargsCommand(s);
    if (x !== null) return 'run' in x ? writesThroughRedirect(x.run, depth + 1, shell) : false;
    const f = findRuns(s);
    if (f) return f.runs.some((r) => writesThroughRedirect(r, depth + 1, shell));
    return Boolean(groupsOf(s, shell)?.groups.some((g) => writesThroughRedirect(g, depth + 1, shell)));
  });
}
