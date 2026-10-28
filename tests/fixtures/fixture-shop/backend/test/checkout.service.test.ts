import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleCheckout } from '../src/checkout.controller.ts';
import { totalOf } from '../src/checkout.service.ts';

const eur = (amount: number) => ({ amount, currency: 'EUR' });

test('totals multiply unit price by quantity', () => {
  const total = totalOf({
    items: [
      { sku: 'mug', quantity: 2, unitPrice: eur(850) },
      { sku: 'tee', quantity: 1, unitPrice: eur(1999) },
    ],
  });
  assert.deepEqual(total, eur(3699));
});

test('mixed currencies are rejected with 400', () => {
  const res = handleCheckout({
    items: [
      { sku: 'a', quantity: 1, unitPrice: eur(100) },
      { sku: 'b', quantity: 1, unitPrice: { amount: 100, currency: 'USD' } },
    ],
  });
  assert.equal(res.status, 400);
});
