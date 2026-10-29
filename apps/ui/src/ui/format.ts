/** Formatting helpers. Pure functions; `now` is a parameter so tests are deterministic. */

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "just now", "12 s ago", "4 min ago", "3 h ago", "2 d ago". */
export function timeAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((now - t) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s} s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const hours = Math.round(m / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

/** "in 4 min", "in 30 s", "expired". */
export function timeUntil(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '—';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '—';
  const s = Math.round((t - now) / 1000);
  if (s <= 0) return 'expired';
  if (s < 60) return `in ${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `in ${m} min`;
  return `in ${Math.round(m / 60)} h`;
}

/** "850 ms", "4.2 s", "3m 05s", "1h 02m". */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const totalS = Math.round(ms / 1000);
  const h = Math.floor(totalS / 3600);
  const m = Math.floor((totalS % 3600) / 60);
  const sec = totalS % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

export function usd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** 18400 → "18.4k". */
export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  if (Math.abs(n) < 1000) return String(Math.round(n));
  if (Math.abs(n) < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Shortens with an ellipsis, by code points so surrogate pairs are never split. */
export function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return `${chars.slice(0, Math.max(0, max - 1)).join('')}…`;
}

/** The last path segment: `backend/src/a.ts` → `a.ts`. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** `task_29jxbk8t7z47244abcdefghij` → `task_29jxbk8t`. */
export function shortId(id: string | null | undefined, keep = 8): string {
  if (!id) return '—';
  const i = id.indexOf('_');
  if (i < 0) return id.slice(0, keep);
  return id.slice(0, i + 1 + keep);
}

/**
 * Removes terminal escape sequences and control characters (except tab and newline) from text
 * that came from a process or an agent, and bidirectional overrides that could disguise it.
 */
export function cleanText(text: string): string {
  return (
    stripEscapes(text)
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters other than tab and newline
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
      .replace(/[‪-‮⁦-⁩]/g, '')
  );
}

/**
 * Removes terminal escape sequences only, each exactly: a CSI sequence, a terminal string (OSC,
 * DCS, SOS, PM, APC) with its terminator, or any other escape as its two characters. Never the
 * text after one: an unterminated string keeps its text (review M9i).
 */
export function stripEscapes(text: string): string {
  return (
    text
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequences are removed on purpose
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal strings with their terminator
      .replace(/\u001b[\]PX^_][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: any other escape: exactly two characters
      .replace(/\u001b[@-_]/g, '')
  );
}

export function titleCase(word: string): string {
  return word.length ? word[0]?.toUpperCase() + word.slice(1).toLowerCase() : word;
}

/** `READY_FOR_VERIFICATION` → `Ready for verification`. */
export function humanize(value: string): string {
  return titleCase(value.replace(/[_.]+/g, ' ').trim());
}
