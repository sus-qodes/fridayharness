import type { CheckoutRequest, CheckoutResponse } from '../../shared/src/api.ts';
import { isMoney } from '../../shared/src/api.ts';

export type Fetcher = (
  url: string,
  init: { method: string; body: string },
) => Promise<{ status: number; json(): Promise<unknown> }>;

/** The only way the frontend reaches the backend (DECISIONS.md ADR-002). */
export async function submitCheckout(fetcher: Fetcher, request: CheckoutRequest): Promise<CheckoutResponse> {
  const res = await fetcher('/checkout', { method: 'POST', body: JSON.stringify(request) });
  const body = (await res.json()) as CheckoutResponse;
  if (res.status !== 200 || !isMoney(body.total)) throw new Error(`checkout failed with status ${res.status}`);
  return body;
}
