// The hidden acceptance checks of the benefit comparison (docs/measurements/README.md). No agent sees
// this file: it is run on each arm's final code after the run, with BENEFIT_TREE naming that code's
// folder, and judges every arm the same way. Each check loads what it needs on its own, so a missing
// file fails only the checks that need it.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

const root = process.env.BENEFIT_TREE;
if (!root) throw new Error('BENEFIT_TREE must name the folder to judge');

const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const api = () => readFileSync(path.join(root, 'shared', 'src', 'api.ts'), 'utf8').replace(/\r\n/g, '\n');
/** The body of an exported interface of the contract, or '' when it is not there. */
const body = (name) => new RegExp(`interface ${name}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(api())?.[1] ?? '';
const eur = (amount) => ({ amount, currency: 'EUR' });

test('contract: the existing fields are kept', () => {
  assert.match(body('CheckoutRequest'), /\bitems\s*:\s*CheckoutItem\[\]/);
  assert.match(body('CheckoutResponse'), /\borderId\s*:\s*string/);
  assert.match(body('CheckoutResponse'), /\btotal\s*:\s*Money/);
});

test('frontend: the contract carries the gift card and the amount applied', () => {
  assert.match(body('CheckoutRequest'), /\bgiftCard\?\s*:\s*\{\s*code\s*:\s*string;?\s*\}/);
  assert.match(body('CheckoutResponse'), /\bgiftCardApplied\?\s*:\s*Money\b/);
});

test('frontend: no gift card gives no line', async () => {
  const { giftCardLine } = await load('frontend/src/gift-card.ts');
  assert.equal(giftCardLine(undefined), null);
});

test('frontend: an amount of 0 gives no line', async () => {
  const { giftCardLine } = await load('frontend/src/gift-card.ts');
  assert.equal(giftCardLine(eur(0)), null);
});

test('frontend: an amount gives the formatted line', async () => {
  const { giftCardLine } = await load('frontend/src/gift-card.ts');
  assert.equal(giftCardLine(eur(1250)), 'Gift card: -12.50 EUR');
  assert.equal(giftCardLine({ amount: 5, currency: 'USD' }), 'Gift card: -0.05 USD');
});

test('backend: the contract carries the discount code', () => {
  assert.match(body('CheckoutRequest'), /\bdiscountCode\?\s*:\s*string\b/);
});

test('backend: SAVE10 takes 10% off', async () => {
  const { applyDiscount } = await load('backend/src/discount.ts');
  assert.deepEqual(applyDiscount(eur(1000), 'SAVE10'), eur(900));
});

test('backend: codes match without regard to case', async () => {
  const { applyDiscount } = await load('backend/src/discount.ts');
  assert.deepEqual(applyDiscount(eur(1000), 'save10'), eur(900));
  assert.deepEqual(applyDiscount(eur(2000), 'Half'), eur(1000));
});

test('backend: the discount is rounded down to a whole minor unit', async () => {
  const { applyDiscount } = await load('backend/src/discount.ts');
  assert.deepEqual(applyDiscount(eur(999), 'HALF'), eur(500));
  assert.deepEqual(applyDiscount({ amount: 1999, currency: 'USD' }, 'SAVE10'), { amount: 1800, currency: 'USD' });
});

test('backend: an unknown, empty or missing code changes nothing', async () => {
  const { applyDiscount } = await load('backend/src/discount.ts');
  assert.deepEqual(applyDiscount(eur(1000), 'NOPE'), eur(1000));
  assert.deepEqual(applyDiscount(eur(1000), ''), eur(1000));
  assert.deepEqual(applyDiscount(eur(1000), undefined), eur(1000));
});
