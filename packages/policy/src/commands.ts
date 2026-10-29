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
 * Splits a command line on && || ; | and newlines, ignoring separators inside quotes and inside
 * brackets: a PowerShell block or a subshell stays one segment, and `partsOf` judges what it holds.
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
      (ch === '\n' || ch === ';' || (ch === '&' && next === '&') || (ch === '|' && next === '|') || ch === '|')
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

function words(segment: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (const m of segment.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

/** Drops env assignments and wrappers (sudo, npx, pnpm exec, powershell -c, cmd /c, call, &). */
function unwrap(ws: string[]): string[] {
  let w = [...ws];
  for (let guard = 0; guard < 6; guard += 1) {
    while (w.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0] as string)) w = w.slice(1);
    // A host may name the shell by its full path (`"C:\WINDOWS\…\powershell.exe" -Command …`, ADR-0032 §4).
    const head = (w[0] ?? '')
      .toLowerCase()
      .replace(/^.*[\\/]/, '')
      .replace(/\.(exe|cmd|bat|ps1)$/, '');
    if (['sudo', 'npx', 'call', '&', 'time', 'nohup', 'env'].includes(head)) {
      w = w.slice(1);
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

/**
 * The command a shell wrapper runs (`"C:\WINDOWS\…\powershell.exe" -NoProfile -Command '<cmd>'`,
 * `cmd /c "<cmd>"`, `bash -lc '<cmd>'`), or null for a segment that is not one. A host that wraps
 * every command (Codex, ADR-0032 §4) must not hide a second command inside the quotes: the inner
 * command is split and judged again.
 */
export function wrappedCommand(segment: string): string | null {
  const m = /^\s*(?:"([^"]+)"|(\S+))\s+([\s\S]*)$/.exec(segment);
  if (!m) return null;
  const head = (m[1] ?? m[2] ?? '')
    .toLowerCase()
    .replace(/^.*[\\/]/, '')
    .replace(/\.(exe|cmd|bat)$/, '');
  if (!SHELLS.has(head)) return null;
  const flag = /(?:^|\s)(-c|-command|\/c|\/k|-lc)\s+([\s\S]*)$/i.exec(m[3] as string);
  if (!flag) return null;
  let inner = (flag[2] as string).trim();
  const q = inner[0];
  if ((q === "'" || q === '"') && inner.length >= 2 && inner.endsWith(q)) {
    const body = inner.slice(1, -1);
    // One quoted argument; inside PowerShell's single quotes, a quote is written twice.
    if (!body.includes(q)) inner = body;
    else if (q === "'" && !body.replace(/''/g, '').includes("'")) inner = body.replace(/''/g, "'");
  }
  return inner;
}

/**
 * A command line's segments: every shell wrapper replaced by the segments it runs, and every
 * PowerShell block, expression and subshell by the commands inside it.
 */
function expandedSegments(command: string, depth = 0): string[] {
  return splitSegments(command).flatMap((s) => {
    if (depth >= 8) return [s];
    const inner = wrappedCommand(s);
    return inner === null ? partsOf(s, depth) : expandedSegments(inner, depth + 1);
  });
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
function partsOf(segment: string, depth: number): string[] {
  const t = segment.trim();
  if (!t || VALUE.test(t)) return [];
  // A negation runs what it negates (`! rm -rf x` in a POSIX shell, `-not (Test-Path x)`).
  const negated = /^(!|-not\b)\s*([\s\S]*)$/i.exec(t);
  if (negated) return negated[2] ? partsOf(negated[2], depth + 1) : [];
  const call = isCall(t);
  if (!call && t.startsWith('$') && !t.startsWith('$(')) {
    const assign = /^\$[\w:.]*(?:\[[^\]]*\])?\s*[-+*/%]?=\s*([\s\S]*)$/.exec(t);
    if (assign) return expandedSegments(assign[1] as string, depth + 1);
    const within = /^\$\w+\s+in\s+([\s\S]*)$/i.exec(t);
    if (within) return expandedSegments(within[1] as string, depth + 1);
  }
  const g = groupsOf(t);
  if (!g) return [segment];
  const inner = g.groups.flatMap((x) => expandedSegments(x, depth + 1));
  // The call is judged as it stands (unknown), and what its brackets hold as well.
  if (call) return [segment, ...inner];
  // A keyword opens a construct and runs nothing, but what follows it does (`do rm x`, `then …`).
  let frame = g.frame.trim();
  for (;;) {
    const m = /^(\S+)\s*([\s\S]*)$/.exec(frame);
    const w = (m?.[1] ?? '').toLowerCase();
    if (!m || !KEYWORDS.has(w)) break;
    // A definition's name runs nothing either (`function f { … }`).
    frame = (w === 'function' || w === 'filter' ? (m[2] ?? '').replace(/^\S+\s*/, '') : (m[2] ?? '')).trim();
  }
  // An expression, a value or a string PowerShell only prints runs nothing beyond its brackets.
  if (!frame || t.startsWith('$') || VALUE.test(frame) || PRINTED.test(frame) || OPERATOR.test(frame)) return inner;
  return frame === t ? [segment] : [frame, ...inner];
}

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
 * quotes, and `$( … )` inside double quotes, which runs too. Null when the brackets do not balance.
 */
function groupsOf(s: string): { frame: string; groups: string[] } | null {
  const groups: string[] = [];
  let frame = '';
  let quote: string | null = null;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i] as string;
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

export function classifyCommand(
  command: string,
  autonomy: Partial<Record<CommandClass, Autonomy>> = {},
): CommandClassification {
  const table = { ...DEFAULT_AUTONOMY, ...autonomy };
  // Classes that are never allowed cannot be relaxed by configuration.
  table['secrets.read'] = 'never';
  table['friday.internal'] = 'never';
  const segments = expandedSegments(command).map((text) => {
    const c = classifySegment(text);
    // A method call runs what no rule knows: at least a human's decision.
    return { text, class: isCall(text) && RANK[table[c]] < RANK[table.unknown] ? ('unknown' as const) : c };
  });
  // Judged before anything else (review M8-R01): a value PowerShell only prints runs nothing, so
  // it leaves no segment, yet `'x' > f` writes `f`.
  const writes = writesThroughRedirect(command);
  if (segments.length === 0 && !writes) return { class: 'read.local', autonomy: 'auto', segments };
  let worst: { text: string; class: CommandClass } = segments[0] ?? { text: command, class: 'read.local' };
  for (const s of segments) if (RANK[table[s.class]] > RANK[table[worst.class]]) worst = s;
  if (writes && RANK[table[worst.class]] < RANK.review) worst = { text: command, class: 'git.mutate' };
  return { class: worst.class, autonomy: table[worst.class], segments };
}

/**
 * Whether a command line writes a file through a redirection (`> f`, `>> f`, `2> f`, `*> f`,
 * `&> f`, a quoted `f` too), at any depth: inside a shell wrapper, a block or a subexpression.
 * Output thrown away (`> $null`, `2>$null`, `*> $null`, `>NUL`, `> /dev/null`) writes nothing,
 * and neither does a redirection into another stream (`2>&1`, `>&2`).
 */
function writesThroughRedirect(command: string, depth = 0): boolean {
  return splitSegments(command).some((s) => {
    const bare = s
      .replace(/"[^"]*"|'[^']*'/g, 'Q')
      .replace(/[0-9*&]?>{1,2}\s*(\$null|nul|\/dev\/null)(?![\w/.\\-])/gi, ' ');
    if (/>{1,2}(?!&)\s*[^\s&]/.test(bare)) return true;
    if (depth >= 8) return false;
    const inner = wrappedCommand(s);
    if (inner !== null) return writesThroughRedirect(inner, depth + 1);
    return Boolean(groupsOf(s)?.groups.some((g) => writesThroughRedirect(g, depth + 1)));
  });
}
