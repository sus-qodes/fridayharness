/**
 * File reservations in the write policy (plan M5c, ADR-0025 §1).
 */
import { describe, expect, it } from 'vitest';
import { evaluate, type PathContext, type PolicyInput } from './index.js';

const ctx: PathContext = {
  projectRoot: 'C:\\demo\\shop',
  stateDir: 'C:\\Users\\me\\AppData\\Local\\Friday',
  windows: true,
};
const required = ['pnpm-lock.yaml', 'shared/src/api.ts', 'migrations/**'];
const write = (paths: string[], reservations?: PolicyInput['reservations'], scope = ['**']) =>
  evaluate({
    ctx,
    task: { task_id: 'task_a', status: 'RUNNING', scope: { write: scope, read: [] } },
    action: { tool: 'Edit', kind: 'write', paths },
    ...(reservations ? { reservations } : {}),
  });

describe('file reservations', () => {
  it('lets the first writer take a free conflict-prone file, and says which patterns to reserve', () => {
    const res = write(['pnpm-lock.yaml', 'migrations\\0007_add.sql', 'src/a.ts'], { required, held: [] });
    expect(res).toMatchObject({ decision: 'allow', reserve: ['pnpm-lock.yaml', 'migrations/**'] });
    expect(write(['src/a.ts'], { required, held: [] }).reserve).toBeUndefined();
  });

  it('denies a write to what another task holds, naming the holder', () => {
    const held = [{ pattern: 'migrations/**', task_id: 'task_b' }];
    const res = write(['MIGRATIONS/0008_more.sql'], { required, held });
    expect(res).toMatchObject({ decision: 'deny', rule: 'write.reserved', reserved_by: held[0] });
    expect(res.reason).toContain('task_b');
    // A reservation a human placed on any path counts too, required or not.
    expect(write(['docs/guide.md'], { required, held: [{ pattern: 'docs/**', task_id: 'task_c' }] }).rule).toBe(
      'write.reserved',
    );
  });

  it('judges the scope first, and changes nothing without reservations configured', () => {
    const held = [{ pattern: 'pnpm-lock.yaml', task_id: 'task_b' }];
    expect(write(['pnpm-lock.yaml'], { required, held }, ['src/**']).rule).toBe('write.outside_scope');
    expect(write(['pnpm-lock.yaml'])).toMatchObject({ decision: 'allow', rule: 'write.in_scope' });
    expect(write(['pnpm-lock.yaml']).reserve).toBeUndefined();
  });
});
