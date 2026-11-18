/**
 * Commands that change files, and the commands a person was asked about for no reason
 * (2026-11-18). The first block is the trial's own list: each line was a card on a person's
 * screen, and none of them needed one.
 */
import { describe, expect, it } from 'vitest';
import { classifyCommand, isTempPath, shellWrites, splitSegments } from './commands.js';
import { evaluate, type PolicyInput, type PolicyTask } from './evaluate.js';
import type { PathContext } from './paths.js';

const WIN: PathContext = { projectRoot: 'C:\\demo\\shop', stateDir: 'C:\\state\\friday', windows: true };
const POSIX: PathContext = { projectRoot: '/home/me/shop', stateDir: '/home/me/.local/state/friday', windows: false };
const running = (write: string[]): PolicyTask => ({ task_id: 'task_1', status: 'RUNNING', scope: { write, read: [] } });
const run = (command: string, extra: Partial<PolicyInput> = {}, tool = 'Bash', ctx = POSIX) =>
  evaluate({
    ctx,
    task: running(['apps/owner-web/**']),
    action: { tool, kind: 'command', command },
    ...extra,
  });

describe('what the trial asked a person about, and need not have', () => {
  it.each([
    // The project's own test runner, behind a time limit.
    ['timeout 150 npx vitest run src/modules/menu/menu.test.ts 2>&1 | tail -25', 'test.local'],
    // A pattern with an escaped quote and an alternation: it was split at the `|` inside the quotes.
    [
      'cd "/c/wt/x"; grep -n "json(" a.ts; grep -n "\\"dates\\|exports" -A12 packages/shared/package.json | head -30; sed -n 30,200p t.ts',
      'read.local',
    ],
    // The formatter, as npm runs it.
    ['npm.cmd exec -- prettier --check a.ts b.ts docs/04-api-contract.md', 'lint.local'],
    ['npm exec prettier -- --check a.ts', 'lint.local'],
    // A list of processes.
    ['Get-Process node -ErrorAction SilentlyContinue | Select-Object Id, CPU, WorkingSet, StartTime', 'read.local'],
    // Lint, with its output kept in a temporary file to count from.
    [
      'cd "/c/wt/x" && npx eslint . --max-warnings 0 -f unix > "$TEMP/lint.txt" 2>&1; tr \'\\\\\' \'/\' < "$TEMP/lint.txt" | grep -oE "x/[a-z-]+" | sort | uniq -c | sort -rn | head; grep -c "owner-web" "$TEMP/lint.txt"',
      'read.local',
    ],
    // A copy kept in the temporary folder while a file is repaired.
    ['git diff --stat; cp package-lock.json /tmp/lock.bak; git diff --name-only', 'git.read'],
  ])('%s → %s, without asking', (command, cls) => {
    const c = classifyCommand(command, {}, 'posix');
    expect(c.class).toBe(cls);
    expect(c.autonomy).toBe('auto');
    expect(c.writes).toBeUndefined();
  });

  it('reads the command Codex wraps for PowerShell, with a quote written as a quoted quote', () => {
    const codex =
      '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe" -Command "Get-Content a.ts -TotalCount 240; rg -n \'branding|logoUrl\' --glob \'"\'!package-lock.json\'"\'"';
    const c = classifyCommand(codex);
    expect(c.segments.map((s) => s.class)).toEqual(['read.local', 'read.local']);
    expect(c.autonomy).toBe('auto');
    // What it hides is still found: the same wrapper around a delete asks.
    const hidden = codex.replace('Get-Content a.ts -TotalCount 240', 'Remove-Item -Recurse -Force src');
    expect(classifyCommand(hidden).class).toBe('fs.destructive');
  });
});

describe('a wrapper passes its command on, and hides nothing', () => {
  it.each([
    ['timeout 5 rm -rf src', 'fs.destructive'],
    ['timeout -s KILL 30 git push', 'git.push'],
    ['timeout --signal=TERM 10s npm install', 'package.install'],
    ['npm exec -- rimraf src', 'unknown'],
    ['npm exec --package=cowsay -- cowsay hi', 'unknown'],
    // A command line for a shell is not a program Friday knows.
    ["npm exec -c 'rm -rf src'", 'unknown'],
    // Alone, `timeout` only waits.
    ['timeout /t 5 /nobreak', 'read.local'],
    ['sleep 2', 'read.local'],
  ])('%s → %s', (command, cls) => {
    expect(classifyCommand(command).class).toBe(cls);
  });

  it('keeps a backslash before a quote only where the shell is known to be POSIX', () => {
    const grep = 'grep -n "\\"a\\|b" x | head';
    expect(splitSegments(grep, 'posix')).toEqual(['grep -n "\\"a\\|b" x', 'head']);
    // PowerShell, cmd, or a shell nobody named: the string ends at the quote, and what follows
    // it is a command to judge. `"C:\dir\"; Remove-Item …` must never read as one string.
    const ps = 'Get-ChildItem "C:\\dir\\"; Remove-Item -Recurse -Force src';
    for (const shell of ['powershell', 'cmd', undefined] as const) {
      expect(classifyCommand(ps, {}, shell).class).toBe('fs.destructive');
    }
  });

  it("knows PowerShell's Get-* cmdlets as reads, except those that reach what is kept private", () => {
    expect(classifyCommand('Get-Service | Where-Object Status -eq Running').class).toBe('read.local');
    expect(classifyCommand('Get-ItemProperty .\\package.json').class).toBe('read.local');
    for (const c of ['Get-Credential', 'Get-Secret api', 'Get-Clipboard']) {
      expect(classifyCommand(c).class).toBe('unknown');
    }
    // An environment dump is still what it is.
    expect(classifyCommand('Get-ChildItem env:').class).toBe('secrets.read');
  });
});

describe('where a command writes', () => {
  it('names the files of a plain line, with a cd applied', () => {
    expect(shellWrites("sed -i 's/a/b/' hooks/a.ts hooks/b.ts")).toEqual({
      paths: ['hooks/a.ts', 'hooks/b.ts'],
      opaque: false,
    });
    expect(
      shellWrites(
        'cd "C:/wt/x/apps/owner-web" && mkdir -p src/new && touch src/new/a.ts && cd ../.. && echo hi > notes.md',
      ),
    ).toEqual({
      paths: [
        'C:/wt/x/apps/owner-web/src/new',
        'C:/wt/x/apps/owner-web/src/new/a.ts',
        'C:/wt/x/apps/owner-web/../../notes.md',
      ],
      opaque: false,
    });
    // A copy writes its last word; a move changes both.
    expect(shellWrites('cp a.ts b.ts').paths).toEqual(['b.ts']);
    expect(shellWrites('mv a.ts b.ts').paths).toEqual(['a.ts', 'b.ts']);
    expect(shellWrites('chmod +x scripts/run.sh').paths).toEqual(['scripts/run.sh']);
    expect(shellWrites('npx tsc --noEmit 2> errors.txt | tee -a build.log').paths).toEqual(['errors.txt', 'build.log']);
  });

  it('leaves temporary files and thrown-away output out', () => {
    expect(shellWrites('npx eslint . > "$TEMP/lint.txt" 2>&1; cat x > /dev/null; cp a /tmp/b')).toEqual({
      paths: [],
      opaque: false,
    });
    expect(isTempPath('/tmp/lock.bak')).toBe(true);
    expect(isTempPath('$TMPDIR/a/b.txt')).toBe(true);
    expect(isTempPath('%TEMP%\\out.txt')).toBe(true);
    expect(isTempPath('$env:TEMP\\out.txt')).toBe(true);
    // No way back out of it, and nothing that only looks like it.
    expect(isTempPath('/tmp/../etc/passwd')).toBe(false);
    expect(isTempPath('/tmp/$HOME/x')).toBe(false);
    expect(isTempPath('/tmpx/a')).toBe(false);
    expect(isTempPath('tmp/a')).toBe(false);
    expect(classifyCommand('echo x > /tmp/../src/a.ts').class).toBe('file.write');
  });

  it.each([
    // A name the shell fills in.
    ['echo x > "$OUT/a.ts"'],
    ['sed -i s/a/b/ src/*.ts'],
    ['touch ~/notes'],
    // A command inside a command.
    ["bash -c 'echo x > a.ts'"],
    ['echo x > $(cat name.txt)'],
    ['find . -name "*.ts" -exec sed -i s/a/b/ {} +'],
    ['(cd src && touch a.ts)'],
    // Parameters Friday does not read.
    ["Set-Content src/a.ts 'x'"],
    ["sed -i -e 's/a/b/' -f script.sed a.ts"],
    // A folder Friday could not follow, then a relative name.
    ['cd "$DIR" && touch a.ts'],
    ['pushd src; touch a.ts'],
    // A quote written with a backslash.
    ['echo "a \\" > b" > c.ts'],
  ])('cannot tell for: %s', (command) => {
    const w = shellWrites(command);
    expect(w).toEqual({ paths: [], opaque: true });
    const c = classifyCommand(command);
    expect(c.autonomy).not.toBe('auto');
  });

  it('is not fooled by a redirection that only stands inside quotes', () => {
    expect(classifyCommand('echo "a > b.ts"').class).toBe('read.local');
    expect(classifyCommand("grep -E 'x>y' a.ts | sed 's/>//'").class).toBe('read.local');
  });
});

describe('a command that changes files is judged by its files', () => {
  it('passes inside the task’s files, as an edit of them does', () => {
    const r = run(
      "sed -i 's/void/string/' apps/owner-web/src/hooks/a.ts apps/owner-web/src/hooks/b.ts && npx tsc --noEmit",
    );
    expect(r).toMatchObject({ decision: 'allow', rule: 'command.file.write', command_class: 'file.write' });
    // From the folder the host says the command runs in, and through a cd.
    expect(
      run('mkdir -p src/new && touch src/new/a.ts', {
        action: {
          tool: 'Bash',
          kind: 'command',
          command: 'mkdir -p src/new && touch src/new/a.ts',
          cwd: '/home/me/shop/apps/owner-web',
        },
      }).decision,
    ).toBe('allow');
    expect(run('cd apps/owner-web/src && echo "export {}" > index.ts').decision).toBe('allow');
    // Git Bash on Windows names the drive as /c/.
    expect(run('cd "/c/demo/shop/apps/owner-web" && touch src/a.ts', {}, 'Bash', WIN).decision).toBe('allow');
  });

  it('asks about a file outside them, and names it', () => {
    const r = run("sed -i 's/a/b/' apps/api/src/main.ts");
    expect(r).toMatchObject({ decision: 'ask', rule: 'command.file.write', command_class: 'file.write' });
    expect(r.reason).toContain('apps/api/src/main.ts');
    expect(r.reason).toContain('outside the scope');
    expect(r.reason).not.toContain('git.mutate');
    expect(r.grant).toEqual({ capability: 'file.write', target: "sed -i 's/a/b/' apps/api/src/main.ts" });
    // One file inside and one outside is still a question.
    expect(run('touch apps/owner-web/a.ts apps/api/b.ts').decision).toBe('ask');
    // Outside the project altogether.
    expect(run('echo x > ../other/a.ts').decision).toBe('ask');
    expect(run('cp apps/owner-web/a.ts /etc/a.ts').decision).toBe('ask');
    // Approved once, that command passes.
    expect(run("sed -i 's/a/b/' apps/api/src/main.ts", { approved: (cap) => cap === 'file.write' }).decision).toBe(
      'allow',
    );
  });

  it('asks when it cannot tell which files, and says so', () => {
    const r = run('sed -i s/a/b/ apps/owner-web/src/*.ts');
    expect(r.decision).toBe('ask');
    expect(r.reason).toContain('cannot tell from the command which files');
    // Unless a person let such commands run.
    expect(run('sed -i s/a/b/ apps/owner-web/src/*.ts', { autonomy: { 'file.write': 'auto' } }).decision).toBe('allow');
  });

  it('asks about a named file outside the task’s files whatever that setting says', () => {
    const loose = { autonomy: { 'file.write': 'auto' } } as const;
    const outside = run("sed -i 's/a/b/' apps/api/src/main.ts", loose);
    expect(outside).toMatchObject({ decision: 'ask', rule: 'command.file.write', command_class: 'file.write' });
    expect(outside.reason).toContain('apps/api/src/main.ts');
    expect(outside.grant).toEqual({ capability: 'file.write', target: "sed -i 's/a/b/' apps/api/src/main.ts" });
    // Through a redirection too, where no segment is a file-changing command.
    expect(run('echo x > apps/api/notes.txt', loose).decision).toBe('ask');
    // Inside them it still runs, and what is protected is still refused.
    expect(run('touch apps/owner-web/a.ts', loose).decision).toBe('allow');
    expect(run('echo KEY=1 > .env', loose).decision).toBe('deny');
    // Approved once, it passes.
    expect(
      run("sed -i 's/a/b/' apps/api/src/main.ts", { ...loose, approved: (cap) => cap === 'file.write' }).decision,
    ).toBe('allow');
  });

  it('never lets its files carry another command through', () => {
    // The install is asked about as an install, whatever the mkdir writes.
    const install = run('mkdir -p apps/owner-web/x && npm install left-pad');
    expect(install).toMatchObject({ decision: 'ask', command_class: 'package.install' });
    const push = run('touch apps/owner-web/a.ts && git push');
    expect(push.decision).toBe('deny');
    expect(push.command_class).toBe('git.push');
    // A commit is still a commit.
    expect(run('git commit -am wip')).toMatchObject({ decision: 'ask', command_class: 'git.mutate' });
  });

  it('keeps what Friday protects protected', () => {
    for (const command of ['echo KEY=1 > .env', 'cp x .git/hooks/pre-commit', 'touch .friday/config.yaml']) {
      expect(run(command).decision, command).toBe('deny');
    }
  });

  it('holds a task that may not write to the same rule', () => {
    const idle: PolicyTask = { ...running(['apps/owner-web/**']), status: 'COMPLETED' };
    expect(run('touch apps/owner-web/a.ts', { task: idle }).decision).toBe('ask');
    expect(run('touch apps/owner-web/a.ts', { task: null }).decision).toBe('ask');
    const research: PolicyTask = { task_id: 't', status: 'RUNNING', kind: 'research', scope: { write: [], read: [] } };
    expect(run('touch notes.md', { task: research }).decision).toBe('ask');
  });
});
