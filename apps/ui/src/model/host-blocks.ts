/**
 * What keeps a host out of work, in words (2026-11-17), from the board's `host_blocks`: a failed
 * sign-in, which stays until a person says they signed in again, or a bench after a limit or a
 * failure, which ends by itself. Pure: the notice in the Agents drawer and the routing question's
 * card both read these.
 */
import type { HostBlockView, UiSnapshot } from '@friday/protocol';
import { visible } from './text.js';

/** Hosts by the name a person knows them by. */
const HOST_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  cursor: 'Cursor',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
};

export function hostName(host: string): string {
  return HOST_NAMES[host] ?? visible(host);
}

/** The blocks in force, a failed sign-in first; `host` limits them to one host's. */
export function hostBlocks(board: UiSnapshot | null | undefined, host?: string): HostBlockView[] {
  const all = Array.isArray(board?.host_blocks) ? (board?.host_blocks ?? []) : [];
  return all
    .filter((b) => b && typeof b.host === 'string' && (!host || b.host === host))
    .sort((a, b) => Number(b.kind === 'sign_in') - Number(a.kind === 'sign_in'));
}

/** One key per block: a host, a model of it or all, and the kind. */
export function blockKey(b: HostBlockView): string {
  return `${b.host}|${b.model ?? ''}|${b.kind}`;
}

/** The time of day a bench ends, as this machine's clock shows it. */
function clock(iso: string | null): string | null {
  if (!iso) return null;
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** What a block says, without its button. */
export function blockSentence(b: HostBlockView): string {
  const who = `${hostName(b.host)}${b.model ? ` (${visible(b.model)})` : ''}`;
  if (b.kind === 'sign_in') {
    return `${who} is not signed in, so Friday gives it no work. Sign in to ${hostName(b.host)} (in its own app, or by running it once in a terminal), then say so here.`;
  }
  const until = clock(b.until);
  return `${who} is left out for now${until ? ` until ${until}` : ''}: it hit a limit or failed, and Friday tries it again by itself.`;
}

/** What its button reads. */
export function liftLabel(b: HostBlockView): string {
  return b.kind === 'sign_in' ? 'I signed in: try again' : 'Try again now';
}
