import type { CheckoutRequest } from '../../shared/src/api.ts';
import { CheckoutError, checkout } from './checkout.service.ts';

export interface HttpResult {
  status: number;
  body: unknown;
}

/** POST /checkout */
export function handleCheckout(body: unknown): HttpResult {
  try {
    return { status: 200, body: checkout(body as CheckoutRequest) };
  } catch (e) {
    if (e instanceof CheckoutError) return { status: 400, body: { error: e.message } };
    throw e;
  }
}
