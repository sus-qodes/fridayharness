/**
 * The control actions the dock, the palette and the quick prompt share (plan §7.6, FD-09): pause,
 * resume, opening the halt dialog, mute. Each daemon call goes through `ctx.act`, so a failure
 * shows its error code and message.
 */
import type { ControlResult, UiSnapshot } from '@friday/protocol';
import { type AppContext, openModal } from '../shell/context.js';
import { plural } from '../ui/format.js';

export function isPaused(ctx: Pick<AppContext, 'store'>): boolean {
  return ctx.store.select('board')?.control.paused === true;
}

export function isConnected(ctx: Pick<AppContext, 'store'>): boolean {
  return ctx.store.select('board') !== null;
}

/** Sessions attached in an editor that Friday cannot stop or restart (they need a prompt there). */
export function attachedSessions(board: UiSnapshot | null): number {
  if (!board) return 0;
  return board.harnesses.filter((h) => h.attach_mode === 'attach' && h.status !== 'TERMINATED').length;
}

export const ATTACHED_NOTE = 'Sessions attached in VS Code need a prompt there to continue.';

/** What a pause did, in one sentence. */
export function pauseText(result: ControlResult): string {
  const sent = (result?.tasks ?? []).filter((t) => t.stop === 'sent').length;
  const base = "Friday is paused: nothing new starts and agents' changes are refused until you resume.";
  if (sent === 0) return base;
  return `${base} Stop sent to ${plural(sent, 'attempt')} that cannot be held at the tool boundary; their work is preserved.`;
}

/** What a resume did, in one sentence. */
export function resumeText(board: UiSnapshot | null): string {
  return attachedSessions(board) > 0 ? `Friday runs again. ${ATTACHED_NOTE}` : 'Friday runs again.';
}

/** Pause and resume share one toast: the newest says which Friday is now. */
const CONTROL_TOAST = 'control';

export async function pauseFriday(ctx: AppContext, reason?: string): Promise<ControlResult | undefined> {
  const r = await ctx.act('Pause Friday', () => ctx.api.pause(reason));
  if (r) {
    ctx.toast({ kind: 'success', text: pauseText(r), key: CONTROL_TOAST });
    ctx.refresh();
  }
  return r;
}

export async function resumeFriday(ctx: AppContext): Promise<ControlResult | undefined> {
  const board = ctx.store.select('board');
  const r = await ctx.act('Resume Friday', () => ctx.api.resume());
  if (r) {
    ctx.toast({ kind: 'success', text: resumeText(board), key: CONTROL_TOAST });
    ctx.refresh();
  }
  return r;
}

/** Opens the halt dialog; halting itself happens only there, after its countdown. */
export function openHalt(ctx: Pick<AppContext, 'store'>): void {
  openModal(ctx, { kind: 'halt' });
}

export function setMuted(ctx: Pick<AppContext, 'store'>, muted: boolean): void {
  ctx.store.patch('prefs', { muted });
}

export function toggleMute(ctx: Pick<AppContext, 'store'>): void {
  setMuted(ctx, !ctx.store.select('prefs').muted);
}

/** Runs a registered command by id (the canvas registers `fit`, `zoom-in`, `zoom-out`); false when absent. */
export function runCommand(ctx: AppContext, id: string): boolean {
  const c = ctx.registry.commands.get(id);
  if (!c) return false;
  if (c.available && !c.available(ctx)) return false;
  void c.run(ctx);
  return true;
}
