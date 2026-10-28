import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalize, evaluate, evaluateSensitive, type PathContext } from './index.js';

/**
 * Real links on disk (plan B19, review F01): a junction (Windows) or symlink (Linux) inside an
 * allowed scope must not reach out-of-scope files, Friday's runtime files or its private state.
 * Junctions need no administrator rights, so these run on every Windows machine and in CI.
 */
const kind = process.platform === 'win32' ? 'junction' : 'dir';

let base: string;
let root: string;
let state: string;
let ctx: PathContext;

beforeAll(() => {
  base = mkdtempSync(path.join(os.tmpdir(), 'fr-links-'));
  root = path.join(base, 'shop');
  state = path.join(base, 'state');
  for (const d of ['frontend/src', 'backend/src', '.friday/run', 'outside'])
    mkdirSync(path.join(root, d), { recursive: true });
  mkdirSync(path.join(state, 'projects', 'p1'), { recursive: true });
  writeFileSync(path.join(root, 'backend/src/pay.ts'), 'export {};\n');
  writeFileSync(path.join(root, '.friday/run/daemon.json'), '{}\n');
  writeFileSync(path.join(state, 'projects', 'p1', 'operator.token'), 'x'.repeat(40));
  mkdirSync(path.join(base, 'elsewhere'), { recursive: true });
  symlinkSync(path.join(root, 'backend'), path.join(root, 'frontend/to-backend'), kind);
  symlinkSync(path.join(root, '.friday/run'), path.join(root, 'frontend/to-run'), kind);
  symlinkSync(state, path.join(root, 'frontend/to-state'), kind);
  symlinkSync(path.join(base, 'elsewhere'), path.join(root, 'frontend/to-elsewhere'), kind);
  // A dangling link: writing through it would create backend/new-dir.
  symlinkSync(path.join(root, 'backend/new-dir'), path.join(root, 'frontend/dangling'), kind);
  ctx = { projectRoot: root, stateDir: state };
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

const running = { task_id: 'task_1', status: 'RUNNING', scope: { write: ['frontend/**'], read: [] } };

describe('links inside the project (review F01)', () => {
  it('resolves the real target, also for a file that does not exist yet', () => {
    const c = canonicalize('frontend/to-backend/src/new.ts', ctx);
    expect(c.relative).toBe('frontend/to-backend/src/new.ts');
    expect(c.linked).toBe(true);
    expect(c.realRelative).toBe('backend/src/new.ts');
    expect(canonicalize('frontend/dangling/x.ts', ctx).realRelative).toBe('backend/new-dir/x.ts');
    const plain = canonicalize('frontend/src/a.ts', ctx);
    expect(plain.linked).toBe(false);
    expect(plain.realRelative).toBe('frontend/src/a.ts');
  });

  it('denies writes through a link to another scope, for existing and new files', () => {
    for (const p of ['frontend/to-backend/src/pay.ts', 'frontend/to-backend/src/new.ts', 'frontend/dangling/x.ts']) {
      const res = evaluate({ action: { tool: 'Write', kind: 'write', paths: [p] }, ctx, task: running });
      expect(res.decision, p).toBe('deny');
      expect(res.rule, p).toBe('write.outside_scope');
    }
    const ok = evaluate({ action: { tool: 'Write', kind: 'write', paths: ['frontend/src/a.ts'] }, ctx, task: running });
    expect(ok.decision).toBe('allow');
  });

  it('denies writes through a link that leaves the project', () => {
    const res = evaluate({
      action: { tool: 'Edit', kind: 'write', paths: ['frontend/to-elsewhere/x.ts'] },
      ctx,
      task: running,
    });
    expect(res.decision).toBe('deny');
    expect(res.rule).toBe('write.outside_project');
  });

  it('denies reads of runtime files and private state through links, without the daemon', () => {
    // evaluateSensitive is what the hook launcher runs locally when the daemon is down.
    const run = evaluateSensitive({ tool: 'Read', kind: 'read', paths: ['frontend/to-run/daemon.json'] }, ctx);
    expect(run?.sensitive_class).toBe('friday.runtime');
    const priv = evaluateSensitive(
      { tool: 'Read', kind: 'read', paths: ['frontend/to-state/projects/p1/operator.token'] },
      ctx,
    );
    expect(priv?.sensitive_class).toBe('friday.private');
    const dir = evaluateSensitive({ tool: 'Grep', kind: 'search', paths: ['frontend/to-run'], patterns: ['x'] }, ctx);
    expect(dir?.sensitive_class).toBe('friday.runtime');
    expect(evaluateSensitive({ tool: 'Read', kind: 'read', paths: ['frontend/src/a.ts'] }, ctx)).toBeNull();
  });

  it('treats a project root reached through a link like the root itself', () => {
    const alias = path.join(base, 'alias');
    symlinkSync(root, alias, kind);
    const c = canonicalize(path.join(alias, 'frontend/src/a.ts'), { projectRoot: alias, stateDir: state });
    expect(c.relative).toBe('frontend/src/a.ts');
    expect(c.linked).toBe(false);
  });
});
