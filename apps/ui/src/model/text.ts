/**
 * Agent-written text shown so it cannot deceive (plan §6.2, FD-28). Rendering as text stops markup;
 * this also stops the text from lying visually: control, bidirectional and zero-width characters
 * become visible `⟨U+XXXX⟩` marks, and long values are never cut off where a decision depends on
 * them (the caller checks `fits` and offers no one-click decision when they do not).
 */

/** Characters that change how text looks without being seen. */
const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these characters are what is being found
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/gu;

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
