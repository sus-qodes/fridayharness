import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseConfig, renderInitialConfig } from './config.js';
import {
  type CheckToAdd,
  editChecksText,
  packageManagerOf,
  setCheckLimitText,
  setCheckRequiredText,
  suggestChecks,
} from './project-checks.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'friday-checks-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const pkg = (scripts: Record<string, string>, extra: Record<string, unknown> = {}) =>
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'shop', scripts, ...extra }));

describe('the checks a project most likely wants (2026-11-17)', () => {
  it('reads tests, lint, type check and build from package.json, run through npm', () => {
    pkg({ test: 'vitest run', lint: 'eslint .', typecheck: 'tsc --noEmit', build: 'vite build', dev: 'vite' });
    expect(suggestChecks(dir)).toEqual([
      { name: 'tests', kind: 'test', command: 'npm', args: ['run', 'test'], script: 'test', runs: 'vitest run' },
      { name: 'lint', kind: 'lint', command: 'npm', args: ['run', 'lint'], script: 'lint', runs: 'eslint .' },
      {
        name: 'typecheck',
        kind: 'typecheck',
        command: 'npm',
        args: ['run', 'typecheck'],
        script: 'typecheck',
        runs: 'tsc --noEmit',
      },
      { name: 'build', kind: 'build', command: 'npm', args: ['run', 'build'], script: 'build', runs: 'vite build' },
    ]);
  });

  it('uses the package manager of the lockfile, else the one package.json names', () => {
    pkg({ test: 'vitest run' }, { packageManager: 'yarn@4.1.0' });
    expect(packageManagerOf(dir, { packageManager: 'yarn@4.1.0' })).toBe('yarn');
    expect(suggestChecks(dir)[0]).toMatchObject({ command: 'yarn', args: ['run', 'test'] });
    writeFileSync(path.join(dir, 'pnpm-lock.yaml'), '');
    expect(suggestChecks(dir)[0]).toMatchObject({ command: 'pnpm', args: ['run', 'test'] });
    expect(packageManagerOf(dir, { packageManager: 'rm -rf@1' })).toBe('pnpm');
    rmSync(path.join(dir, 'pnpm-lock.yaml'));
    expect(packageManagerOf(dir, { packageManager: 'rm -rf@1' })).toBe('npm');
  });

  it("leaves out npm's placeholder, watchers and scripts that are not text", () => {
    pkg({
      test: 'echo "Error: no test specified" && exit 1',
      lint: 'eslint . --watch',
      'type-check': 'tsc --noEmit',
      build: '   ',
    });
    expect(suggestChecks(dir).map((c) => [c.name, c.script])).toEqual([['typecheck', 'type-check']]);
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 7, lint: null } }));
    expect(suggestChecks(dir)).toEqual([]);
  });

  it('takes the first script of a kind a project has', () => {
    pkg({ 'test:unit': 'vitest run', 'test:ci': 'vitest run --coverage' });
    expect(suggestChecks(dir).map((c) => c.script)).toEqual(['test:unit']);
  });

  it('suggests nothing without a package.json, or with one it cannot read', () => {
    expect(suggestChecks(dir)).toEqual([]);
    writeFileSync(path.join(dir, 'package.json'), '{ not json');
    expect(suggestChecks(dir)).toEqual([]);
    writeFileSync(path.join(dir, 'package.json'), '[]');
    expect(suggestChecks(dir)).toEqual([]);
    mkdirSync(path.join(dir, 'sub'));
    expect(suggestChecks(path.join(dir, 'sub'))).toEqual([]);
  });

  it('reads a package.json that starts with a byte-order mark', () => {
    writeFileSync(path.join(dir, 'package.json'), `\uFEFF${JSON.stringify({ scripts: { test: 'node --test' } })}`);
    expect(suggestChecks(dir).map((c) => c.name)).toEqual(['tests']);
  });
});

const TESTS: CheckToAdd = { name: 'tests', kind: 'test', command: 'npm', args: ['run', 'test'] };
const LINT: CheckToAdd = { name: 'lint', kind: 'lint', command: 'npm', args: ['run', 'lint'] };

/** The least a config.yaml holds. */
const HEAD = ['project:', '  id: proj_00000000000000000000000001', '  name: shop'];
const head = `${HEAD.join('\n')}\n`;

const checksOf = (text: string) => parseConfig(text).verification.checks.map((c) => [c.name, c.command, ...c.args]);

describe("config.yaml with the project's checks changed (2026-11-17)", () => {
  it('adds to the file "friday init" writes by changing only the line of the list', () => {
    const before = renderInitialConfig('proj_00000000000000000000000001', 'shop');
    const r = editChecksText(before, { add: [TESTS, LINT] });
    expect(r.added).toEqual(['tests', 'lint']);
    expect(checksOf(r.text)).toEqual([
      ['tests', 'npm', 'run', 'test'],
      ['lint', 'npm', 'run', 'lint'],
    ]);
    const was = before.split('\n');
    const now = r.text.split('\n');
    // Every line of the file is still there, in order, but `checks: []`.
    expect(was.filter((l) => l !== '  checks: []').every((l) => now.includes(l))).toBe(true);
    expect(now.length).toBe(was.length + 8);
    expect(r.text).toContain(
      ['  checks:', '    - name: tests', '      kind: test', '      command: npm', '      args: ["run", "test"]'].join(
        '\n',
      ),
    );
  });

  it('adds after the checks that are there, keeps theirs as written, and adds no name twice', () => {
    const before = [
      '# the project',
      ...HEAD,
      'verification:',
      '  auto_on_completion: false',
      '  checks:',
      '    - name: unit   # ours',
      '      command: node',
      '      args: ["--test"]',
      '      timeout_ms: 60000',
      '',
      'scopes: {}   # none yet',
      '',
    ].join('\n');
    const r = editChecksText(before, { add: [TESTS, { ...LINT, name: 'unit' }] });
    expect(r.added).toEqual(['tests']);
    expect(r.text).toBe(
      [
        '# the project',
        ...HEAD,
        'verification:',
        '  auto_on_completion: false',
        '  checks:',
        '    - name: unit   # ours',
        '      command: node',
        '      args: ["--test"]',
        '      timeout_ms: 60000',
        '    - name: tests',
        '      kind: test',
        '      command: npm',
        '      args: ["run", "test"]',
        '',
        'scopes: {}   # none yet',
        '',
      ].join('\n'),
    );
    expect(editChecksText(r.text, { add: [TESTS] })).toEqual({ text: r.text, added: [], removed: [] });
  });

  it('removes a check by its own lines, and writes the list empty when it was the last', () => {
    const before = [
      ...HEAD,
      'verification:',
      '  checks:',
      '    - name: tests',
      '      kind: test',
      '      command: npm',
      '      args: ["run", "test"]',
      '    # the slow one',
      '    - name: build',
      '      command: npm',
      '      args: ["run", "build"]',
      'scopes: {}',
      '',
    ].join('\n');
    const one = editChecksText(before, { remove: ['tests', 'nope'] });
    expect(one.removed).toEqual(['tests']);
    expect(checksOf(one.text)).toEqual([['build', 'npm', 'run', 'build']]);
    expect(one.text).toContain('scopes: {}');
    const none = editChecksText(one.text, { remove: ['build'] });
    expect(checksOf(none.text)).toEqual([]);
    expect(parseConfig(none.text).scopes).toEqual({});
    // And back again.
    expect(checksOf(editChecksText(none.text, { add: [LINT] }).text)).toEqual([['lint', 'npm', 'run', 'lint']]);
  });

  it('replaces a check in one change: the old one goes, the new one of that name comes', () => {
    const before = `${head}verification:\n  checks:\n    - name: tests\n      command: node\n      args: ["--test"]\n`;
    const r = editChecksText(before, { remove: ['tests'], add: [TESTS] });
    expect(r).toMatchObject({ added: ['tests'], removed: ['tests'] });
    expect(checksOf(r.text)).toEqual([['tests', 'npm', 'run', 'test']]);
  });

  it('adds the section to a file that has none, and handles layouts the small edit does not', () => {
    const bare = editChecksText(head, { add: [TESTS] }).text;
    expect(checksOf(bare)).toEqual([['tests', 'npm', 'run', 'test']]);
    // The lines that were there stay first, as they were.
    expect(bare.startsWith(head)).toBe(true);
    const flow = `${head}verification: { auto_on_completion: false, checks: [] }\nscopes: {}\n`;
    const r = editChecksText(flow, { add: [TESTS] });
    expect(checksOf(r.text)).toEqual([['tests', 'npm', 'run', 'test']]);
    expect(parseConfig(r.text).verification.auto_on_completion).toBe(false);
    const inline = `${head}verification:\n  checks: [{ name: unit, command: node, args: ["--test"] }]\n`;
    expect(checksOf(editChecksText(inline, { add: [TESTS] }).text)).toEqual([
      ['unit', 'node', '--test'],
      ['tests', 'npm', 'run', 'test'],
    ]);
    expect(checksOf(editChecksText(inline, { remove: ['unit'] }).text)).toEqual([]);
  });

  it('keeps the line endings and the byte-order mark of the file', () => {
    const crlfHead = `${HEAD.join('\r\n')}\r\n`;
    const before = `\uFEFF${crlfHead}verification:\r\n  checks: []   # none yet\r\nscopes: {}\r\n`;
    const r = editChecksText(before, { add: [TESTS] });
    expect(r.text.startsWith(`\uFEFF${crlfHead}verification:\r\n  checks: # none yet\r\n    - name: tests\r\n`)).toBe(
      true,
    );
    expect(r.text.replace(/\r\n/g, '')).not.toContain('\n');
    expect(r.text.endsWith('scopes: {}\r\n')).toBe(true);
  });

  it('changes no other setting, whatever the file holds', () => {
    const before = [
      'project: { id: proj_00000000000000000000000001, name: shop }',
      'master_brain:',
      '  provider: none',
      'verification:',
      '  auto_on_completion: true',
      '  checks: []',
      'providers:',
      '  anthropic:',
      '    daily_budget_usd: 3',
      '',
    ].join('\n');
    const after = parseConfig(editChecksText(before, { add: [TESTS, LINT] }).text);
    const was = parseConfig(before);
    expect({ ...after, verification: { ...after.verification, checks: [] } }).toEqual(was);
  });

  it('refuses what the interface does not add, and a file it cannot read', () => {
    const base = `${head}verification:\n  checks: []\n`;
    expect(() => editChecksText(base, { add: [{ ...TESTS, command: 'bash' }] })).toThrow(/npm, pnpm, yarn or bun/);
    expect(() => editChecksText(base, { add: [{ ...TESTS, name: 'a\nb' }] })).toThrow(/not a name a check can have/);
    expect(() => editChecksText(base, { add: [{ ...TESTS, name: '' }] })).toThrow(/not a name/);
    expect(() => editChecksText(base, { add: [{ ...TESTS, args: ['run', 'x\ny'] }] })).toThrow(/arguments/);
    expect(() => editChecksText(base, { add: [{ ...TESTS, args: Array.from({ length: 9 }, () => 'a') }] })).toThrow(
      /arguments/,
    );
    expect(() => editChecksText('verification: [1, 2]\n', { add: [TESTS] })).toThrow(/correct the file by hand/);
    expect(() => editChecksText('a: [1,\n', { add: [TESTS] })).toThrow(/not valid YAML/);
    expect(() => editChecksText('- a\n- b\n', { add: [TESTS] })).toThrow(/correct the file by hand/);
  });
});

describe('a check made required or advisory (2026-11-18)', () => {
  const withTwo = () =>
    editChecksText(renderInitialConfig('proj_01hzzzzzzzzzzzzzzzzzzzzzzz', 'shop'), { add: [TESTS, LINT] }).text;

  it('changes that one check, keeps the others and the comments, and is undone the same way', () => {
    const before = withTwo();
    const advisory = setCheckRequiredText(before, 'lint', false);
    expect(advisory.changed).toBe(true);
    const checks = parseConfig(advisory.text).verification.checks;
    expect(checks.map((c) => [c.name, c.required])).toEqual([
      ['tests', true],
      ['lint', false],
    ]);
    expect(advisory.text).toContain('# Friday project configuration.');
    // Only that one line is added: every other line, comments and their spacing, is as it was.
    const was = before.split('\n');
    const now = advisory.text.split('\n');
    expect(now).toHaveLength(was.length + 1);
    expect(was.every((l) => now.includes(l))).toBe(true);
    expect(now.filter((l) => !was.includes(l))).toEqual(['      required: false']);
    // The same again changes nothing; back to required reads as it did before.
    expect(setCheckRequiredText(advisory.text, 'lint', false)).toEqual({ text: advisory.text, changed: false });
    const back = setCheckRequiredText(advisory.text, 'lint', true);
    expect(parseConfig(back.text).verification.checks).toEqual(parseConfig(before).verification.checks);
  });

  it('refuses a check the file does not have', () => {
    expect(() => setCheckRequiredText(withTwo(), 'nope', false)).toThrow(/no check named "nope"/);
  });
});

// The trial (F8): lint took 116 s of its 120 s while another agent worked; the way out was editing
// config.yaml by hand. A limit is now set from the app, for one check, in whole minutes.
describe('a check’s time limit (2026-11-19)', () => {
  const withTwo = () =>
    editChecksText(renderInitialConfig('proj_01hzzzzzzzzzzzzzzzzzzzzzzz', 'shop'), { add: [TESTS, LINT] }).text;

  it('sets that one check’s limit, keeps every other value and the comments', () => {
    const before = withTwo();
    const set = setCheckLimitText(before, 'lint', 360_000);
    expect(set.changed).toBe(true);
    const checks = parseConfig(set.text).verification.checks;
    expect(checks.map((c) => [c.name, c.timeout_ms])).toEqual([
      ['tests', 120_000],
      ['lint', 360_000],
    ]);
    expect(set.text).toContain('# Friday project configuration.');
    expect(set.text).toContain('timeout_ms: 360000');
    // One line more and nothing else: the comments keep their spacing (the YAML library re-spaced
    // every one of them).
    const was = before.split('\n');
    const now = set.text.split('\n');
    expect(now).toHaveLength(was.length + 1);
    expect(was.every((l) => now.includes(l))).toBe(true);
    // Changed again, the same line changes.
    const again = setCheckLimitText(set.text, 'lint', 600_000);
    expect(again.text).toBe(set.text.replace('timeout_ms: 360000', 'timeout_ms: 600000'));
    // The default, unwritten, is two minutes: setting two minutes writes nothing.
    expect(setCheckLimitText(before, 'tests', 120_000)).toEqual({ text: before, changed: false });
    expect(setCheckLimitText(set.text, 'lint', 360_000)).toEqual({ text: set.text, changed: false });
    const back = setCheckLimitText(set.text, 'lint', 120_000);
    expect(parseConfig(back.text).verification.checks.map((c) => c.timeout_ms)).toEqual([120_000, 120_000]);
  });

  it('keeps a file’s Windows line ends', () => {
    const crlf = withTwo().replace(/\n/g, '\r\n');
    const set = setCheckLimitText(crlf, 'tests', 300_000);
    expect(set.text.includes('\n') && !/[^\r]\n/.test(set.text)).toBe(true);
    expect(parseConfig(set.text).verification.checks[0]?.timeout_ms).toBe(300_000);
  });

  it('refuses what is not whole minutes from 1 to 60, and a check the file does not have', () => {
    for (const bad of [0, 30_000, 90_000, 3_660_000, 1.5, Number.NaN]) {
      expect(() => setCheckLimitText(withTwo(), 'lint', bad)).toThrow(/whole number of minutes, from 1 to 60/);
    }
    expect(() => setCheckLimitText(withTwo(), 'nope', 300_000)).toThrow(/no check named "nope"/);
  });
});
