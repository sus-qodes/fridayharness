import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitCheckout } from '../src/api-client.ts';

test('submitCheckout returns the order on success', async () => {
  const fetcher = async () => ({
    status: 200,
    json: async () => ({ orderId: 'ord_000001', total: { amount: 850, currency: 'EUR' } }),
  });
  const res = await submitCheckout(fetcher, { items: [] });
  assert.equal(res.orderId, 'ord_000001');
});

test('submitCheckout throws on a backend error', async () => {
  const fetcher = async () => ({ status: 400, json: async () => ({ error: 'cart is empty' }) });
  await assert.rejects(submitCheckout(fetcher, { items: [] }), /status 400/);
});
