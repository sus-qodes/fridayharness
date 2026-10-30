import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cartSummary } from '../src/cart-summary.ts';

test('an empty cart says so', () => {
  assert.equal(cartSummary([]), 'Your cart is empty');
});

test('the summary counts the items and prices the total', () => {
  const items = [
    { sku: 'mug', quantity: 2, unitPrice: { amount: 1000, currency: 'EUR' } },
    { sku: 'tea', quantity: 1, unitPrice: { amount: 500, currency: 'EUR' } },
  ];
  assert.equal(cartSummary(items), '3 items, 25.00 EUR');
  assert.equal(cartSummary([{ sku: 'pen', quantity: 1, unitPrice: { amount: 99, currency: 'USD' } }]), '1 item, 0.99 USD');
});
