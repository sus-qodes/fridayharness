/**
 * Agent-written text shown so it cannot deceive (plan §6.2, FD-28). Rendering as text stops markup;
 * this also stops the text from lying visually: control, bidirectional and zero-width characters
 * become visible `⟨U+XXXX⟩` marks, and long values are never cut off where a decision depends on
 * them (the caller checks `fits` and offers no one-click decision when they do not).
 */

/**
 * Characters that change how text looks without being seen: C0 and C1 controls (tab and newline
 * kept), the soft hyphen, the Arabic letter mark and the Mongolian vowel separator, zero-width
 * and directional marks, line and paragraph separators, bidirectional embeddings, overrides and
 * isolates, invisible operators, the byte-order mark, and the tag characters. The same set as the
 * desktop dialog (`apps/desktop/src-tauri/src/confirm.rs`).
 */
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these characters are what is being found
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** One visible mark for one hidden character. */
export function mark(ch: string): string {
  return `⟨U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}⟩`;
}

/** The text with every hidden character replaced by its visible mark; tabs and newlines are kept. */
export function visible(text: string): string {
  return text.replace(HIDDEN, mark);
}

/** True when the text holds any hidden character (the card shows a warning beside it). */
export function hasHidden(text: string): boolean {
  HIDDEN.lastIndex = 0;
  const found = HIDDEN.test(text);
  HIDDEN.lastIndex = 0;
  return found;
}

/**
 * Whether a target can be shown in full on a card: at most `maxLines` lines of `perLine`
 * characters once wrapped. A target that does not fit is decided in the modal, never on one click.
 */
export function fits(text: string, opts: { perLine?: number; maxLines?: number } = {}): boolean {
  const perLine = opts.perLine ?? 48;
  const maxLines = opts.maxLines ?? 6;
  let lines = 0;
  for (const line of visible(text).split('\n')) {
    lines += Math.max(1, Math.ceil(Array.from(line).length / perLine));
    if (lines > maxLines) return false;
  }
  return true;
}
