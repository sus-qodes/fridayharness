// The hidden checks of OpenCode checkpoint E (plan M14.5): run on each way's final code after the
// run, with OPENCODE_E_TREE naming its folder; no session sees this file. Each check names its task
// and loads what it needs on its own, so a missing file fails only that task's checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.OPENCODE_E_TREE;
if (!root) throw new Error('OPENCODE_E_TREE must name the folder to judge');
const here = path.dirname(fileURLToPath(import.meta.url));
const load = (rel) => import(pathToFileURL(path.join(root, rel)).href);
const text = (file) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const money = (amount, currency) => ({ amount, currency });

test('add-function: an order under 50.00 pays 4.95 in its currency', async () => {
  const { shippingCost } = await load('backend/src/shipping.ts');
  assert.deepEqual(shippingCost(money(4999, 'EUR')), money(495, 'EUR'));
  assert.deepEqual(shippingCost(money(100, 'USD')), money(495, 'USD'));
});

test('add-function: an order of 50.00 or more ships free in its currency', async () => {
  const { shippingCost } = await load('backend/src/shipping.ts');
  assert.deepEqual(shippingCost(money(5000, 'EUR')), money(0, 'EUR'));
  assert.deepEqual(shippingCost(money(12000, 'GBP')), money(0, 'GBP'));
});

test('fix-bug: the existing test is kept', () => {
  const now = text(path.join(root, 'frontend/test/percent.test.ts'));
  assert.ok(now.includes("test('whole percentages'"), 'the test "whole percentages" is gone');
  assert.ok(text(path.join(here, 'shop', 'frontend/test/percent.test.ts')).includes("test('whole percentages'"));
});

test('fix-bug: the label has at most one decimal', async () => {
  const { percentLabel } = await load('frontend/src/percent.ts');
  assert.equal(percentLabel(0.125), '12.5%');
  assert.equal(percentLabel(0.333), '33.3%');
  assert.equal(percentLabel(0.1), '10%');
  assert.equal(percentLabel(0.0004), '0%');
});

test('edit-existing: an unsupported currency is refused with its code', async () => {
  const { totalOf, CheckoutError } = await load('backend/src/checkout.service.ts');
  assert.throws(
    () => totalOf({ items: [{ sku: 'a', quantity: 1, unitPrice: money(100, 'CHF') }] }),
    (e) => e instanceof CheckoutError && e.message === 'unsupported currency CHF',
  );
});

test('edit-existing: the supported currencies still total', async () => {
  const { totalOf } = await load('backend/src/checkout.service.ts');
  for (const c of ['EUR', 'USD', 'GBP'])
    assert.deepEqual(totalOf({ items: [{ sku: 'a', quantity: 2, unitPrice: money(150, c) }] }), money(300, c));
});

test('edit-existing: the existing tests are kept', () => {
  const now = text(path.join(root, 'backend/test/checkout.service.test.ts'));
  for (const name of ['totals multiply unit price by quantity', 'mixed currencies are rejected with 400'])
    assert.ok(now.includes(`test('${name}'`), `the test "${name}" is gone`);
});
