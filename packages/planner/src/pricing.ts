import type { ModelUsage } from './providers/types.js';

/** USD per million tokens. */
export interface ModelPrice {
  input: number;
  cache_write_5m: number;
  cache_write_1h: number;
  cache_read: number;
  output: number;
}

export type PriceTable = Record<string, ModelPrice | { tiers: { up_to_prompt_tokens: number; price: ModelPrice }[] }>;

/**
 * Defaults from the Claude pricing page (checked 2026-10-13). Override per model in
 * `.friday/config.yaml` (`providers.anthropic.prices`) when they change.
 */
export const DEFAULT_PRICES: PriceTable = {
  'claude-fable-5-1': { input: 10, cache_write_5m: 12.5, cache_write_1h: 20, cache_read: 0.25, output: 50 },
  'claude-opus-5-5': { input: 4, cache_write_5m: 5, cache_write_1h: 8, cache_read: 0.2, output: 20 },
  'claude-sonnet-5-5': { input: 2, cache_write_5m: 2.5, cache_write_1h: 4, cache_read: 0.1, output: 10 },
  'claude-haiku-5-5': {
    tiers: [
      {
        up_to_prompt_tokens: 100_000,
        price: { input: 0.1, cache_write_5m: 0.125, cache_write_1h: 0.2, cache_read: 0.01, output: 0.5 },
      },
      {
        up_to_prompt_tokens: Number.POSITIVE_INFINITY,
        price: { input: 0.5, cache_write_5m: 0.625, cache_write_1h: 1, cache_read: 0.05, output: 2.5 },
      },
    ],
  },
};

/** Cost of one call; unknown models cost 0 and are reported as such by the caller. */
export function costOf(model: string, usage: ModelUsage, prices: PriceTable = DEFAULT_PRICES): number {
  const entry = prices[model] ?? DEFAULT_PRICES[model];
  if (!entry) return 0;
  const prompt = usage.input_tokens + usage.cache_creation_input_tokens + usage.cache_read_input_tokens;
  const price =
    'tiers' in entry ? (entry.tiers.find((t) => prompt <= t.up_to_prompt_tokens) ?? entry.tiers.at(-1))?.price : entry;
  if (!price) return 0;
  const write1h = usage.cache_write_1h_input_tokens ?? 0;
  const write5m = Math.max(0, usage.cache_creation_input_tokens - write1h);
  const usd =
    (usage.input_tokens * price.input +
      write5m * price.cache_write_5m +
      write1h * price.cache_write_1h +
      usage.cache_read_input_tokens * price.cache_read +
      usage.output_tokens * price.output) /
    1_000_000;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
