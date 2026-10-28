import type { CheckoutRequest, CheckoutResponse, Money } from '../../shared/src/api.ts';
import { isMoney } from '../../shared/src/api.ts';

export class CheckoutError extends Error {}

export function totalOf(request: CheckoutRequest): Money {
  if (request.items.length === 0) throw new CheckoutError('cart is empty');
  const currency = request.items[0]?.unitPrice.currency ?? 'EUR';
  let amount = 0;
  for (const item of request.items) {
    if (!isMoney(item.unitPrice)) throw new CheckoutError(`invalid price for ${item.sku}`);
    if (item.unitPrice.currency !== currency) throw new CheckoutError('mixed currencies');
    if (!Number.isInteger(item.quantity) || item.quantity < 1) throw new CheckoutError(`invalid quantity for ${item.sku}`);
    amount += item.unitPrice.amount * item.quantity;
  }
  return { amount, currency };
}

let nextOrder = 1;

export function checkout(request: CheckoutRequest): CheckoutResponse {
  const total = totalOf(request);
  const orderId = `ord_${String(nextOrder++).padStart(6, '0')}`;
  return { orderId, total };
}
