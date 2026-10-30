/**
 * Commands as Claude Code's Bash tool sends them (Git Bash on Windows, any POSIX shell elsewhere).
 * In the VS Code panel it read files with `for` loops and bracketed groups, which the classifier
 * called unknown, so a human was asked and a spawned session would have been refused (LESSONS D-44).
 * Commands that bash runs inside backticks, and `find` that deletes or runs a command, passed as
 * reads (LESSONS D-45). `xargs` and `case … esac` asked a human whatever they ran (M11.1). Reads must
 * pass; what runs inside, deletes or writes must be judged as such.
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
  // `xargs` runs the command written after its options; alone, it runs `echo` (M11.1).
  "find . -name '*.ts' | xargs grep -l discount",
  'git ls-files | xargs -I {} git log --oneline -1 {}',
  'git ls-files | xargs -I{} git log --oneline -1 {}',
  "find . -name '*.ts' -print0 | xargs -0 wc -l",
  "find . -name '*.md' | xargs -n 1 -P 4 head -n 3",
  'git ls-files | xargs -rn1 wc -l',
  "find . -name '*.ts' | xargs --max-args=1 grep -l discount",
  "find . -name '*.ts' | xargs -d '\\n' -- cat",
  'ls | xargs',
  // `case … esac` runs what its word and patterns substitute, and every branch's commands (M11.1).
  'case "$x" in a) cat /tmp/x;; b) echo ok;; esac',
  'case "$1" in\n  start) node --version ;;\n  *) echo "usage: $0 start" ;;\nesac',
  'for f in *.sh; do case "$f" in *.test.sh) cat "$f";; *) echo skip;; esac; done',
  'case $(git status --porcelain) in "") echo clean;; *) echo dirty;; esac',
  `case "\${1:-}" in -h|--help) echo usage;; esac`,
  'case x in (a) ls;; esac',
  'case x in a) ls;& b) cat f;;& c) echo ok;; esac',
  'case x in a) echo a; esac',
  'case $a in x) case $b in y) ls;; esac;; esac',
  '(case x in a) ls;; esac)',
  'echo "$(case x in a) ls;; esac)"',
  'if case x in a) true;; esac; then ls; fi',
  // A read run in the background, or two reads separated by `&`, stays a read (M11.1 review).
  '(cat y) &',
  '(npm test) &',
  '{ cat y; } &',
  'nohup npm test &',
  'nohup npm test >/dev/null 2>&1 &',
  'cat x & cat y',
  "sh -c 'echo $1' sh foo",
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
  // What `xargs` runs, with its arguments, is judged as it would be alone (M11.1).
  ["find . -name '*.ts' | xargs rm -rf", 'fs.destructive'],
  ['find . -name node_modules -type d -print0 | xargs -0 rm -rf', 'fs.destructive'],
  ["git ls-files '*.bak' | xargs git rm", 'git.mutate'],
  ['cat urls.txt | xargs -n 1 curl -s', 'network.fetch'],
  ["find . -name '*.log' | xargs -I {} sh -c 'rm -rf {}'", 'fs.destructive'],
  // Every branch of a `case`, and what its word or a pattern substitutes (M11.1).
  ['case "$x" in a) rm -rf /tmp/x;; b) echo ok;; esac', 'fs.destructive'],
  ['case "$1" in deploy) git push origin main;; *) echo usage;; esac', 'git.push'],
  ['case $a in x) case $b in y) rm -rf z;; esac;; *) echo ok;; esac', 'fs.destructive'],
  ['case $(rm -rf x) in a) echo ok;; esac', 'fs.destructive'],
  ['case x in $(rm -rf y)) echo ok;; esac', 'fs.destructive'],
  ['(case x in a) rm -rf y;; esac)', 'fs.destructive'],
  ['echo `case x in a) rm -rf y;; esac`', 'fs.destructive'],
  ['case x in a) find . -name y -exec rm -rf {} \\;;; esac', 'fs.destructive'],
  ['case x in a) echo ok;; esac | xargs rm -rf', 'fs.destructive'],
  // A `case` that does not parse is judged as written, so a human decides.
  ['case $x in a) rm -rf /tmp/x', 'unknown'],
  // `xargs` whose command is its input runs whatever a file or a pipe holds: judged as written, so a
  // human decides (M11.1 review: the placeholder expanded to nothing and the line passed as a read).
  ["echo 'rm -rf x' | xargs -I{} {}", 'unknown'],
  ["cat cmds.txt | xargs -I {} sh -c '{}'", 'unknown'],
  ['cat cmds.txt | xargs -I {} sh -c {}', 'unknown'],
  ["echo 'rm -rf x' | xargs sh -c", 'unknown'],
  ["echo 'rm -rf x' | xargs -0 sh -c", 'unknown'],
  ['echo rm | xargs -I{} {} -rf x', 'unknown'],
  ['xargs -I{} {} < cmds.txt', 'unknown'],
  ['cat cmds.txt | xargs -L1 bash', 'unknown'],
  ["cat cmds.txt | xargs --replace sh -c '{}'", 'unknown'],
  ['cat cmds.txt | xargs -i {}', 'unknown'],
  // A shell with no command text, and a substitution's output run as the command, are unknown too.
  ['bash -c', 'unknown'],
  ['`cat cmds.txt`', 'unknown'],
  // A command run in the background is judged as itself, behind a wrapper, `nohup` or `sudo` too
  // (M11.1 review: the `&` left in the segment hid the quoted command).
  ["bash -c 'rm -rf y' &", 'fs.destructive'],
  ["nohup bash -c 'rm -rf y' &", 'fs.destructive'],
  ["sudo bash -c 'rm -rf y' &", 'fs.destructive'],
  ["nohup bash -c 'rm -rf y' >/dev/null 2>&1 &", 'fs.destructive'],
  ["bash -c 'rm -rf y' >/dev/null 2>&1", 'fs.destructive'],
  ["bash -c 'rm -rf y' arg", 'fs.destructive'],
  ["bash -c 'cat x' $(rm -rf y)", 'fs.destructive'],
  ['(rm -rf y) &', 'fs.destructive'],
  ['{ rm -rf y; } &', 'fs.destructive'],
  ["(bash -c 'rm -rf y') &", 'fs.destructive'],
  ['cat x & rm -rf y', 'fs.destructive'],
  ['nohup rm -rf y &', 'fs.destructive'],
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

  it('a write inside what xargs runs, inside a case branch or after the case needs a human', () => {
    expect(posix("echo x | xargs -I {} sh -c 'echo {} > out.txt'").autonomy).toBe('review');
    expect(posix('case $x in a) echo hi > out.txt;; esac').autonomy).toBe('review');
    expect(posix("case x in a) sh -c 'echo hi > f';; esac").autonomy).toBe('review');
    expect(posix('case x in a) ls;; esac > out.txt').autonomy).toBe('review');
  });

  it("a write after a wrapper's quoted command, or inside it, needs a human; output thrown away does not", () => {
    expect(posix("bash -c 'cat x' > out.txt").autonomy).toBe('review');
    expect(posix("bash -c 'cat x > out.txt' 2>&1").autonomy).toBe('review');
    expect(posix("bash -c 'cat x' >/dev/null 2>&1 &").autonomy).toBe('auto');
    expect(posix('(cat x) > out.txt &').autonomy).toBe('review');
  });
});

describe('xargs and case by shell (M11.1)', () => {
  it('judges xargs as the command it runs in every shell', () => {
    const ps = (c: string) => classifyCommand(c, {}, 'powershell');
    expect(ps('Get-ChildItem -Recurse -Filter *.ts | xargs rm -rf').class).toBe('fs.destructive');
    expect(ps('Get-ChildItem -Recurse -Filter *.ts | xargs grep -l x').autonomy).toBe('auto');
    // PowerShell's own form of the same thing is a script block, judged on its own.
    expect(ps('Get-ChildItem -Recurse -Filter *.ts | ForEach-Object { Remove-Item -Recurse -Force $_ }').class).toBe(
      'fs.destructive',
    );
    expect(ps('Get-ChildItem -Recurse -Filter *.ts | ForEach-Object { Get-Content $_.FullName }').autonomy).toBe(
      'auto',
    );
    expect(classifyCommand('dir /b | xargs del /s', {}, 'cmd').class).toBe('fs.destructive');
    expect(classifyCommand('bash -lc \'find . -name "*.ts" | xargs rm -rf\'').class).toBe('fs.destructive');
  });

  it('reads case … esac only in the shells where it is syntax', () => {
    // PowerShell has no `case`; the words are judged as written and ask a human.
    expect(classifyCommand('case "$x" in a) Get-Content x;; esac', {}, 'powershell').autonomy).toBe('review');
    expect(classifyCommand('bash -lc \'case "$x" in a) rm -rf /tmp/x;; b) echo ok;; esac\'').class).toBe(
      'fs.destructive',
    );
    expect(classifyCommand('bash -lc \'case "$x" in a) cat /tmp/x;; b) echo ok;; esac\'').autonomy).toBe('auto');
  });
});

/**
 * Found while reading `xargs` (M11.1): a word that only passes a command on (`sudo`, `env`,
 * `command`) hid a shell wrapper and `find -exec` from the judge, a redirection inside what
 * `find -exec` runs was not a write, and `env` alone, an environment dump, was dropped as a wrapper
 * and passed as a read.
 */
describe('what a pass-through word hides (M11.1)', () => {
  it('judges what sudo, env and command pass on', () => {
    expect(posix('sudo find . -name x -exec rm -rf {} \\;').class).toBe('fs.destructive');
    expect(posix('command find . -name x -exec rm -rf {} \\;').class).toBe('fs.destructive');
    expect(posix('sudo find . -name x -exec grep -l y {} +').autonomy).toBe('auto');
    expect(posix("sudo bash -c 'cat x; rm -rf y'").class).toBe('fs.destructive');
    expect(posix("env bash -c 'cat x; rm -rf y'").class).toBe('fs.destructive');
    expect(posix('sudo xargs rm -rf').class).toBe('fs.destructive');
  });

  it('sees a write inside what find -exec runs', () => {
    expect(posix("find . -name x -exec sh -c 'echo x > f' \\;").autonomy).toBe('review');
  });

  it('never allows an environment dump, however it is reached', () => {
    for (const c of ['env', 'env | grep PATH', 'bash -lc env', 'FOO=1 env']) expect(posix(c).autonomy, c).toBe('never');
    expect(posix('env FOO=1 node --version').autonomy).toBe('auto');
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

describe("the project's own checks (plan M14.6)", () => {
  const CHECKS = [
    ['node', '--test', '**/test/*.test.ts'],
    ['node', 'scripts/check.mjs'],
  ];
  const judged = (c: string, shell: 'posix' | 'powershell' = 'posix') => classifyCommand(c, {}, shell, CHECKS);

  it('runs a declared check as a test run, and the same command without it as unknown', () => {
    expect(judged('node scripts/check.mjs')).toMatchObject({ class: 'test.local', autonomy: 'auto' });
    expect(posix('node scripts/check.mjs')).toMatchObject({ class: 'unknown', autonomy: 'review' });
    expect(judged('node scripts/check.mjs 2>&1', 'powershell').class).toBe('test.local');
    expect(judged('"C:/Program Files/nodejs/node.exe" scripts/check.mjs').class).toBe('test.local');
    expect(judged("node 'scripts/check.mjs'").class).toBe('test.local');
  });

  it('matches the arguments exactly and still judges everything else on the line', () => {
    expect(judged('node scripts/check.mjs --fix').class).toBe('unknown');
    expect(judged('node scripts/other.mjs').class).toBe('unknown');
    expect(judged('node --test "**/test/*.test.ts" 2>&1 | tail -25; node scripts/check.mjs')).toMatchObject({
      class: 'test.local',
      autonomy: 'auto',
    });
    expect(judged('node scripts/check.mjs; rm -rf src').class).toBe('fs.destructive');
    // A "check" that deletes or pushes is judged as what it does, declared or not.
    const hostile = [
      ['rm', '-rf', 'src'],
      ['git', 'push', '--force'],
    ];
    expect(classifyCommand('rm -rf src', {}, 'posix', hostile).class).toBe('fs.destructive');
    expect(classifyCommand('git push --force', {}, 'posix', hostile).class).toBe('git.force');
    // A redirection still writes, whatever runs.
    expect(judged('node scripts/check.mjs > report.txt').autonomy).toBe('review');
  });
});
