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

/** Splits a command line on && || ; | and newlines, ignoring separators inside quotes. */
export function splitSegments(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: string | null = null;
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
    if (ch === '\n' || ch === ';' || (ch === '&' && next === '&') || (ch === '|' && next === '|') || ch === '|') {
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
  ];
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

/** A command line's segments, with every shell wrapper replaced by the segments it runs. */
function expandedSegments(command: string, depth = 0): string[] {
  return splitSegments(command).flatMap((s) => {
    const inner = depth < 4 ? wrappedCommand(s) : null;
    return inner === null ? [s] : expandedSegments(inner, depth + 1);
  });
}

export function classifyCommand(
  command: string,
  autonomy: Partial<Record<CommandClass, Autonomy>> = {},
): CommandClassification {
  const table = { ...DEFAULT_AUTONOMY, ...autonomy };
  // Classes that are never allowed cannot be relaxed by configuration.
  table['secrets.read'] = 'never';
  table['friday.internal'] = 'never';
  const segments = expandedSegments(command).map((text) => ({ text, class: classifySegment(text) }));
  if (segments.length === 0) return { class: 'read.local', autonomy: 'auto', segments };
  let worst = segments[0] as { text: string; class: CommandClass };
  for (const s of segments) if (RANK[table[s.class]] > RANK[table[worst.class]]) worst = s;
  // Redirecting output into a file writes it, whatever the command; inside a wrapper too.
  const redirects = (text: string) => /(^|[^0-9&])>{1,2}\s*[^&\s]/.test(text.replace(/"[^"]*"|'[^']*'/g, ''));
  if ((redirects(command) || segments.some((s) => redirects(s.text))) && RANK[table[worst.class]] < RANK.review) {
    worst = { text: command, class: 'git.mutate' };
  }
  return { class: worst.class, autonomy: table[worst.class], segments };
}
