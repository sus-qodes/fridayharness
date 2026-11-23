/**
 * One way to count an agent's tokens, whichever agent it is (2026-11-18).
 *
 * Hosts count the prompt differently. Claude Code's `input_tokens` is only the part of the prompt
 * that was neither read from nor written to the cache; those two come apart, and the cost it names
 * includes them. Codex's `inputTokens` is the whole prompt, the part read from the cache included
 * (it names that part again as `cachedInputTokens`). Added up as they came, a Claude card read
 * "14k tokens, $0.98" (the cache, most of the work, left out) and a Codex card "5.6M tokens": two
 * figures that counted different things.
 *
 * Here every count is what the model processed: the whole prompt (fresh, read from the cache and
 * written to it) and the output. A host that says its input already holds the cache
 * (`input_includes_cache`) has the cache counted once.
 */
export interface HostTokens {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  /** The host's `input_tokens` is the whole prompt, the cached part included (Codex). */
  input_includes_cache?: boolean | null;
}

/** The whole prompt and the output, or null when the host reported neither. */
export function allTokens(u: HostTokens): number | null {
  if (u.input_tokens === null && u.output_tokens === null) return null;
  const cache = u.input_includes_cache ? 0 : (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return (u.input_tokens ?? 0) + cache + (u.output_tokens ?? 0);
}

/** The whole prompt alone, counted as `allTokens` counts it; null when the host did not report it. */
export function promptTokens(u: HostTokens): number | null {
  if (u.input_tokens === null) return null;
  const cache = u.input_includes_cache ? 0 : (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return u.input_tokens + cache;
}
