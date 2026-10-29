/**
 * How every value Friday uses looks (handoff Part 04, extended in plan §7.3): task statuses with
 * their colour token and label, waiting reasons, kinds, priorities, and enforcement badges. One
 * table, used by the cards, the inspector, the Notch and the palette.
 */
import type { SnapshotTask } from '@friday/protocol';

export type TaskStatus =
  | 'PROPOSED'
  | 'READY'
  | 'ASSIGNED'
  | 'RUNNING'
  | 'WAITING'
  | 'READY_FOR_VERIFICATION'
  | 'VERIFYING'
  | 'COMPLETED'
  | 'FAILED'
  | 'REWORK'
  | 'HARNESS_LOST'
  | 'CANCELLED'
  | 'ABANDONED';

export interface StatusLook {
  label: string;
  /** A CSS custom property from `styles/tokens.css`. */
  color: `var(--${string})`;
  /** Short word for tags on the Notch. */
  short: string;
  terminal: boolean;
}

export const TASK_STATUS: Record<TaskStatus, StatusLook> = {
  PROPOSED: { label: 'Proposed', color: 'var(--status-proposed)', short: 'proposed', terminal: false },
  READY: { label: 'Ready', color: 'var(--status-ready)', short: 'ready', terminal: false },
  ASSIGNED: { label: 'Assigned', color: 'var(--status-assigned)', short: 'assigned', terminal: false },
  RUNNING: { label: 'Running', color: 'var(--status-running)', short: 'running', terminal: false },
  WAITING: { label: 'Waiting', color: 'var(--status-waiting)', short: 'waiting', terminal: false },
  READY_FOR_VERIFICATION: {
    label: 'Ready for verification',
    color: 'var(--status-claimed)',
    short: 'claimed',
    terminal: false,
  },
  VERIFYING: { label: 'Verifying', color: 'var(--status-verifying)', short: 'verifying', terminal: false },
  COMPLETED: { label: 'Completed', color: 'var(--status-completed)', short: 'done', terminal: true },
  FAILED: { label: 'Failed', color: 'var(--status-failed)', short: 'failed', terminal: false },
  REWORK: { label: 'Rework', color: 'var(--status-rework)', short: 'rework', terminal: false },
  HARNESS_LOST: { label: 'Agent lost', color: 'var(--status-lost)', short: 'lost', terminal: false },
  CANCELLED: { label: 'Cancelled', color: 'var(--status-cancelled)', short: 'cancelled', terminal: true },
  ABANDONED: { label: 'Abandoned', color: 'var(--status-cancelled)', short: 'abandoned', terminal: true },
};

export function statusLook(status: string): StatusLook {
  return (
    TASK_STATUS[status as TaskStatus] ?? {
      label: status,
      color: 'var(--status-proposed)',
      short: status.toLowerCase(),
      terminal: false,
    }
  );
}

export const WAITING_REASON: Record<string, string> = {
  blocked: 'blocked: needs you',
  context_required: 'needs context',
  human_approval: 'waits for an approval',
  dependency_wait: 'waits for a dependency',
  agent_error: 'agent error',
};

export const TASK_KIND: Record<string, { label: string; color: `var(--${string})` }> = {
  implementation: { label: 'impl', color: 'var(--color-blue)' },
  verification: { label: 'verify', color: 'var(--color-emerald)' },
  review: { label: 'review', color: 'var(--color-violet)' },
  research: { label: 'research', color: 'var(--color-indigo)' },
  docs: { label: 'docs', color: 'var(--color-cyan)' },
  chore: { label: 'chore', color: 'var(--color-slate-400)' },
};

export const PRIORITY: Record<string, { label: string; rank: number }> = {
  urgent: { label: 'Urgent', rank: 0 },
  high: { label: 'High', rank: 1 },
  normal: { label: 'Normal', rank: 2 },
  low: { label: 'Low', rank: 3 },
};

export const RISK: Record<string, { label: string; color: `var(--${string})` }> = {
  low: { label: 'Low risk', color: 'var(--color-emerald)' },
  medium: { label: 'Medium risk', color: 'var(--color-amber)' },
  high: { label: 'High risk', color: 'var(--color-crimson)' },
};

export type EnforcementWord = 'Enforced' | 'Reported' | 'Watched' | 'Unverified';

export type EnforcementTone = 'good' | 'info' | 'warn' | 'muted' | 'strong';

/**
 * The enforcement of an agent's session in plain words, one vocabulary for the pod on the canvas
 * and the row in the Agents drawer (review M9k, the only code words that were on the first screen):
 * *Enforced* when Friday's hooks decide what the host may do (L1 enforcing, or an isolated L2
 * profile), *Reported* when the host reports and Friday records but cannot block (L1 reported),
 * *Watched* when Friday only observes (L0), *Unverified* when an L1 session's hooks are degraded or
 * unconfirmed. The level, the status word and what they rest on go in the tooltip.
 */
export function enforcementWords(
  level: string | null | undefined,
  status: string | null | undefined,
  basis?: string | null,
): { label: EnforcementWord; tone: EnforcementTone; title: string } {
  let label: EnforcementWord;
  let tone: EnforcementTone;
  let detail: string;
  if (level === 'L2') {
    label = 'Enforced';
    tone = 'strong';
    detail = status ?? 'isolated';
  } else if (level === 'L1' && status === 'enforcing') {
    label = 'Enforced';
    tone = 'good';
    detail = status;
  } else if (level === 'L1' && status === 'reported') {
    label = 'Reported';
    tone = 'info';
    detail = status;
  } else if (level === 'L1') {
    label = 'Unverified';
    tone = 'warn';
    detail = status ?? 'unverified';
  } else {
    label = 'Watched';
    tone = 'muted';
    detail = status ?? 'observed';
  }
  const shown = level === 'L1' || level === 'L2' ? level : 'L0';
  return { label, tone, title: `Enforcement level ${shown} (${detail})${basis ? `: ${basis}` : ''}` };
}

/** A task that waits for a human: an approval, a question, or a blocked agent (plan §7.5). */
export function waitsForHuman(task: Pick<SnapshotTask, 'status' | 'waiting_reason'>): boolean {
  return task.status === 'WAITING' && (task.waiting_reason === 'blocked' || task.waiting_reason === 'human_approval');
}

/**
 * Why a READY task has not started, from the Master Brain's last delegation note: its rules write
 * "waits: …" when one holds the task back. Plain text; the caller cleans and shortens it.
 */
export function notStartedText(note: string): string {
  return `Not started yet: ${note.replace(/^waits:\s*/i, '')}`;
}
