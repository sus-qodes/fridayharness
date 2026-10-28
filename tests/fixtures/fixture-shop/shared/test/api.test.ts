import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isMoney } from '../src/api.ts';

test('isMoney accepts integer minor units with an ISO-4217 code', () => {
  assert.equal(isMoney({ amount: 1250, currency: 'EUR' }), true);
});

test('isMoney rejects floats and bad currency codes', () => {
  assert.equal(isMoney({ amount: 12.5, currency: 'EUR' }), false);
  assert.equal(isMoney({ amount: 100, currency: 'euro' }), false);
  assert.equal(isMoney(null), false);
});
