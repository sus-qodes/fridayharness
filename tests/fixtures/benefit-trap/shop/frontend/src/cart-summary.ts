import type { CheckoutItem } from '../../shared/src/api.ts';
import { formatPrice } from './format-price.ts';

/** One line for the cart: how many items and what they cost, e.g. "3 items, 25.00 EUR". */
export function cartSummary(items: CheckoutItem[]): string {
  if (items.length === 0) return 'Your cart is empty';
  const currency = items[0]?.unitPrice.currency ?? 'EUR';
  let count = 0;
  let amount = 0;
  for (const item of items) {
    count += item.quantity;
    amount += item.unitPrice.amount * item.quantity;
  }
  return `${count} ${count === 1 ? 'item' : 'items'}, ${formatPrice({ amount, currency })}`;
}
