/** API contract between frontend and backend (DECISIONS.md ADR-002). */

export interface Money {
  /** Integer amount in minor units, e.g. cents (ADR-001). */
  amount: number;
  /** ISO-4217 code, e.g. "EUR". */
  currency: string;
}

export interface CheckoutItem {
  sku: string;
  quantity: number;
  unitPrice: Money;
}

export interface CheckoutRequest {
  items: CheckoutItem[];
}

export interface CheckoutResponse {
  orderId: string;
  total: Money;
}

export function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return Number.isInteger(v.amount) && typeof v.currency === 'string' && /^[A-Z]{3}$/.test(v.currency);
}
