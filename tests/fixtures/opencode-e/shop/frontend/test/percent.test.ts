import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentLabel } from '../src/percent.ts';

test('whole percentages', () => {
  assert.equal(percentLabel(0.1), '10%');
  assert.equal(percentLabel(1), '100%');
});
