/**
 * Friday's own verification checks (plan M5b, ADR-0024 §3–§5).
 */
import { describe, expect, it } from 'vitest';
import {
  ALLOW_SECRET_MARKER,
  analyzeDiff,
  type DiffInput,
  ownChanges,
  relatedTests,
  scanCredentials,
  selectChecks,
} from './index.js';

const base = (over: Partial<DiffInput>): DiffInput => ({
  changed: [],
  write: ['src/**'],
  claimed: null,
  shared: false,
  inScope: (p) => p.startsWith('src/'),
  protectedClass: (p) =>
    p.startsWith('.claude/') ? 'host.config' : p.startsWith('.friday/run/') ? 'friday.runtime' : null,
  expectsChanges: true,
  ...over,
});
const rules = (input: DiffInput) => analyzeDiff(input).map((f) => [f.rule, f.severity, f.paths]);

describe('diff analysis', () => {
  it('fails changes outside the write scope and to protected files, once each', () => {
    const findings = rules(
      base({
        changed: [
          { path: 'src/a.ts', change: 'modified' },
          { path: 'infra/deploy.json', change: 'modified' },
          { path: '.claude/settings.json', change: 'modified' },
          { path: 'src/moved.ts', change: 'renamed', origPath: 'lib/old.ts' },
        ],
      }),
    );
    expect(findings).toEqual([
      ['diff.protected', 'fail', ['.claude/settings.json']],
      ['diff.outside_scope', 'fail', ['infra/deploy.json', 'lib/old.ts']],
    ]);
  });

  it('compares the claim with what changed', () => {
    const input = base({
      changed: [
        { path: 'src/a.ts', change: 'modified' },
        { path: 'src/b.ts', change: 'added' },
      ],
      claimed: ['SRC/A.ts', 'src/c.ts'],
      caseInsensitive: true,
    });
    expect(rules(input)).toEqual([
      ['diff.unclaimed', 'warn', ['src/b.ts']],
      ['diff.claimed_unchanged', 'warn', ['src/c.ts']],
    ]);
  });

  it('in the shared main checkout, judges only what the session was seen changing or claimed', () => {
    const changed = [
      { path: '.mcp.json', change: 'modified' as const },
      { path: 'infra/deploy.json', change: 'modified' as const },
      { path: 'src/a.ts', change: 'modified' as const },
      { path: 'src/b.ts', change: 'added' as const },
    ];
    // Others' work (here Friday's own harness file and an infra edit) is listed, not judged.
    const theirs = analyzeDiff(
      base({ shared: true, changed, observed: ['src/a.ts', 'src/b.ts'], claimed: ['src/a.ts'] }),
    );
    expect(theirs.map((f) => [f.rule, f.severity, f.paths])).toEqual([
      ['diff.unclaimed', 'warn', ['src/b.ts']],
      ['diff.unattributed', 'info', ['.mcp.json', 'infra/deploy.json']],
    ]);
    expect(
      ownChanges({ changed, shared: true, observed: ['SRC/A.TS'], claimed: null, caseInsensitive: true }).own,
    ).toEqual([changed[2]]);
    // What the session was seen changing is its own, and fails like anywhere else.
    const mine = analyzeDiff(base({ shared: true, changed, observed: ['infra/deploy.json'], claimed: ['src/a.ts'] }));
    expect(mine.map((f) => [f.rule, f.severity, f.paths])).toEqual([
      ['diff.outside_scope', 'fail', ['infra/deploy.json']],
      ['diff.unclaimed', 'warn', ['infra/deploy.json']],
      ['diff.unattributed', 'info', ['.mcp.json', 'src/b.ts']],
    ]);
  });

  it('treats a task without a write scope as read-only, and notices work that changed nothing', () => {
    expect(rules(base({ write: null, changed: [{ path: 'src/a.ts', change: 'modified' }] }))).toEqual([
      ['diff.read_only', 'fail', ['src/a.ts']],
    ]);
    expect(rules(base({ changed: [] }))).toEqual([['diff.empty', 'warn', []]]);
    expect(rules(base({ changed: [], expectsChanges: false }))).toEqual([]);
  });

  it('lists at most twenty paths and says how many more', () => {
    const changed = Array.from({ length: 25 }, (_, i) => ({
      path: `docs/${String(i).padStart(2, '0')}.md`,
      change: 'added' as const,
    }));
    const [f] = analyzeDiff(base({ changed }));
    expect(f?.paths).toHaveLength(20);
    expect(f?.message).toContain('(and 5 more)');
  });
});

describe('checks by task kind', () => {
  it('runs a check for the kinds it lists, and every check that lists none', () => {
    const checks = [
      { name: 'tests', task_kinds: ['implementation'] },
      { name: 'lint' },
      { name: 'links', task_kinds: ['docs'] },
    ];
    expect(selectChecks(checks, 'implementation').map((c) => c.name)).toEqual(['tests', 'lint']);
    expect(selectChecks(checks, 'docs').map((c) => c.name)).toEqual(['lint', 'links']);
    expect(selectChecks(checks, 'research').map((c) => c.name)).toEqual(['lint']);
  });
});

describe('tests related to a change', () => {
  it('collects changed tests and the tests importing changed sources, and lists sources without one', () => {
    const graph = {
      testsOf: (f: string) => (f === 'src/a.ts' ? ['test/a.test.ts', 'test/ab.test.ts'] : []),
      isSource: (f: string) => f.endsWith('.ts'),
      isTest: (f: string) => f.includes('.test.'),
    };
    expect(relatedTests(['src/a.ts', 'src/b.ts', 'test/c.test.ts', 'README.md', 'src/a.ts'], graph)).toEqual({
      tests: ['test/a.test.ts', 'test/ab.test.ts', 'test/c.test.ts'],
      untested: ['src/b.ts'],
    });
  });
});

describe('the credential scan', () => {
  // A stand-in for @friday/events' findCredentials: a line holding "KEY-" holds a credential.
  const find = (text: string) =>
    text.split('\n').flatMap((l, i) => (l.includes('KEY-') ? [{ kind: 'aws_key', line: i + 1 }] : []));

  it('names file and line, never the value, and skips lines marked as allowed', () => {
    const findings = scanCredentials(
      [
        { path: 'src/config.ts', text: 'const a = 1;\nconst key = "KEY-very-secret-value";\n' },
        { path: 'test/fixture.ts', text: `const k = "KEY-documented"; // ${ALLOW_SECRET_MARKER}\n` },
        { path: 'src/clean.ts', text: 'export {};\n' },
      ],
      find,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ rule: 'secrets.found', severity: 'fail', paths: ['src/config.ts'] });
    expect(findings[0]?.message).toContain('src/config.ts:2 (aws_key)');
    expect(findings[0]?.message).not.toContain('very-secret');
    expect(scanCredentials([{ path: 'src/clean.ts', text: 'export {};\n' }], find)).toEqual([]);
  });
});
