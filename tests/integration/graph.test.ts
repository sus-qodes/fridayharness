/**
 * The code graph through the daemon and the CLI (plan M4b, ADR-0020).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});

describe('friday graph', () => {
  it('answers what a file imports, who imports it and its tests, and follows edits', async () => {
    const td = await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    };
    write('shared/api.ts', 'export interface Money { amount: number }\n');
    write('web/client.ts', "import type { Money } from '../shared/api.ts';\nexport const f = (m: Money) => m;\n");
    write('server/handler.ts', "import type { Money } from '../shared/api.ts';\nexport const g = (m: Money) => m;\n");
    write('shared/api.test.ts', "import '../shared/api.ts';\n");

    const summary = await cli(['--project', dir, 'graph']);
    expect(summary.code, summary.stderr).toBe(0);
    // Building writes only to .friday/graph/, which git ignores: the version stays put and the
    // same graph is served again instead of being rebuilt on every query.
    const first = JSON.parse((await cli(['--project', dir, '--json', 'graph'])).stdout) as {
      version: string;
      stats: unknown;
    };
    const second = JSON.parse((await cli(['--project', dir, '--json', 'graph'])).stdout) as {
      version: string;
      stats: unknown;
    };
    expect(second).toEqual(first);
    expect(summary.stdout).toMatch(/4 files, 3 exact/);
    expect(summary.stdout).toMatch(/shared\/api\.ts\s+shared\s+server, web/);

    const q = await cli(['--project', dir, '--json', 'graph', 'query', 'shared/api.ts', '--depth', '2']);
    expect(q.code, q.stderr).toBe(0);
    const answer = JSON.parse(q.stdout) as {
      consumers: { from: string }[];
      tests: string[];
      node: { contract?: { areas: string[] } };
    };
    expect(answer.consumers.map((e) => e.from).sort()).toEqual([
      'server/handler.ts',
      'shared/api.test.ts',
      'web/client.ts',
    ]);
    expect(answer.tests).toEqual(['shared/api.test.ts']);
    expect(answer.node.contract).toEqual({ areas: ['server', 'web'] });

    // An uncommitted edit is a new version, and the graph follows it.
    write('web/client.ts', 'export const f = 1;\n');
    const after = JSON.parse((await cli(['--project', dir, '--json', 'graph', 'query', 'shared/api.ts'])).stdout) as {
      consumers: { from: string }[];
    };
    expect(after.consumers.map((e) => e.from).sort()).toEqual(['server/handler.ts', 'shared/api.test.ts']);

    const missing = await cli(['--project', dir, 'graph', 'query', 'README.md']);
    expect(missing.code).toBe(4);
    expect(missing.stderr).toContain('is not in the code graph');
    const reindexed = await cli(['--project', dir, 'graph', 'reindex']);
    expect(reindexed.stdout).toMatch(/4 parsed, 0 from cache/);
    // The graph is operator data: a harness token cannot read it.
    const res = await fetch(`${td.url}${td.operator.projectPath('/graph')}`, {
      headers: { authorization: `Bearer ${td.daemon.tokens.bootstrap}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('friday graph: symbols, blast radius, skeletons and search (ADR-0037 §3)', () => {
  it('answers through the CLI, bounded and labelled', async () => {
    await startTestDaemon(ws(), { git: true });
    const dir = ws().projectDir;
    const write = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    };
    write('package.json', '{"name":"shop","private":true}\n');
    write('shared/package.json', '{"name":"@shop/shared","private":true}\n');
    write(
      'shared/api.ts',
      [
        '/** Money in minor units. */',
        'export interface Money { amount: number }',
        'export function add(a: Money, b: Money): Money {',
        '  return { amount: a.amount + b.amount };',
        '}',
        '',
      ].join('\n'),
    );
    write('web/package.json', '{"name":"@shop/web","private":true}\n');
    write(
      'web/client.ts',
      [
        "import { add, type Money } from '../shared/api.ts';",
        'export function sum(a: Money, b: Money): Money {',
        '  return add(a, b);',
        '}',
        '',
      ].join('\n'),
    );
    const symbol = await cli(['--project', dir, 'graph', 'symbol', 'add']);
    expect(symbol.code, symbol.stderr).toBe(0);
    expect(symbol.stdout).toContain('shared/api.ts:3-5  function, exported');
    expect(symbol.stdout).toContain('function add(a: Money, b: Money): Money');
    expect(symbol.stdout).toContain('called or used by: web/client.ts#sum:3 (exact)');
    const none = await cli(['--project', dir, 'graph', 'symbol', 'nothing']);
    expect(none.stdout).toContain('No symbol named nothing');

    const blast = await cli(['--project', dir, 'graph', 'blast-radius', '--symbol', 'shared/api.ts#add']);
    expect(blast.code, blast.stderr).toBe(0);
    expect(blast.stdout).toContain(
      'Changed: shared/api.ts (add)  breaking: add is exported and called from web; shared contract of web',
    );
    expect(blast.stdout).toMatch(/1\s+high\s+web\/client\.ts#sum\s+reference/);
    const diff = await cli(['--project', dir, '--json', 'graph', 'blast-radius', '--diff']);
    expect(diff.code, diff.stderr).toBe(0);
    expect((JSON.parse(diff.stdout) as { seeds: { path: string }[] }).seeds.map((s) => s.path)).toEqual([
      'shared/api.ts',
      'web/client.ts',
    ]);

    const skeleton = await cli(['--project', dir, 'graph', 'skeleton', 'shared/api.ts']);
    expect(skeleton.code, skeleton.stderr).toBe(0);
    expect(skeleton.stdout).toContain('shared/api.ts (L1: 5 lines, 2 folded)');
    expect(skeleton.stdout).toContain('    2: export interface Money { amount: number }');
    expect(skeleton.stdout).toContain('    3: export function add(a: Money, b: Money): Money {');
    expect(skeleton.stdout).toContain('      … (2 lines)');

    const search = await cli(['--project', dir, 'graph', 'search', 'money']);
    expect(search.code, search.stderr).toBe(0);
    expect(search.stdout).toMatch(/interface\s+Money\s+shared\/api\.ts:2/);
  }, 120_000);
});
