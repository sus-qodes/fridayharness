/**
 * Commands as Codex sends them on Windows (ADR-0032 §4): each wrapped in PowerShell, often several
 * statements with blocks. The M8a live check met two that Friday's classifier could not read, and
 * the model, told not to try a declined action another way, stopped. Reads must pass; writes,
 * deletions, pushes and what no rule knows must not.
 */
import { describe, expect, it } from 'vitest';
import { classifyCommand } from './commands.js';

const PS = '"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command';
/** As Codex wraps a command: in PowerShell's single quotes, a quote written twice. */
const wrap = (c: string) => `${PS} '${c.replace(/'/g, "''")}'`;

const READS = [
  // The two commands of the live check.
  'Get-ChildItem backend/src, backend/test | Select-Object FullName; if (Test-Path backend/src/discount.ts) { Get-Content backend/src/discount.ts }; Get-Content backend/test/checkout.service.test.ts -TotalCount 120; Get-Content package.json -ErrorAction SilentlyContinue; Get-Content backend/package.json -ErrorAction SilentlyContinue',
  'Get-ChildItem backend/src, backend/test | Select-Object FullName; if (Test-Path backend/src/discount.ts) { Get-Content backend/src/discount.ts }; Get-ChildItem backend/test -File | ForEach-Object { "--- $($_.Name)"; Get-Content $_.FullName }',
  'Get-ChildItem -Force',
  'Get-ChildItem -Recurse -File | Select-Object -ExpandProperty FullName',
  'Get-ChildItem -Recurse -Filter *.ts | % { $_.FullName }',
  'rg --files',
  'rg -n "applyDiscount" backend',
  'Get-Content -Raw backend/src/checkout.service.ts',
  'Get-Content backend/src/x.ts -TotalCount 200',
  "Select-String -Path backend/src/*.ts -Pattern 'discount' -Context 2,2",
  "if (Test-Path x) { Get-Content x } else { 'missing' }",
  'if (Test-Path x) { Get-Content x } else { Write-Output "missing x" }',
  '$i = 0; Get-Content x | ForEach-Object { $i++; "{0,4}: {1}" -f $i, $_ }',
  'Select-String -Path backend\\src\\*.ts -Pattern applyDiscount | ForEach-Object { "$($_.Path):$($_.LineNumber): $($_.Line)" }',
  '$PSVersionTable.PSVersion',
  'node --version',
  'Get-Location',
  '(Get-Content x).Length',
  'Get-Content x | Measure-Object -Line',
  'Get-ChildItem -Path . -Recurse -Include *.ts -Exclude node_modules | Sort-Object Length -Descending | Select-Object -First 10 Name, Length',
  'Get-Item backend | Format-List *',
  'Write-Host "Done"',
  'Get-Content backend/test/x.ts -ErrorAction SilentlyContinue 2>$null',
  'Get-Content x > $null',
  'if ($LASTEXITCODE -ne 0) { exit 1 }',
  "Get-ChildItem . -Directory | Where-Object { $_.Name -notlike '.*' } | ForEach-Object { $_.Name }",
  'Get-Content package.json | ConvertFrom-Json | Select-Object -ExpandProperty scripts',
  'Test-Path backend/src/discount.ts',
  'Get-ChildItem -Recurse backend | Where-Object { -not $_.PSIsContainer } | Select-Object FullName',
  'foreach ($f in Get-ChildItem backend/src) { Write-Output "== $($f.Name)"; Get-Content $f.FullName -TotalCount 40 }',
  "try { Get-Content x -ErrorAction Stop } catch { Write-Output 'not found' }",
];

const TESTS = [
  'node --test backend/test/discount.test.ts',
  'node --test backend/test/discount.test.ts 2>&1 | Select-Object -Last 40',
  'npm test',
];

const GIT_READS = ['git status --short', 'git --no-pager diff -- backend', 'git log --oneline -5'];

/** Each must reach at least a human's decision; [command, class] where the class is certain. */
const NOT_ALLOWED: [string, string][] = [
  ["Set-Content backend/src/x.ts 'export {}'", 'git.mutate'],
  ['New-Item -ItemType File backend/src/x.ts -Force', 'git.mutate'],
  ['"export const x = 1" | Out-File backend/src/x.ts', 'git.mutate'],
  ['Remove-Item -Recurse -Force backend/dist', 'fs.destructive'],
  ['git commit -am "wip"', 'git.mutate'],
  ['git push', 'git.push'],
  ['"C:\\Program Files\\nodejs\\node.exe" -e "require(\'fs\').rmSync(\'x\', { recursive: true })"', 'unknown'],
  ['Invoke-WebRequest https://example.com', 'network.fetch'],
  ['Get-ChildItem env:', 'secrets.read'],
  ["[IO.File]::ReadAllText('x')", 'unknown'],
  ["Get-Content x | ForEach-Object { $_.Replace('a', 'b') } | Set-Content y", ''],
  ['Start-Process notepad', 'unknown'],
  ['iex (Get-Content x -Raw)', 'unknown'],
  ['Get-ChildItem | ForEach-Object { Remove-Item -Recurse -Force $_ }', 'fs.destructive'],
  ['if (Test-Path x) { Remove-Item -Recurse x }', 'fs.destructive'],
  ['Write-Output "$(git push)"', 'git.push'],
  // What follows a keyword or a negation runs; a program path is not an expression.
  ['for f in *.ts; do rm -rf $f; done', 'fs.destructive'],
  ['if [ -f x ]; then rm -rf y; fi', 'fs.destructive'],
  ['! rm -rf build', 'fs.destructive'],
  ['./deploy.sh', 'unknown'],
  ['/bin/rm -rf build', 'fs.destructive'],
  ['./deploy.sh $(cat version.txt)', 'unknown'],
  ["git -c alias.x='!rm -rf y' x", 'unknown'],
  ['git -C ../other push', 'git.push'],
];

describe('commands as Codex sends them on Windows', () => {
  it.each(READS)('a read passes: %s', (c) => {
    expect(classifyCommand(wrap(c))).toMatchObject({ class: 'read.local', autonomy: 'auto' });
  });
  it.each(TESTS)('a test run passes: %s', (c) => {
    expect(classifyCommand(wrap(c))).toMatchObject({ class: 'test.local', autonomy: 'auto' });
  });
  it('a read and a test run together pass', () => {
    expect(classifyCommand(wrap('Set-Location backend; node --test')).autonomy).toBe('auto');
  });
  it.each(GIT_READS)('a git read passes: %s', (c) => {
    expect(classifyCommand(wrap(c))).toMatchObject({ class: 'git.read', autonomy: 'auto' });
  });
  it.each(NOT_ALLOWED)('is not allowed on its own: %s', (c, cls) => {
    const r = classifyCommand(wrap(c));
    expect(r.autonomy).not.toBe('auto');
    // The part that matters was recognised for what it is (the decision takes the strictest part).
    if (cls) expect(r.segments.map((s) => s.class)).toContain(cls);
  });
});

/**
 * Review M8-R01: a value PowerShell only prints runs nothing, so the classifier left it out; when
 * nothing else was left, the command passed as a read before its redirection was looked at, and
 * `'x' > outside.txt` wrote a file outside the task's scope without a human's decision.
 */
const PRINTED_WRITES = [
  "'review redirection' > outside.txt",
  '"a printed line" > out.txt',
  "'a b' >> out.txt",
  "'a b' 2> err.txt",
  "'a b' *> all.txt",
  '$x > out.txt',
  '$x = 1; $x > out.txt',
  '$true > out.txt',
  '(Get-Content a.txt) > b.txt',
  "if ($true) { 'a b' > out.txt }",
  'Write-Output "$(\'a b\' > out.txt)"',
  // Found while fixing it: a numbered stream, and a quoted target, were not seen as writes either.
  'Get-Content a.txt 2> err.txt',
  "Get-Content a.txt > 'out file.txt'",
];
const PRINTED_ONLY = [
  "'--- done'",
  "'a b' > $null",
  "'a b' 2>$null",
  "'a b' *> $null",
  "'a b' | Out-Null",
  '"a -> b"',
  'Get-Content x.txt 2>&1',
];

describe('what a printed value is redirected into (review M8-R01)', () => {
  it.each(PRINTED_WRITES)('writes a file, so a human decides: %s', (c) => {
    for (const command of [c, wrap(c)]) expect(classifyCommand(command).autonomy, command).toBe('review');
  });
  it.each(PRINTED_ONLY)('prints or discards, and passes: %s', (c) => {
    for (const command of [c, wrap(c)]) expect(classifyCommand(command).autonomy, command).toBe('auto');
  });
  it('judges the same in the other shells', () => {
    expect(classifyCommand('bash -lc "printf x > out.txt"').autonomy).toBe('review');
    expect(classifyCommand('cmd /c "echo x > out.txt"').autonomy).toBe('review');
    expect(classifyCommand('bash -lc "echo x > /dev/null"').autonomy).toBe('auto');
    expect(classifyCommand('cmd /c "echo x >NUL"').autonomy).toBe('auto');
  });
});
