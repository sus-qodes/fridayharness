/**
 * The inspector's History tab (plan §7.4, §5.11): one readable line per task event, newest first,
 * and the paging of older events by `before = the oldest sequence shown`. Pure; no DOM. Every
 * string from an event passes `cleanText` and is cut short: payloads are written by agents too.
 */
import type { DomainEvent } from '@friday/protocol';
import { capabilityWords } from '../model/capability-words.js';
import { statusLook, TASK_STATUS, WAITING_REASON } from '../model/status.js';
import { cleanText, humanize, shortId, truncate } from '../ui/format.js';

export const HISTORY_PAGE = 100;

export type EventTone = 'info' | 'good' | 'warn' | 'danger' | 'muted';

export interface EventLine {
  sequence: number;
  at: string;
  text: string;
  actor: string;
  tone: EventTone;
  type: string;
}

type Payload = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v : null;
}

function obj(v: unknown): Payload {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Payload) : {};
}

function clip(v: unknown, max = 200): string {
  return truncate(cleanText(String(v)).replace(/\s+/g, ' ').trim(), max);
}

/** Who did it, in words: "you" for the local human, "Friday" for the system. */
export function actorLabel(actor: { kind?: string; id?: string } | null | undefined): string {
  if (!actor) return 'Friday';
  switch (actor.kind) {
    case 'human':
      return actor.id === 'local-operator' ? 'you' : `human ${clip(actor.id ?? '', 40)}`;
    case 'agent':
      return `agent ${shortId(actor.id)}`;
    case 'harness':
      return `session ${shortId(actor.id)}`;
    case 'master_brain':
      return 'Friday’s planner';
    default:
      return 'Friday';
  }
}

const LABELS: Record<string, string> = {
  'task.created': 'Task created',
  'task.ready': 'Ready to start',
  'task.assigned': 'Given to an agent',
  'task.started': 'Agent started work',
  'task.waiting': 'Waiting',
  'task.resumed': 'Resumed',
  'task.released': 'Let go by its agent',
  'task.completion_claimed': 'The agent said it is done',
  'task.verification_started': 'Checks started',
  'task.verification_interrupted': 'Checks stopped before the end',
  'task.completed': 'Done',
  'task.failed': 'Checks failed',
  'task.rework': 'Sent back to be redone',
  'task.harness_lost': 'The agent stopped',
  'task.cancelled': 'Cancelled',
  'run.created': 'A try began',
  'run.accepted': 'The agent took it',
  'run.declined': 'The agent did not take it',
  'run.suspended': 'Paused',
  'run.resumed': 'Going again',
  'run.ended': 'The try ended',
  'run.workspace_ready': 'Task folder ready',
  'run.rebound': 'Work brought into a task folder on this computer',
  'run.model_observed': 'Model in use',
  'verification.started': 'Checks started',
  'verification.check_completed': 'Check finished',
  'verification.finished': 'Checks finished',
  'verification.interrupted': 'Checks stopped before the end',
  'approval.requested': 'Asked for your permission',
  'approval.decided': 'You decided',
  'approval.revoked': 'Permission taken back',
  'escalation.requested': 'A question for you',
  'integration.completed': 'Merged into the goal',
  'integration.conflicted': 'Clashed with other work',
  'integration.failed': 'Could not merge',
  'integration.not_needed': 'Nothing to merge',
  'recovery.performed': 'Given to another agent, or started again',
  'worktree.allocated': 'Task folder created',
  'worktree.released': 'Task folder no longer in use',
  'worktree.removed': 'Task folder removed',
  'file.reserved': 'File kept for this task',
  'file.reservation_ended': 'File free again',
  'routing.decided': 'Model chosen',
  'routing.blocked': 'No model could be chosen',
  'routing.violated': 'Ran on another model than chosen',
  'context.compiled': 'Brief prepared for the agent',
  'communication.sent': 'Message sent',
  'control.task_stopped': 'Stopped when you halted the work',
};

const TONES: Record<string, EventTone> = {
  'task.completed': 'good',
  'integration.completed': 'good',
  'task.failed': 'danger',
  'task.harness_lost': 'danger',
  'integration.failed': 'danger',
  'integration.conflicted': 'warn',
  'routing.blocked': 'warn',
  'routing.violated': 'warn',
  'task.waiting': 'warn',
  'task.rework': 'warn',
  'approval.requested': 'warn',
  'escalation.requested': 'warn',
  'task.cancelled': 'muted',
  'run.declined': 'warn',
};

/** A decision on a request, and where it was made, in words (2026-11-19). */
const DECIDED: Record<string, string> = {
  granted: 'allowed',
  denied: 'refused',
  expired: 'ran out',
  revoked: 'taken back',
};
const VIA: Record<string, string> = {
  ui: 'in the app',
  notch: 'in the Notch',
  cli: 'in a terminal',
  desktop: 'in the app',
};

/** A task's state by the words the cards use; anything else made readable. */
const stateWords = (s: string) => (s in TASK_STATUS ? statusLook(s).label : humanize(s));

/** The details worth one line, by event type, else the transition and reason. */
function details(type: string, p: Payload): string[] {
  const out: string[] = [];
  const transition = obj(p.transition);
  const from = str(transition.from);
  const to = str(transition.to);
  switch (type) {
    case 'task.assigned': {
      const key = str(p.agent_key) ?? str(obj(p.agent).agent_key);
      if (key) out.push(`to ${clip(key, 64)}`);
      break;
    }
    case 'task.waiting': {
      const reason = str(p.waiting_reason) ?? str(p.reason_code);
      if (reason) out.push(WAITING_REASON[reason] ?? clip(reason, 60));
      break;
    }
    case 'task.completion_claimed': {
      const summary = str(p.summary) ?? str(obj(p.claim).summary);
      if (summary) out.push(`"${clip(summary)}"`);
      break;
    }
    case 'run.created': {
      const attempt = obj(p.run).attempt;
      if (typeof attempt === 'number') out.push(`try ${attempt}`);
      break;
    }
    case 'verification.finished':
    case 'verification.check_completed': {
      const name = str(p.name) ?? str(obj(p.check).name);
      const status = str(p.status) ?? str(obj(p.check).status);
      if (name) out.push(clip(name, 60));
      if (status) out.push(humanize(status).toLowerCase());
      const summary = str(p.summary);
      if (summary) out.push(clip(summary));
      break;
    }
    case 'approval.requested': {
      const a = obj(p.approval);
      const cap = str(a.capability);
      const target = str(a.target);
      if (cap) out.push(clip(capabilityWords(cap), 60));
      if (target) out.push(clip(target, 120));
      break;
    }
    case 'approval.decided': {
      const status = str(p.status);
      if (status) out.push(DECIDED[status] ?? status);
      const via = str(p.via);
      if (via) out.push(VIA[via] ?? `via ${clip(via, 20)}`);
      const note = str(p.note);
      if (note) out.push(`"${clip(note)}"`);
      break;
    }
    case 'escalation.requested': {
      const question = str(p.question) ?? str(obj(p.escalation).question);
      if (question) out.push(`"${clip(question)}"`);
      break;
    }
    case 'run.model_observed':
    case 'routing.decided': {
      const model = str(p.model) ?? str(p.model_id);
      if (model) out.push(clip(model, 80));
      break;
    }
    default:
      break;
  }
  if (from && to) out.push(`${stateWords(from)} → ${stateWords(to)}`);
  const reason = str(transition.reason) ?? str(p.reason) ?? (type === 'approval.decided' ? null : str(p.note));
  if (reason && !out.some((x) => x.includes(clip(reason)))) out.push(clip(reason));
  const message = str(p.message) ?? str(p.error);
  if (message) out.push(clip(message));
  return out;
}

/** One readable line for an event. */
export function describeEvent(event: DomainEvent): EventLine {
  const p = obj(event.payload);
  const label = LABELS[event.type] ?? humanize(event.type);
  const parts = details(event.type, p);
  return {
    sequence: event.sequence,
    at: event.occurred_at,
    text: truncate(parts.length ? `${label}: ${parts.join(' · ')}` : label, 600),
    actor: actorLabel(event.actor),
    tone:
      event.type === 'verification.finished'
        ? p.status === 'PASSED'
          ? 'good'
          : p.status === 'FAILED'
            ? 'danger'
            : 'info'
        : (TONES[event.type] ?? 'info'),
    type: event.type,
  };
}

/** Newest first, each sequence once. */
export function mergeEvents(current: readonly DomainEvent[], more: readonly DomainEvent[]): DomainEvent[] {
  const bySeq = new Map<number, DomainEvent>();
  for (const e of [...current, ...more]) bySeq.set(e.sequence, e);
  return [...bySeq.values()].sort((a, b) => b.sequence - a.sequence);
}

/** The `before` of the next older page: the oldest sequence shown; null when nothing is shown. */
export function olderBefore(events: readonly DomainEvent[]): number | null {
  if (!events.length) return null;
  return Math.min(...events.map((e) => e.sequence));
}

/** Whether a page came back full, so older events may exist. */
export function mayHaveOlder(page: readonly DomainEvent[], limit = HISTORY_PAGE): boolean {
  return page.length >= limit;
}
