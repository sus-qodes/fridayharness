import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPrice } from '../src/format-price.ts';

test('formats minor units with two decimals', () => {
  assert.equal(formatPrice({ amount: 1250, currency: 'EUR' }), '12.50 EUR');
  assert.equal(formatPrice({ amount: 5, currency: 'USD' }), '0.05 USD');
  assert.equal(formatPrice({ amount: -199, currency: 'EUR' }), '-1.99 EUR');
});
