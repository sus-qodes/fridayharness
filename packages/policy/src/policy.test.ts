import { describe, expect, it } from 'vitest';
import {
  type CommandClass,
  canonicalize,
  classifyCommand,
  evaluate,
  type PathContext,
  type PolicyInput,
  type PolicyTask,
  sensitiveClassOf,
  splitSegments,
  wrappedCommand,
} from './index.js';

const WIN: PathContext = {
  projectRoot: 'C:\\demo\\shop',
  stateDir: 'C:\\Users\\me\\AppData\\Local\\Friday',
  windows: true,
};
const POSIX: PathContext = { projectRoot: '/home/me/shop', stateDir: '/home/me/.local/state/friday', windows: false };

const running = (write: string[]): PolicyTask => ({ task_id: 'task_1', status: 'RUNNING', scope: { write, read: [] } });
const write = (paths: string[], extra: Partial<PolicyInput> = {}, ctx = WIN) =>
  evaluate({
    ctx,
    task: running(['frontend/src/pricing/**']),
    action: { tool: 'Edit', kind: 'write', paths },
    ...extra,
  });

describe('canonicalize (plan B19 traversal table)', () => {
  it.each([
    ['frontend/src/a.ts', 'frontend/src/a.ts'],
    ['C:\\demo\\shop\\frontend\\src\\a.ts', 'frontend/src/a.ts'],
    ['c:\\DEMO\\Shop\\frontend\\a.ts', 'frontend/a.ts'],
    ['frontend/../backend/x.ts', 'backend/x.ts'],
    ['frontend\\x.ts.', 'frontend/x.ts'],
    ['frontend\\x.ts:stream', 'frontend/x.ts'],
    ['%2e%2e/x', '%2e%2e/x'],
    ['../x', null],
    ['..\\x', null],
    ['C:\\other\\x', null],
    ['\\\\srv\\share\\x', null],
    ['\\\\?\\C:\\demo\\shop\\x', null],
  ])('%s → %s', (input, expected) => {
    expect(canonicalize(input, WIN).relative).toBe(expected);
  });

  it('posix paths', () => {
    expect(canonicalize('/home/me/shop/a/b.ts', POSIX).relative).toBe('a/b.ts');
    expect(canonicalize('/home/me/other', POSIX).relative).toBeNull();
    expect(canonicalize('/home/me/shop/../shop2/x', POSIX).relative).toBeNull();
  });
});

describe('sensitive paths', () => {
  it.each([
    ['.friday/project.db', 'read', 'friday.runtime'],
    ['.friday\\project.db-wal', 'read', 'friday.runtime'],
    ['.friday/run/daemon.json', 'read', 'friday.runtime'],
    ['.friday/logs/daemon.jsonl', 'read', 'friday.runtime'],
    ['C:\\Users\\me\\AppData\\Local\\Friday\\projects\\p\\bootstrap.token', 'read', 'friday.private'],
    ['%LOCALAPPDATA%\\Friday\\projects\\x\\operator.token', 'read', 'friday.private'],
    ['backend/.env', 'read', 'secrets'],
    ['.env.local', 'read', 'secrets'],
    ['certs/server.pem', 'read', 'secrets'],
    ['.git/config', 'read', 'git.internal'],
    ['.claude/settings.json', 'write', 'host.config'],
    ['.mcp.json', 'write', 'host.config'],
    ['.friday/config.yaml', 'write', 'host.config'],
    ['.friday/harness/claude-code/hook.mjs', 'write', 'host.config'],
  ] as const)('%s (%s) → %s', (p, op, cls) => {
    expect(sensitiveClassOf(p, WIN, op)?.class).toBe(cls);
  });

  it('host config may be read, and ordinary files are not sensitive', () => {
    expect(sensitiveClassOf('.claude/settings.json', WIN, 'read')).toBeNull();
    expect(sensitiveClassOf('.friday/config.yaml', WIN, 'read')).toBeNull();
    expect(sensitiveClassOf('frontend/src/env.ts', WIN, 'write')).toBeNull();
    expect(sensitiveClassOf('docs/environment.md', WIN, 'read')).toBeNull();
  });
});

describe('command classification', () => {
  const cases: [string, CommandClass][] = [
    ['npm test', 'test.local'],
    ['pnpm run test:unit', 'test.local'],
    ['node --test "**/test/*.test.ts"', 'test.local'],
    ['npx vitest run', 'test.local'],
    ['pnpm build', 'build.local'],
    ['tsc --noEmit', 'lint.local'],
    ['git status', 'git.read'],
    ['git diff HEAD~1', 'git.read'],
    ['git log --oneline -5', 'git.read'],
    ['git add -A', 'git.mutate'],
    ['git commit -m "x"', 'git.mutate'],
    ['git push origin main', 'git.push'],
    ['git push --force', 'git.force'],
    ['git reset --hard HEAD', 'git.force'],
    ['git checkout -- .', 'git.force'],
    ['git pull', 'network.fetch'],
    ['rm -rf dist', 'fs.destructive'],
    ['Remove-Item -Recurse -Force dist', 'fs.destructive'],
    ['rd /s /q build', 'fs.destructive'],
    ['curl https://example.com', 'network.fetch'],
    ['curl -X POST -d @x https://example.com', 'network.publish'],
    ['Invoke-WebRequest https://example.com', 'network.fetch'],
    ['npm install left-pad', 'package.install'],
    ['pip install requests', 'package.install'],
    ['npm publish', 'network.publish'],
    ['taskkill /F /PID 12', 'process.kill'],
    ['Stop-Process -Name node', 'process.kill'],
    ['printenv', 'secrets.read'],
    ['env', 'secrets.read'],
    ['Get-ChildItem env:', 'secrets.read'],
    ['echo $env:ANTHROPIC_API_KEY', 'secrets.read'],
    ['friday approve apr_123', 'friday.internal'],
    ['friday token rotate', 'friday.internal'],
    ['friday ui --token', 'friday.internal'],
    ['friday status', 'read.local'],
    ['friday task inspect task_1', 'read.local'],
    ['ls -la', 'read.local'],
    ['Get-Content README.md', 'read.local'],
    ['sed -i s/a/b/ x.ts', 'git.mutate'],
    ['python script.py', 'unknown'],
    ['node build.js', 'unknown'],
    ['powershell -Command "git push"', 'git.push'],
    ['cmd /c "rd /s /q x"', 'fs.destructive'],
    ['FOO=1 npm test', 'test.local'],
  ];
  it.each(cases)('%s → %s', (cmd, cls) => {
    expect(classifyCommand(cmd).class).toBe(cls);
  });

  it('takes the most restrictive segment of a compound command', () => {
    expect(classifyCommand('npm test && git push').class).toBe('git.push');
    expect(classifyCommand('ls; rm -rf /').class).toBe('fs.destructive');
    expect(classifyCommand('git status | grep x').class).toBe('git.read');
    expect(splitSegments('echo "a && b" && ls')).toEqual(['echo "a && b"', 'ls']);
  });

  it('treats output redirection as a write', () => {
    expect(classifyCommand('echo hi > notes.txt').class).toBe('git.mutate');
    expect(classifyCommand('npm test 2>&1').class).toBe('test.local');
    // Output thrown away writes nothing; a file named like the sink still counts.
    expect(classifyCommand('Get-Content a.txt > $null').class).toBe('read.local');
    expect(classifyCommand('Get-Content a.txt *> $null').class).toBe('read.local');
    expect(classifyCommand('type a.txt >NUL').class).toBe('read.local');
    expect(classifyCommand('cat a.txt > /dev/null').class).toBe('read.local');
    expect(classifyCommand('cat a.txt > nul.txt').class).toBe('git.mutate');
    expect(classifyCommand('cat a.txt > /dev/null2').class).toBe('git.mutate');
  });

  it('never relaxes secrets or Friday-internal commands through configuration', () => {
    expect(classifyCommand('printenv', { 'secrets.read': 'auto' }).autonomy).toBe('never');
    expect(classifyCommand('git commit -m x', { 'git.mutate': 'auto' }).autonomy).toBe('auto');
  });

  it('judges every command a shell wrapper runs, as a host that wraps them sends it (ADR-0032 §4)', () => {
    // The forms Codex used on Windows in the M3.5 transcripts, and its POSIX form.
    const ps = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
    expect(classifyCommand(`${ps} -Command 'node --test'`).class).toBe('test.local');
    expect(classifyCommand(`${ps} -NoProfile -Command 'node --test; Remove-Item -Recurse src'`).class).toBe(
      'fs.destructive',
    );
    expect(classifyCommand(`"C:\\WINDOWS\\system32\\cmd.exe" /c 'git push origin main'`).class).toBe('git.push');
    expect(classifyCommand(`/bin/bash -lc 'git status && printenv'`).class).toBe('secrets.read');
    // Output redirected inside the wrapper is a write.
    expect(classifyCommand(`bash -lc 'echo hi > notes.txt'`).class).toBe('git.mutate');
    expect(wrappedCommand(`${ps} -Command 'Write-Output ''hi'''`)).toBe("Write-Output 'hi'");
    expect(wrappedCommand('node --test')).toBeNull();
  });

  it('judges what PowerShell blocks, script blocks and subexpressions run (the M8a live check)', () => {
    const ps = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"';
    // Codex's first command in the live check, as it sent it: reads only.
    const live = `${ps} -Command 'Get-ChildItem backend/src, backend/test | Select-Object FullName; if (Test-Path backend/src/discount.ts) { Get-Content backend/src/discount.ts }; Get-Content backend/test/checkout.service.test.ts -TotalCount 120; Get-Content package.json -ErrorAction SilentlyContinue; Get-Content backend/package.json -ErrorAction SilentlyContinue'`;
    expect(classifyCommand(live).class).toBe('read.local');
    const cases: [string, string][] = [
      ["if (Test-Path a) { Get-Content a } else { Write-Output 'none' }", 'read.local'],
      ["try { Get-Content a } catch { Write-Output 'missing' }", 'read.local'],
      ['foreach ($f in Get-ChildItem src) { Get-Content $f }', 'read.local'],
      ['Get-Content (Join-Path backend src.ts)', 'read.local'],
      [
        "Get-ChildItem -Recurse -File | Where-Object { $_.Name -like '*.ts' } | Select-Object -ExpandProperty FullName",
        'read.local',
      ],
      ['$files = Get-ChildItem src; $files | Select-Object -First 3', 'read.local'],
      ['Get-ChildItem | ForEach-Object { $_.FullName }', 'read.local'],
      // What runs inside a block or an expression counts.
      ['if (-not (Test-Path dist)) { New-Item -ItemType Directory dist }', 'git.mutate'],
      ['Get-ChildItem -Recurse | ForEach-Object { Remove-Item $_ }', 'git.mutate'],
      ['Get-ChildItem | ForEach-Object { Remove-Item -Recurse -Force $_ }', 'fs.destructive'],
      ['$x = Remove-Item -Recurse src', 'fs.destructive'],
      ['Write-Output "$(Remove-Item -Recurse src)"', 'fs.destructive'],
      ['if ($ok) { git push origin main }', 'git.push'],
      ['(cd build && rm -rf out)', 'fs.destructive'],
      ["Select-Object @{n='x'; e={ Remove-Item y }}", 'git.mutate'],
      // Method calls and .NET members: no rule knows what they do.
      ['Get-ChildItem | ForEach-Object { $_.Delete() }', 'unknown'],
      ['(Get-Item x).Delete()', 'unknown'],
      ["[System.IO.File]::Delete('x')", 'unknown'],
      ['Get-Item x | ForEach-Object Delete', 'unknown'],
      // Unbalanced brackets are judged as written.
      ['if (Test-Path a { Get-Content a', 'unknown'],
      // A method named inside quotes is text.
      ['rg "this.apply(" src', 'read.local'],
    ];
    // PowerShell commands, as Claude Code's PowerShell tool sends them: a shell not named is read as
    // POSIX, where a leading `$f` runs a command (LESSONS D-45).
    for (const [cmd, cls] of cases) expect(classifyCommand(cmd, {}, 'powershell').class, cmd).toBe(cls);
    expect(splitSegments('if (a) { b; c }; d')).toEqual(['if (a) { b; c }', 'd']);
  });
});

describe('evaluate', () => {
  it('allows writes inside the task scope, case-insensitively on Windows', () => {
    expect(write(['frontend/src/pricing/discount.ts']).decision).toBe('allow');
    expect(write(['FRONTEND\\SRC\\pricing\\x.ts']).decision).toBe('allow');
  });

  it('denies writes outside the scope with a reason that says how to proceed', () => {
    const res = write(['backend/src/checkout.service.ts']);
    expect(res).toMatchObject({
      decision: 'deny',
      rule: 'write.outside_scope',
      targets: ['backend/src/checkout.service.ts'],
    });
    expect(res.reason).toContain('friday_request_permission');
    expect(res.reason).not.toMatch(/security/i);
  });

  it('allows an out-of-scope write a human approved', () => {
    const res = write(['backend/x.ts'], {
      approved: (cap, target) => cap === 'file.write' && target === 'backend/x.ts',
    });
    expect(res.decision).toBe('allow');
  });

  it('asks when the agent holds no task, denies when the task is not running', () => {
    expect(evaluate({ ctx: WIN, task: null, action: { tool: 'Write', kind: 'write', paths: ['a.ts'] } }).decision).toBe(
      'ask',
    );
    expect(
      evaluate({
        ctx: WIN,
        task: { ...running([]), status: 'READY_FOR_VERIFICATION' },
        action: { tool: 'Write', kind: 'write', paths: ['a.ts'] },
      }).rule,
    ).toBe('write.task_not_running');
  });

  it('keeps review and research tasks without a write scope read-only', () => {
    const action = { tool: 'Edit', kind: 'write' as const, paths: ['src/a.ts'] };
    for (const kind of ['review', 'research']) {
      const res = evaluate({ ctx: WIN, task: { ...running([]), kind }, action });
      expect(res, kind).toMatchObject({ decision: 'deny', rule: 'write.read_only_task' });
      expect(res.reason).toContain('friday_request_permission');
    }
    expect(evaluate({ ctx: WIN, task: { ...running(['src/**']), kind: 'review' }, action }).decision).toBe('allow');
    expect(evaluate({ ctx: WIN, task: { ...running([]), kind: 'implementation' }, action }).rule).toBe(
      'write.no_scope',
    );
  });

  it('denies writes outside the project and into protected files, whatever the scope', () => {
    expect(write(['..\\other\\x.ts']).rule).toBe('write.outside_project');
    expect(write(['.claude/settings.json']).rule).toBe('sensitive.host.config');
    expect(
      evaluate({
        ctx: WIN,
        task: running([]),
        action: { tool: 'Write', kind: 'write', paths: ['.friday/config.yaml'] },
      }).decision,
    ).toBe('deny');
  });

  it('enforces one live writer per working tree (plan B26)', () => {
    const other = [{ task_id: 'task_2', agent_key: 'dev-2', scope: { write: ['frontend/**'], read: [] } }];
    expect(write(['frontend/src/pricing/a.ts'], { otherWriters: other }).rule).toBe('write.single_live_writer');
    const unrelated = [{ task_id: 'task_3', agent_key: 'dev-3', scope: { write: ['backend/**'], read: [] } }];
    expect(write(['frontend/src/pricing/a.ts'], { otherWriters: unrelated }).decision).toBe('allow');
    const unscoped = [{ task_id: 'task_4', agent_key: 'dev-4', scope: null }];
    expect(write(['frontend/src/pricing/a.ts'], { otherWriters: unscoped }).decision).toBe('deny');
  });

  it('denies reads and searches of protected paths, allows the rest', () => {
    const read = (paths: string[]) => evaluate({ ctx: WIN, task: null, action: { tool: 'Read', kind: 'read', paths } });
    expect(read(['.friday/project.db']).decision).toBe('deny');
    expect(read(['README.md']).decision).toBe('allow');
    const search = (patterns: string[], paths: string[] = []) =>
      evaluate({ ctx: WIN, task: null, action: { tool: 'Grep', kind: 'search', patterns, paths } });
    expect(search(['**/.env*']).decision).toBe('deny');
    expect(search(['token'], ['.friday/run']).decision).toBe('deny');
    expect(search(['**/*.ts']).decision).toBe('allow');
  });

  it('maps command classes to allow, ask and deny', () => {
    const cmd = (command: string, extra: Partial<PolicyInput> = {}) =>
      evaluate({ ctx: WIN, task: running([]), action: { tool: 'Bash', kind: 'command', command }, ...extra });
    expect(cmd('node --test').decision).toBe('allow');
    expect(cmd('git commit -m x').decision).toBe('ask');
    // The approval that lets it through, for a host with nobody to ask (ADR-0032 §4).
    expect(cmd('git commit -m x').grant).toEqual({ capability: 'shell.git.commit', target: 'git commit -m x' });
    expect(
      cmd('git commit -m x', { approved: (c, t) => c === 'shell.git.commit' && t === 'git commit -m x' }),
    ).toMatchObject({ decision: 'allow', relied_on: [{ capability: 'shell.git.commit', target: 'git commit -m x' }] });
    expect(cmd('git push').decision).toBe('deny');
    expect(cmd('git push', { approved: (c, t) => c === 'shell.git.push' && t === 'git push' }).decision).toBe('allow');
    expect(cmd('cat .env').rule).toBe('sensitive.secrets');
    expect(cmd('type .friday\\run\\daemon.json').rule).toBe('sensitive.friday.runtime');
    expect(cmd('Get-Content $env:LOCALAPPDATA\\Friday\\projects\\x\\bootstrap.token').rule).toBe(
      'sensitive.friday.private',
    );
    expect(cmd('friday approve apr_1').decision).toBe('deny');
  });

  it('asks before network access', () => {
    expect(
      evaluate({ ctx: POSIX, task: null, action: { tool: 'WebFetch', kind: 'network', url: 'https://x.dev' } })
        .decision,
    ).toBe('ask');
  });

  it("judges third-party MCP tools by the server policy, and never lets one reach Friday's files (ADR-0030)", () => {
    const mcp = (texts: string[], pathish: string[] = [], extra: Partial<PolicyInput> = {}) =>
      evaluate({
        ctx: WIN,
        task: running(['**']),
        action: { tool: 'mcp__fs__write_file', kind: 'mcp', server: 'fs', mcpTool: 'write_file', texts, pathish },
        ...extra,
      });
    expect(mcp(['hello']).decision).toBe('ask');
    expect(mcp(['hello'], [], { mcp: () => 'auto' }).decision).toBe('allow');
    expect(mcp(['hello'], [], { mcp: () => 'never' })).toMatchObject({ decision: 'deny', rule: 'mcp.never' });
    expect(mcp(['hello'], [], { mcp: () => 'manual' })).toMatchObject({ decision: 'deny', rule: 'mcp.manual' });
    expect(
      mcp(['hello'], [], { mcp: () => 'manual', approved: (c, t) => c === 'mcp.call' && t === 'fs/write_file' }),
    ).toMatchObject({ decision: 'allow', relied_on: [{ capability: 'mcp.call', target: 'fs/write_file' }] });
    // Whatever the server's level: Friday's state, runtime files, host config and secrets stay out of reach.
    for (const [texts, pathish] of [
      [['%LOCALAPPDATA%\\Friday\\credentials\\stripe.key'], []],
      [['cat .friday/run/daemon.json'], []],
      [['.claude/settings.json'], ['.claude/settings.json']],
      [['C:\\demo\\shop\\.mcp.json'], ['C:\\demo\\shop\\.mcp.json']],
      [['.git/config'], ['.git/config']],
      [['file:///C:/demo/shop/.env'], ['file:///C:/demo/shop/.env']],
    ] as [string[], string[]][]) {
      expect(mcp(texts, pathish, { mcp: () => 'auto' }).decision, texts[0]).toBe('deny');
    }
  });
});
