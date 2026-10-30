/**
 * OpenCode checkpoint E's grader, offline (plan M14.5): on the prepared shop the project's tests pass
 * and only the tasks' work is missing; correct work passes every hidden check, each task judged by
 * its own; a test that was there and is gone is caught.
 */
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { materializeFixtureShop } from '@friday/cli';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { E_TASKS, judgeE, plainPrompt, prepareEShop } from '../helpers/opencode-e.js';

const ws = useTestWorkspace();

const SHIPPING = `import type { Money } from '../../shared/src/api.ts';

export function shippingCost(total: Money): Money {
  return { amount: total.amount >= 5000 ? 0 : 495, currency: total.currency };
}
`;

const REFUSAL = `  if (!['EUR', 'USD', 'GBP'].includes(currency)) throw new CheckoutError(\`unsupported currency \${currency}\`);\n`;

describe('OpenCode checkpoint E, offline (plan M14.5)', () => {
  it('has three task kinds, each scoped to the files it changes', () => {
    expect(E_TASKS.map((t) => t.key)).toEqual(['add-function', 'fix-bug', 'edit-existing']);
    for (const t of E_TASKS) {
      expect(t.scope.write.length).toBeGreaterThan(0);
      expect(plainPrompt(t)).toContain(t.description);
    }
  });

  it('fails only the missing work on the prepared shop, and passes correct work', async () => {
    const prepared = materializeFixtureShop(path.join(ws().root, 'e-prepared')).root;
    await prepareEShop(prepared);
    const before = judgeE(prepared);
    // The project's own tests pass before any task: a verification fails only for a task's own work.
    expect(before.project).toBe(true);
    expect(before.tasks).toEqual({ 'add-function': false, 'fix-bug': false, 'edit-existing': false });
    expect(before.checks['fix-bug: the existing test is kept']).toBe(true);
    expect(before.checks['edit-existing: the existing tests are kept']).toBe(true);

    const done = path.join(ws().root, 'e-done');
    cpSync(prepared, done, { recursive: true });
    writeFileSync(path.join(done, 'backend', 'src', 'shipping.ts'), SHIPPING);
    const percent = path.join(done, 'frontend', 'src', 'percent.ts');
    writeFileSync(
      percent,
      readFileSync(percent, 'utf8').replace('Math.round(fraction * 100)', 'Math.round(fraction * 1000) / 10'),
    );
    const service = path.join(done, 'backend', 'src', 'checkout.service.ts');
    const anchor = "  const currency = request.items[0]?.unitPrice.currency ?? 'EUR';\n";
    writeFileSync(service, readFileSync(service, 'utf8').replace(anchor, anchor + REFUSAL));
    const after = judgeE(done);
    expect(after.project).toBe(true);
    expect(Object.entries(after.checks).filter(([, ok]) => !ok)).toEqual([]);
    expect(after.tasks).toEqual({ 'add-function': true, 'fix-bug': true, 'edit-existing': true });

    // A test that was there and is gone is caught, even when what remains passes.
    const cheat = path.join(ws().root, 'e-cheat');
    cpSync(done, cheat, { recursive: true });
    writeFileSync(
      path.join(cheat, 'frontend', 'test', 'percent.test.ts'),
      "import { test } from 'node:test';\ntest('ok', () => {});\n",
    );
    const c = judgeE(cheat);
    expect(c.checks['fix-bug: the existing test is kept']).toBe(false);
    expect(c.tasks).toEqual({ 'add-function': true, 'fix-bug': false, 'edit-existing': true });
  }, 180_000);
});
