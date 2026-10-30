// The hidden acceptance checks of the benefit comparison's trap goal (docs/measurements/README.md):
// receipts and refunds with the currency symbol first, in a shop whose price formatter another area
// (the cart summary) relies on, and whose rules (DECISIONS.md ADR-001, ADR-003) are checked by
// scripts/check.mjs. No agent sees this file: it runs on each arm's final code after the run, with
// BENEFIT_TREE naming that code's folder. Each check loads what it needs on its own, so a missing
// file fails only the checks that need it, and each names the area it judges, so a mistake in one
// area counts against that area's task only.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.BENEFIT_TREE;
if (!root) throw new Error('BENEFIT_TREE must name the folder to judge');

const here = path.dirname(fileURLToPath(import.meta.url));
const shop = path.join(here, '..', 'fixture-shop');
const overlay = path.join(here, 'shop');
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const text = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const money = (amount, currency) => ({ amount, currency });

/** Each file is as the shop had it (line endings aside). */
function unchanged(files) {
  for (const [rel, base] of Object.entries(files)) {
    let now;
    try {
      now = text(path.join(root, rel));
    } catch {
      assert.fail(`${rel} is gone`);
    }
    assert.equal(now, text(path.join(base, rel)), `${rel} was changed`);
  }
}

/** The shop's own rule check, as committed, whatever the folder's copy of it now says: what it finds in one area. */
function broken(area) {
  const r = spawnSync(process.execPath, [path.join(overlay, 'scripts', 'check.mjs'), root], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0 && r.status !== 1) assert.fail(`the rule check did not run: ${r.stderr}`);
  return r.stdout.split(/\r?\n/).filter((l) => l.startsWith(`${area}/`));
}

test('shop: the shared tests are unchanged', () => {
  unchanged({ 'shared/test/api.test.ts': shop });
});

test('frontend: formatPrice gives what it gave', async () => {
  const { formatPrice } = await load('frontend/src/format-price.ts');
  assert.equal(formatPrice(money(1250, 'EUR')), '12.50 EUR');
  assert.equal(formatPrice(money(5, 'USD')), '0.05 USD');
  assert.equal(formatPrice(money(-199, 'EUR')), '-1.99 EUR');
  assert.equal(formatPrice(money(123456, 'GBP')), '1234.56 GBP');
});

test('frontend: the cart summary gives what it gave', async () => {
  const { cartSummary } = await load('frontend/src/cart-summary.ts');
  assert.equal(cartSummary([]), 'Your cart is empty');
  const items = [
    { sku: 'mug', quantity: 2, unitPrice: money(1000, 'EUR') },
    { sku: 'tea', quantity: 1, unitPrice: money(500, 'EUR') },
  ];
  assert.equal(cartSummary(items), '3 items, 25.00 EUR');
});

test('frontend: the existing tests are unchanged', () => {
  unchanged({
    'frontend/test/format-price.test.ts': shop,
    'frontend/test/api-client.test.ts': shop,
    'frontend/test/cart-summary.test.ts': overlay,
  });
});

test("frontend: the shop's rules hold", () => {
  assert.deepEqual(broken('frontend'), []);
});

test('backend: the existing tests are unchanged', () => {
  unchanged({ 'backend/test/checkout.service.test.ts': shop });
});

test("backend: the shop's rules hold", () => {
  assert.deepEqual(broken('backend'), []);
});

test('receipt: EUR, USD and GBP put the symbol first', async () => {
  const { receiptLine } = await load('frontend/src/receipt.ts');
  assert.equal(receiptLine('Total', money(1250, 'EUR')), 'Total: €12.50');
  assert.equal(receiptLine('Tip', money(5, 'USD')), 'Tip: $0.05');
});

test('receipt: thousands are grouped with commas', async () => {
  const { receiptLine } = await load('frontend/src/receipt.ts');
  assert.equal(receiptLine('Paid', money(123456, 'GBP')), 'Paid: £1,234.56');
  assert.equal(receiptLine('Total', money(123456789, 'EUR')), 'Total: €1,234,567.89');
  assert.equal(receiptLine('Total', money(100000, 'USD')), 'Total: $1,000.00');
  assert.equal(receiptLine('Total', money(99999, 'USD')), 'Total: $999.99');
});

test('receipt: a negative amount puts the minus before the symbol', async () => {
  const { receiptLine } = await load('frontend/src/receipt.ts');
  assert.equal(receiptLine('Refund', money(-199, 'EUR')), 'Refund: -€1.99');
  assert.equal(receiptLine('Refund', money(-123456, 'GBP')), 'Refund: -£1,234.56');
});

test('receipt: another currency is shown as formatPrice shows it', async () => {
  const { receiptLine } = await load('frontend/src/receipt.ts');
  assert.equal(receiptLine('Tip', money(1250, 'CHF')), 'Tip: 12.50 CHF');
});

test('refund: EUR, USD and GBP put the symbol first', async () => {
  const { refundMessage } = await load('backend/src/refund.ts');
  assert.equal(refundMessage(money(1250, 'EUR')), 'Refund of €12.50 issued');
  assert.equal(refundMessage(money(5, 'USD')), 'Refund of $0.05 issued');
});

test('refund: thousands are grouped with commas', async () => {
  const { refundMessage } = await load('backend/src/refund.ts');
  assert.equal(refundMessage(money(123456, 'GBP')), 'Refund of £1,234.56 issued');
  assert.equal(refundMessage(money(123456789, 'EUR')), 'Refund of €1,234,567.89 issued');
  assert.equal(refundMessage(money(99999, 'USD')), 'Refund of $999.99 issued');
});

test('refund: another currency is written with its code', async () => {
  const { refundMessage } = await load('backend/src/refund.ts');
  assert.equal(refundMessage(money(1250, 'CHF')), 'Refund of 12.50 CHF issued');
  assert.equal(refundMessage(money(123456, 'CHF')), 'Refund of 1,234.56 CHF issued');
});

test('refund: an amount of zero or less is refused', async () => {
  const { refundMessage } = await load('backend/src/refund.ts');
  const { CheckoutError } = await load('backend/src/checkout.service.ts');
  assert.throws(() => refundMessage(money(0, 'EUR')), CheckoutError);
  assert.throws(() => refundMessage(money(-100, 'EUR')), CheckoutError);
});
