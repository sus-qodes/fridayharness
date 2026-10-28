import type { Money } from '../../shared/src/api.ts';

/** Formats integer minor units for display, e.g. { amount: 1250, currency: "EUR" } -> "12.50 EUR". */
export function formatPrice(money: Money): string {
  const sign = money.amount < 0 ? '-' : '';
  const abs = Math.abs(money.amount);
  const major = Math.floor(abs / 100);
  const minor = String(abs % 100).padStart(2, '0');
  return `${sign}${major}.${minor} ${money.currency}`;
}
