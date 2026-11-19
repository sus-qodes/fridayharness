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

/**
 * One set of words for where a task stands, the same on every screen (2026-11-19, the trial's
 * U4/U12: "Ready for verification", "Rework", "Agent lost", "claimed" were Friday's own terms).
 * Not started → Starting → Working → (Needs you) → Done, to be checked → Checking → Done; or
 * Checks failed → Being redone; Agent stopped when its session ended midway.
 */
export const TASK_STATUS: Record<TaskStatus, StatusLook> = {
  PROPOSED: { label: 'Not started', color: 'var(--status-proposed)', short: 'not started', terminal: false },
  READY: { label: 'Not started', color: 'var(--status-ready)', short: 'not started', terminal: false },
  ASSIGNED: { label: 'Starting', color: 'var(--status-assigned)', short: 'starting', terminal: false },
  RUNNING: { label: 'Working', color: 'var(--status-running)', short: 'working', terminal: false },
  WAITING: { label: 'Waiting', color: 'var(--status-waiting)', short: 'waiting', terminal: false },
  READY_FOR_VERIFICATION: {
    label: 'Done, to be checked',
    color: 'var(--status-claimed)',
    short: 'to check',
    terminal: false,
  },
  VERIFYING: { label: 'Checking', color: 'var(--status-verifying)', short: 'checking', terminal: false },
  COMPLETED: { label: 'Done', color: 'var(--status-completed)', short: 'done', terminal: true },
  FAILED: { label: 'Checks failed', color: 'var(--status-failed)', short: 'failed', terminal: false },
  REWORK: { label: 'Being redone', color: 'var(--status-rework)', short: 'redo', terminal: false },
  HARNESS_LOST: { label: 'Agent stopped', color: 'var(--status-lost)', short: 'stopped', terminal: false },
  CANCELLED: { label: 'Cancelled', color: 'var(--status-cancelled)', short: 'cancelled', terminal: true },
  ABANDONED: { label: 'Given up', color: 'var(--status-cancelled)', short: 'given up', terminal: true },
};

/** A goal's status in words (2026-11-19). */
export const GOAL_WORDS: Record<string, string> = {
  OPEN: 'Not started',
  ACTIVE: 'In progress',
  COMPLETED: 'Done',
  CANCELLED: 'Cancelled',
};

/** The checks of a task, or one check, in words (2026-11-19). */
export const CHECK_WORDS: Record<string, string> = {
  NOT_REQUESTED: 'Not run',
  QUEUED: 'Waiting to run',
  RUNNING: 'Running',
  PASSED: 'Passed',
  FAILED: 'Failed',
  BLOCKED: 'Could not run',
  CANCELLED: 'Stopped',
};

/** Bringing a task's work into its goal, in words (2026-11-19: "integrated", "conflicted"). */
export const MERGE_WORDS: Record<string, string> = {
  integrated: 'Merged into the goal',
  conflicted: 'Clashes with other work',
  failed: 'Could not merge',
  not_needed: 'Nothing to merge',
};

/** A word of one of these tables, or the value itself made readable. */
export function wordsFor(table: Record<string, string>, value: string): string {
  return (
    table[value] ??
    value
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/^./, (c) => c.toUpperCase())
  );
}

/** A task's status in words, with "Needs you" for one that waits for the person. */
export function statusWords(task: Pick<SnapshotTask, 'status' | 'waiting_reason'>): string {
  return waitsForHuman(task) ? 'Needs you' : statusLook(task.status).label;
}

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
  blocked: 'the agent is stuck',
  context_required: 'the agent needs more to go on',
  human_approval: 'waits for your permission',
  dependency_wait: 'waits for another task',
  agent_error: 'the agent hit an error',
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

export type EnforcementWord = 'Checked by Friday' | 'Friday watches only' | 'Checks not confirmed';

export type EnforcementTone = 'good' | 'info' | 'warn' | 'muted' | 'strong';

/**
 * How far Friday holds an agent's actions, in a person's words (2026-11-18; they were the codes
 * "Enforced", "Reported", "Watched" and "Unverified", which a person in the trial could not read).
 * *Checked by Friday*: Friday's hooks decide each action before it happens (L1 enforcing, or an
 * isolated L2 profile). *Friday watches only*: Friday sees what it did but cannot stop an action
 * (L1 reported, or L0). *Checks not confirmed*: an L1 session whose hooks Friday has not seen work.
 * The level and what it rests on stay in the tooltip, for whoever looks for them.
 */
export function enforcementWords(
  level: string | null | undefined,
  status: string | null | undefined,
  basis?: string | null,
): { label: EnforcementWord; tone: EnforcementTone; title: string } {
  let label: EnforcementWord;
  let tone: EnforcementTone;
  let say: string;
  let detail: string;
  if (level === 'L2' || (level === 'L1' && status === 'enforcing')) {
    label = 'Checked by Friday';
    tone = level === 'L2' ? 'strong' : 'good';
    say = 'Friday checks each action of this agent before it happens, and can stop it.';
    detail = status ?? 'isolated';
  } else if (level === 'L1' && status === 'reported') {
    label = 'Friday watches only';
    tone = 'info';
    say = "This agent's app tells Friday what it did, but Friday cannot stop an action before it happens.";
    detail = status;
  } else if (level === 'L1') {
    label = 'Checks not confirmed';
    tone = 'warn';
    say = 'Friday has not seen its checks work for this agent yet. If this stays, check the agent under Agents.';
    detail = status ?? 'unverified';
  } else {
    label = 'Friday watches only';
    tone = 'muted';
    say = "Friday sees this agent's work, but does not check its actions as they happen.";
    detail = status ?? 'observed';
  }
  const shown = level === 'L1' || level === 'L2' ? level : 'L0';
  return { label, tone, title: `${say} (level ${shown}, ${detail}${basis ? `: ${basis}` : ''})` };
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
