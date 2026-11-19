/**
 * The prompt an agent's model read, counted the same way for every host: the daemon's
 * `promptTokens` (packages/protocol/src/usage.ts), repeated here because the interface loads no
 * code of the protocol package (its schemas would come with it). Keep the two alike.
 *
 * Claude Code's `input_tokens` leaves out what was read from and written to the cache, which it
 * reports apart; Codex's is the whole prompt already (`input_includes_cache`).
 */
export function promptTokensOf(u: {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  input_includes_cache?: boolean | null;
}): number | null {
  if (u.input_tokens === null) return null;
  const cache = u.input_includes_cache ? 0 : (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  return u.input_tokens + cache;
}
