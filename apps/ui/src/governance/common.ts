/**
 * Small pieces the governance cards share: who asked, which task, risk badges, agent text shown in
 * full with visible escapes (plan FD-28), reduced motion.
 */
import type { ApprovalRow, SnapshotTask, UiSnapshot } from '@friday/protocol';
import { hasHidden, visible } from '../model/text.js';
import type { AppContext } from '../shell/context.js';
import { h } from '../ui/dom.js';
import { cleanText, shortId, truncate } from '../ui/format.js';

export type Risk = 'low' | 'medium' | 'high';

/** An approval's risk; an unknown risk is treated as high (never one click). */
export function riskOf(a: Pick<ApprovalRow, 'risk'>): Risk {
  return a.risk === 'low' || a.risk === 'medium' || a.risk === 'high' ? a.risk : 'high';
}

/** The agent key behind an actor id (an agent id or key); the id itself when unknown. */
export function agentKeyOf(board: UiSnapshot | null, id: string | null | undefined): string | null {
  if (!id) return null;
  const agents = board?.agents ?? [];
  const byId = agents.find((a) => a.agent_id === id);
  if (byId) return byId.agent_key;
  const byKey = agents.find((a) => a.agent_key === id);
  return byKey ? byKey.agent_key : id;
}

export function taskOf(board: UiSnapshot | null, taskId: string | null | undefined): SnapshotTask | null {
  if (!taskId) return null;
  return board?.tasks.find((t) => t.task_id === taskId) ?? null;
}

/** "task_29jxbk8t · Add discount codes" (a summary is shown cleaned and shortened). */
export function taskLine(board: UiSnapshot | null, taskId: string | null | undefined): string {
  if (!taskId) return 'no task';
  const t = taskOf(board, taskId);
  return t ? `${shortId(taskId)} · ${truncate(cleanText(t.summary), 120)}` : shortId(taskId);
}

/** Whether an approval's expiry has passed (the table keeps such rows `pending`; plan §2). */
export function isExpired(a: Pick<ApprovalRow, 'expired' | 'expires_at'>, now: number): boolean {
  if (a.expired) return true;
  if (!a.expires_at) return false;
  const t = Date.parse(a.expires_at);
  return Number.isFinite(t) && t <= now;
}

/** A 409 or `COS-2002`: someone already decided it (the CLI, the other surface). */
export function isAlreadyDecided(error: unknown): boolean {
  const e = error as { status?: unknown; code?: unknown } | null;
  return !!e && (e.status === 409 || e.code === 'COS-2002');
}

export function errorText(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null;
  const code = typeof e?.code === 'string' ? `${e.code}: ` : '';
  return `${code}${typeof e?.message === 'string' ? e.message : String(error)}`;
}

const RISK_TONE: Record<Risk, string> = { low: 'badge-good', medium: 'badge-warn', high: 'badge-danger' };
const RISK_LABEL: Record<Risk, string> = { low: 'Low risk', medium: 'Medium risk', high: 'High risk' };

export function riskBadge(a: Pick<ApprovalRow, 'risk'>): HTMLElement {
  const risk = riskOf(a);
  const label = a.risk ? RISK_LABEL[risk] : 'Risk unknown';
  return h('span', { class: ['badge', RISK_TONE[risk], 'gv-risk', `gv-risk-${risk}`] }, label);
}

export const HIDDEN_WARNING = 'Contains hidden characters, shown as ⟨U+…⟩ marks.';

/**
 * Agent-written text a human decides on (a target, a command, a purpose): shown in full, wrapped,
 * monospaced, with hidden characters as visible marks and a warning when there are any.
 */
export function agentText(label: string | null, text: string | null | undefined, cls?: string): HTMLElement {
  const value = text ?? '';
  return h(
    'div',
    { class: ['gv-field', cls] },
    label ? h('div', { class: 'gv-field-label' }, label) : null,
    value
      ? h('div', { class: 'agent-text gv-agent-text' }, visible(value))
      : h('div', { class: 'gv-none muted' }, 'none given'),
    hasHidden(value) ? h('div', { class: 'hidden-warning', role: 'note' }, HIDDEN_WARNING) : null,
  );
}

/** Prose an agent or Friday wrote (a question, a reason): cleaned of escapes, shown as text. */
export function prose(text: string | null | undefined, cls = 'gv-prose'): HTMLElement | null {
  if (!text) return null;
  return h('p', { class: cls }, cleanText(text));
}

/** True when animation should be replaced by still states (the setting, then the system). */
export function reducedMotion(ctx: Pick<AppContext, 'store'>): boolean {
  const pref = ctx.store.select('prefs').motion;
  if (pref === 'reduce') return true;
  if (pref === 'full') return false;
  try {
    return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** A label element for a field. */
export function fieldLabel(text: string, forId?: string): HTMLElement {
  return h('label', { class: 'field-label', ...(forId ? { for: forId } : {}) }, text);
}

let uid = 0;
/** A unique element id for labels and descriptions. */
export function nextId(prefix: string): string {
  uid += 1;
  return `gv-${prefix}-${uid}`;
}
