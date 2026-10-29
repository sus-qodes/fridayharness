/**
 * Commands as Claude Code's Bash tool sends them (Git Bash on Windows, any POSIX shell elsewhere).
 * In the VS Code panel it read files with `for` loops and bracketed groups, which the classifier
 * called unknown, so a human was asked and a spawned session would have been refused (LESSONS D-44).
 * Commands that bash runs inside backticks, and `find` that deletes or runs a command, passed as
 * reads (LESSONS D-45). Reads must pass; what runs inside, deletes or writes must be judged as such.
 */
import { describe, expect, it } from 'vitest';
import { classifyCommand, evaluate, type PathContext, type PolicyTask } from './index.js';

const posix = (c: string) => classifyCommand(c, {}, 'posix');

const READS = [
  // From the interactive check in the VS Code panel.
  'for f in frontend/src/*.ts frontend/test/*.ts shared/src/api.ts backend/src/checkout.service.ts README.md DECISIONS.md tsconfig.json; do echo "=== $f"; cat "$f"; done; node --version',
  '(ls node_modules/.bin/tsc 2>/dev/null || command -v tsc || echo "no tsc available")',
  'for f in a.txt b.txt; do cat "$f"; done',
  'for f in $(git ls-files); do wc -l "$f"; done',
  'for f in `git ls-files`; do wc -l "$f"; done',
  'while read -r line; do echo "$line"; done < files.txt',
  'if [ -f package.json ]; then cat package.json; fi',
  'if [[ -d src ]]; then ls src; else echo none; fi',
  'if test -d src; then ls src; fi',
  'command -v node',
  'command -V git',
  'cat `echo a.txt`',
  'echo "today: `date`"',
  "find . -name '*.ts'",
  "find . -name '*.ts' -exec grep -l discount {} +",
  'find src -type f -exec wc -l {} \\;',
];

/** What bash runs inside a read-only frame keeps its own class. */
const GATED: [string, string][] = [
  ['for f in *.ts; do rm -rf "$f"; done', 'fs.destructive'],
  ['for f in a b; do git push; done', 'git.push'],
  ['for f in $(curl -s https://example.com/x); do cat "$f"; done', 'network.fetch'],
  ['while true; do curl https://example.com; done', 'network.fetch'],
  ['if [ -f x ]; then printenv; fi', 'secrets.read'],
  ['command git push', 'git.push'],
  ['command rm -rf build', 'fs.destructive'],
  ['echo `rm -rf build`', 'fs.destructive'],
  ['echo "`curl -s https://example.com`"', 'network.fetch'],
  ['cat `git push`', 'git.push'],
  ["find . -name '*.tmp' -delete", 'fs.destructive'],
  ['find . -name x -exec rm -rf {} \\;', 'fs.destructive'],
  ["find . -name x -execdir sh -c 'curl https://example.com' \\;", 'network.fetch'],
  ['find . -name x -ok git push \\;', 'git.push'],
  // A leading variable runs what it holds.
  ['x=rm; $x -rf build', 'unknown'],
];

describe('Claude Code bash forms (LESSONS D-44)', () => {
  it.each(READS)('reads, so it runs without a decision: %s', (c) => {
    expect(posix(c).autonomy).toBe('auto');
  });

  it.each(GATED)('what runs inside is judged as itself: %s', (c, cls) => {
    expect(posix(c).class).toBe(cls);
  });

  it('a write inside a loop or after it still needs a human', () => {
    expect(posix('for f in a; do cat "$f" > out.txt; done').autonomy).toBe('review');
    expect(posix('for f in a; do cat "$f"; done > out.txt').autonomy).toBe('review');
    expect(posix("find . -name '*.ts' -fprint list.txt").autonomy).toBe('review');
  });
});

describe('backticks by shell (LESSONS D-45)', () => {
  it('runs a backtick substitution in a POSIX shell, and when the shell is not known', () => {
    expect(posix('echo `rm -rf build`').class).toBe('fs.destructive');
    expect(classifyCommand('echo `rm -rf build`').class).toBe('fs.destructive');
    expect(classifyCommand("bash -lc 'echo `rm -rf build`'").class).toBe('fs.destructive');
  });

  it("keeps PowerShell's backtick escapes as text", () => {
    const ps = 'Write-Output "`n=== a.ts`n"; Get-Content a.ts';
    expect(classifyCommand(ps, {}, 'powershell').autonomy).toBe('auto');
    const wrapped = `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '${ps}'`;
    expect(classifyCommand(wrapped).autonomy).toBe('auto');
  });
});

describe('the shell comes from the host tool', () => {
  const ctx: PathContext = {
    projectRoot: 'C:\\demo\\shop',
    stateDir: 'C:\\Users\\me\\AppData\\Local\\Friday',
    windows: true,
  };
  const task: PolicyTask = { task_id: 'task_1', status: 'RUNNING', scope: { write: ['src/**'], read: [] } };
  const run = (tool: string, command: string) => evaluate({ ctx, task, action: { tool, kind: 'command', command } });

  it('judges Bash commands as bash, PowerShell commands as PowerShell', () => {
    expect(run('Bash', 'for f in a.txt b.txt; do cat "$f"; done').decision).toBe('allow');
    expect(run('Bash', 'echo `rm -rf build`').decision).toBe('ask');
    expect(run('PowerShell', 'Write-Output "`n---`n"').decision).toBe('allow');
  });
});
