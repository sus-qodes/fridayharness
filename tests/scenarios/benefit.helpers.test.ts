/**
 * The benefit comparison's grader and prompts, offline (no host): the hidden checks fail on the
 * untouched fixture and pass on a correct solution, lost work in the shared contract is caught, the
 * plan is one Friday accepts, and a session's figures are read from its stream-json lines as the
 * token baseline reads them. The trap goal (plan M14.3): its shop passes its own tests and rules, a
 * correct solution passes every hidden check, and each obvious mistake fails its own area's task.
 */
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { materializeFixtureShop } from '@friday/cli';
import { consolidatePlan, validatePlanDraft } from '@friday/planner';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import {
  BENEFIT_GOALS,
  judgeTree,
  loadBenefitPlan,
  oneTaskPlan,
  parseTap,
  plainOnePrompt,
  plainTwoPrompt,
  sessionFigures,
  TASK_CHECKS,
} from '../helpers/benefit.js';
import { REPO_ROOT } from '../helpers/cli.js';
import { loadBaselinePlan, type TraceLine } from '../helpers/token-baseline.js';

const ws = useTestWorkspace();

function shop(name: string): string {
  const dir = path.join(ws().root, name);
  cpSync(path.join(REPO_ROOT, 'tests', 'fixtures', 'fixture-shop'), dir, { recursive: true });
  return dir;
}

const GIFT_CARD = `import type { Money } from '../../shared/src/api.ts';
import { formatPrice } from './format-price.ts';

export function giftCardLine(applied: Money | undefined): string | null {
  if (!applied || applied.amount === 0) return null;
  return \`Gift card: -\${formatPrice(applied)}\`;
}
`;

const DISCOUNT = `import type { Money } from '../../shared/src/api.ts';

const CODES: Record<string, number> = { SAVE10: 10, HALF: 50 };

export function applyDiscount(total: Money, code: string | undefined): Money {
  const percent = code ? CODES[code.toUpperCase()] : undefined;
  if (!percent) return { ...total };
  const discount = Math.floor((total.amount * percent) / 100);
  return { amount: total.amount - discount, currency: total.currency };
}
`;

function contract(dir: string, fields: { giftCard: boolean; discount: boolean }) {
  const file = path.join(dir, 'shared', 'src', 'api.ts');
  let text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const request = [
    '  items: CheckoutItem[];',
    ...(fields.giftCard ? ['  /** The gift card paying part of the order. */', '  giftCard?: { code: string };'] : []),
    ...(fields.discount ? ['  /** A discount code. */', '  discountCode?: string;'] : []),
  ].join('\n');
  text = text.replace('  items: CheckoutItem[];', request);
  if (fields.giftCard) {
    text = text.replace(
      '  total: Money;\n}',
      '  total: Money;\n  /** What the gift card paid. */\n  giftCardApplied?: Money;\n}',
    );
  }
  writeFileSync(file, text);
}

describe('the benefit comparison, offline', () => {
  it('has a plan Friday accepts: two tasks on the shared contract, the backend after the frontend', () => {
    const plan = loadBenefitPlan();
    expect(plan.tasks.map((t) => t.key)).toEqual(['giftcard-frontend', 'discount-backend']);
    expect(plan.tasks[1]?.depends_on).toEqual(['giftcard-frontend']);
    const v = validatePlanDraft(plan);
    expect(v.errors).toEqual([]);
  });

  it('merges into one task for the friday-one arm, and keeps the baseline two parallel tasks apart (plan M13.1)', () => {
    const { plan, merged } = oneTaskPlan(loadBenefitPlan());
    expect(merged).toEqual(['giftcard-frontend', 'discount-backend']);
    expect(plan.tasks).toHaveLength(1);
    expect(validatePlanDraft(plan).errors).toEqual([]);
    // The one task carries both tasks' text, criteria and scopes, so it asks for the same work.
    for (const t of loadBenefitPlan().tasks) {
      expect(plan.tasks[0]?.description).toContain(t.description);
      for (const c of t.acceptance_criteria) expect(plan.tasks[0]?.acceptance_criteria).toContain(c);
    }
    expect(plan.tasks[0]?.scope.write).toEqual(['shared/src/api.ts', 'frontend/**', 'backend/**']);
    expect(consolidatePlan(loadBaselinePlan()).merged).toBeNull();
  });

  it('gives every arm the same task text', () => {
    const plan = loadBenefitPlan();
    const one = plainOnePrompt(plan);
    for (const t of plan.tasks) {
      expect(one).toContain(t.description as string);
      expect(plainTwoPrompt(plan, t.key)).toContain(t.description as string);
    }
    expect(plainTwoPrompt(plan, 'giftcard-frontend')).toContain(
      'Another developer works at the same time in this same folder',
    );
  });

  it('fails every task check on the untouched fixture, where the project tests still pass', () => {
    const v = judgeTree(shop('untouched'));
    expect(v.project.passed).toBe(true);
    expect(v.checks['contract: the existing fields are kept']).toBe(true);
    const others = Object.entries(v.checks).filter(([n]) => n !== 'contract: the existing fields are kept');
    expect(others.length).toBe(9);
    expect(others.every(([, ok]) => ok === false)).toBe(true);
    expect(v.tasks).toEqual({ 'giftcard-frontend': false, 'discount-backend': false });
  });

  it('passes every check on a correct solution', () => {
    const dir = shop('solved');
    contract(dir, { giftCard: true, discount: true });
    writeFileSync(path.join(dir, 'frontend', 'src', 'gift-card.ts'), GIFT_CARD);
    writeFileSync(path.join(dir, 'backend', 'src', 'discount.ts'), DISCOUNT);
    const v = judgeTree(dir);
    expect(v.project.passed).toBe(true);
    expect(Object.keys(v.checks).sort()).toEqual([...new Set(Object.values(TASK_CHECKS).flat())].sort());
    expect(Object.values(v.checks).every(Boolean)).toBe(true);
    expect(v.tasks).toEqual({ 'giftcard-frontend': true, 'discount-backend': true });
  });

  it('catches work lost in the shared contract, and a broken project test', () => {
    // The backend's change overwrote the frontend's fields: the frontend task is lost.
    const lost = shop('lost');
    contract(lost, { giftCard: false, discount: true });
    writeFileSync(path.join(lost, 'frontend', 'src', 'gift-card.ts'), GIFT_CARD);
    writeFileSync(path.join(lost, 'backend', 'src', 'discount.ts'), DISCOUNT);
    expect(judgeTree(lost).tasks).toEqual({ 'giftcard-frontend': false, 'discount-backend': true });
    // A failing test of the project fails every task, whatever the hidden checks say.
    const broken = shop('broken');
    contract(broken, { giftCard: true, discount: true });
    writeFileSync(path.join(broken, 'frontend', 'src', 'gift-card.ts'), GIFT_CARD);
    writeFileSync(path.join(broken, 'backend', 'src', 'discount.ts'), DISCOUNT);
    writeFileSync(
      path.join(broken, 'backend', 'test', 'broken.test.ts'),
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\ntest('x', () => assert.equal(1, 2));\n",
    );
    const v = judgeTree(broken);
    expect(v.project).toMatchObject({ passed: false, fail: 1 });
    expect(v.tasks).toEqual({ 'giftcard-frontend': false, 'discount-backend': false });
  });

  it('reads the top-level results of a tap report', () => {
    expect(
      parseTap('TAP version 13\n# Subtest: a\nok 1 - a\nnot ok 2 - b c\n  ok 1 - nested\nok 3 - d # SKIP\n'),
    ).toEqual({
      a: true,
      'b c': false,
      d: true,
    });
  });

  it("counts a session's calls, tokens, claim and tool errors from its stream-json lines", () => {
    const usage = { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 16000, output_tokens: 5 };
    const usage2 = {
      input_tokens: 2,
      cache_read_input_tokens: 16000,
      cache_creation_input_tokens: 900,
      output_tokens: 9,
    };
    const r = (msg: Record<string, unknown>): TraceLine => ({ t: 0, dir: 'receive', msg });
    const lines: TraceLine[] = [
      { t: 0, dir: 'send', msg: { type: 'user', message: { content: 'go' } } },
      r({ type: 'assistant', message: { usage, content: [{ type: 'thinking' }] } }),
      r({ type: 'assistant', message: { usage, content: [{ type: 'tool_use', id: 't1', name: 'Edit' }] } }),
      r({
        type: 'user',
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'File has been modified since read' },
          ],
        },
      }),
      r({
        type: 'assistant',
        message: { usage: usage2, content: [{ type: 'tool_use', id: 't2', name: 'StructuredOutput' }] },
      }),
      r({
        type: 'result',
        usage: {
          input_tokens: 4,
          cache_read_input_tokens: 16000,
          cache_creation_input_tokens: 16900,
          output_tokens: 14,
        },
        total_cost_usd: 0.003,
        duration_ms: 12_340,
        structured_output: { status: 'completed', summary: 's', changed_paths: [], blocked_reason: '' },
      }),
    ];
    expect(sessionFigures(lines)).toEqual({
      calls: 2,
      input: 4,
      output: 14,
      cache_read: 16000,
      cache_write: 16900,
      input_side: 32904,
      cost_usd: 0.003,
      claimed: 'completed',
      tool_calls: 2,
      tool_errors: ['Edit: File has been modified since read'],
      seconds: 12.3,
    });
  });
});

const TRAP = BENEFIT_GOALS.trap;

/** The digits of an amount, from its integer minor units, thousands grouped with commas. */
const DIGITS = `\`\${group(Math.floor(abs / 100))}.\${String(abs % 100).padStart(2, '0')}\``;
const GROUP = "const group = (n: number) => String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');";

const RECEIPT = `import type { Money } from '../../shared/src/api.ts';
import { formatPrice } from './format-price.ts';

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
${GROUP}

export function receiptLine(label: string, money: Money): string {
  const symbol = SYMBOLS[money.currency];
  if (!symbol) return \`\${label}: \${formatPrice(money)}\`;
  const abs = Math.abs(money.amount);
  const digits = ${DIGITS};
  return \`\${label}: \${money.amount < 0 ? '-' : ''}\${symbol}\${digits}\`;
}
`;

const REFUND = `import type { Money } from '../../shared/src/api.ts';
import { CheckoutError } from './checkout.service.ts';

const SYMBOLS: Record<string, string> = { EUR: '€', USD: '$', GBP: '£' };
${GROUP}

export function refundMessage(amount: Money): string {
  if (amount.amount <= 0) throw new CheckoutError('a refund must be more than zero');
  const abs = amount.amount;
  const digits = ${DIGITS};
  const symbol = SYMBOLS[amount.currency];
  return \`Refund of \${symbol ? symbol + digits : \`\${digits} \${amount.currency}\`} issued\`;
}
`;

describe('the trap goal, offline (plan M14.3)', () => {
  /** A copy of the trap shop, prepared once per test: the fixture with the cart summary, the rules and their check. */
  const trapShop = async (name: string) => {
    const prepared = path.join(ws().root, 'trap-prepared');
    if (!existsSync(prepared)) {
      materializeFixtureShop(prepared);
      await TRAP.prepare?.(prepared);
    }
    const dir = path.join(ws().root, name);
    cpSync(prepared, dir, { recursive: true });
    return dir;
  };
  const put = (dir: string, rel: string, text: string) => writeFileSync(path.join(dir, ...rel.split('/')), text);
  const failed = (v: ReturnType<typeof judgeTree>) =>
    Object.entries(v.checks)
      .filter(([, ok]) => !ok)
      .map(([n]) => n)
      .sort();

  it('has a plan Friday accepts: two independent tasks, each scoped to the two files it adds', () => {
    const plan = loadBenefitPlan(TRAP.planFile);
    expect(plan.tasks.map((t) => t.key)).toEqual(['receipt-frontend', 'refund-backend']);
    expect(plan.tasks.map((t) => t.depends_on ?? [])).toEqual([[], []]);
    expect(plan.tasks.map((t) => t.scope.write)).toEqual([
      ['frontend/src/receipt.ts', 'frontend/test/receipt.test.ts'],
      ['backend/src/refund.ts', 'backend/test/refund.test.ts'],
    ]);
    expect(validatePlanDraft(plan).errors).toEqual([]);
    expect(consolidatePlan(plan).merged).toBeFalsy();
    expect(TRAP.agents.map((a) => a.task)).toEqual(plan.tasks.map((t) => t.key));
    // No task text names the rules or their check: they are in the shop's decisions and its own script.
    for (const t of plan.tasks) expect(t.description).not.toMatch(/check\.mjs|ADR-003|toFixed/);
  });

  it("prepares a shop whose tests and rules pass, with the rule check in Friday's verification", async () => {
    const dir = await trapShop('trap-untouched');
    expect(readFileSync(path.join(dir, 'DECISIONS.md'), 'utf8')).toContain('## ADR-003');
    expect(JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts.check).toBe(
      'node scripts/check.mjs',
    );
    expect(readFileSync(path.join(dir, '.friday', 'config.yaml'), 'utf8')).toContain(
      ['    - name: rules', '      kind: lint', '      command: node', '      args: ["scripts/check.mjs"]'].join('\n'),
    );
    const v = judgeTree(dir, TRAP);
    expect(v.project.passed).toBe(true);
    expect(Object.keys(v.checks).sort()).toEqual([...new Set(Object.values(TRAP.taskChecks).flat())].sort());
    // Only what the tasks must add is missing.
    expect(failed(v)).toHaveLength(8);
    expect(failed(v).every((n) => n.startsWith('receipt:') || n.startsWith('refund:'))).toBe(true);
    expect(v.tasks).toEqual({ 'receipt-frontend': false, 'refund-backend': false });
  }, 120_000);

  it('passes every check on a correct solution', async () => {
    const dir = await trapShop('trap-right');
    put(dir, 'frontend/src/receipt.ts', RECEIPT);
    put(dir, 'backend/src/refund.ts', REFUND);
    const v = judgeTree(dir, TRAP);
    expect(failed(v)).toEqual([]);
    expect(v.tasks).toEqual({ 'receipt-frontend': true, 'refund-backend': true });
  }, 120_000);

  it('fails each obvious mistake in its own area only', async () => {
    // Floating point on money: the tests do not see it, the shop's rules forbid it.
    const float = await trapShop('trap-float');
    put(
      float,
      'frontend/src/receipt.ts',
      RECEIPT.replace(DIGITS, "(abs / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })"),
    );
    put(float, 'backend/src/refund.ts', REFUND);
    const f = judgeTree(float, TRAP);
    expect(f.project.passed).toBe(true);
    expect(failed(f)).toEqual(["frontend: the shop's rules hold"]);
    expect(f.tasks).toEqual({ 'receipt-frontend': false, 'refund-backend': true });

    // The backend reaching into the frontend's code, whatever it does with it.
    const reach = await trapShop('trap-reach');
    put(reach, 'frontend/src/receipt.ts', RECEIPT);
    put(
      reach,
      'backend/src/refund.ts',
      `${REFUND.replace(
        "import { CheckoutError } from './checkout.service.ts';",
        "import { formatPrice } from '../../frontend/src/format-price.ts';\nimport { CheckoutError } from './checkout.service.ts';",
      )}\nexport const price = formatPrice;\n`,
    );
    const r = judgeTree(reach, TRAP);
    expect(failed(r)).toEqual(["backend: the shop's rules hold"]);
    expect(r.tasks).toEqual({ 'receipt-frontend': true, 'refund-backend': false });

    // The shared formatter changed for the receipt, and its own test edited to match: the cart summary breaks.
    const shared = await trapShop('trap-shared');
    put(shared, 'frontend/src/receipt.ts', RECEIPT);
    put(shared, 'backend/src/refund.ts', REFUND);
    const fp = path.join(shared, 'frontend', 'src', 'format-price.ts');
    writeFileSync(
      fp,
      readFileSync(fp, 'utf8').replace(
        `return \`\${sign}\${major}.\${minor} \${money.currency}\`;`,
        `return money.currency === 'EUR' ? \`\${sign}€\${major}.\${minor}\` : \`\${sign}\${major}.\${minor} \${money.currency}\`;`,
      ),
    );
    const fpt = path.join(shared, 'frontend', 'test', 'format-price.test.ts');
    writeFileSync(fpt, readFileSync(fpt, 'utf8').replace("'12.50 EUR'", "'€12.50'").replace("'-1.99 EUR'", "'-€1.99'"));
    const c = judgeTree(shared, TRAP);
    expect(c.project.passed).toBe(false);
    expect(failed(c)).toEqual([
      'frontend: formatPrice gives what it gave',
      'frontend: the cart summary gives what it gave',
      'frontend: the existing tests are unchanged',
    ]);
    expect(c.tasks).toEqual({ 'receipt-frontend': false, 'refund-backend': false });
  }, 240_000);
});
