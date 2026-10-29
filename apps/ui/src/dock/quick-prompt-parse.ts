/**
 * The quick prompt's parser and decision rules (plan FD-14, FD-28, §7.6, ERRATA F21). The interface
 * has no model: it understands a fixed set of commands and otherwise offers to create a goal from
 * the text. `approve` and `deny` first name the approval they would decide; the second `Enter`
 * decides only that id, and only while the set of waiting approvals is the one that was shown.
 *
 * Pure: no DOM; the clock is a parameter.
 */
import type { ApprovalRow, UiSnapshot } from '@friday/protocol';
import { fits, visible } from '../model/text.js';
import { plural } from '../ui/format.js';

export type AgentHostName = 'claude-code' | 'codex';

export type QuickCommand =
  | { kind: 'empty' }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'halt' }
  | { kind: 'status' }
  | { kind: 'approve' }
  | { kind: 'deny'; reason: string | null }
  | { kind: 'open'; ref: string }
  | { kind: 'start'; host: AgentHostName; agentKey: string; role: string | null }
  | { kind: 'goal'; text: string }
  /** Not a command: offer "Create a goal: <text>" and wait for Enter. */
  | { kind: 'propose-goal'; text: string }
  | { kind: 'invalid'; command: string; message: string };

export const COMMAND_WORDS = ['pause', 'resume', 'halt', 'status', 'approve', 'deny', 'open', 'start', 'goal'] as const;

export const HELP = 'Commands: pause, resume, halt, status, approve, deny [reason], open <task>, start, goal <text>.';
export const START_USAGE = 'start <claude-code|codex> <agent key> [as <role>]';

/** The daemon's own patterns for an agent key and a role (plan §5.9). */
export const AGENT_KEY = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const ROLE = /^[a-z][a-z0-9_-]{0,31}$/;
const HOSTS: readonly AgentHostName[] = ['claude-code', 'codex'];

const OR_GOAL = 'Or type goal <text> to create a goal from it.';

function invalid(command: string, message: string): QuickCommand {
  return { kind: 'invalid', command, message };
}

/** Parses one line of the quick prompt. */
export function parseQuickPrompt(input: string): QuickCommand {
  const text = input.trim();
  if (!text) return { kind: 'empty' };
  const match = /^(\S+)\s*([\s\S]*)$/u.exec(text);
  const word = (match?.[1] ?? '').toLowerCase();
  const rest = (match?.[2] ?? '').trim();
  const args = rest ? rest.split(/\s+/u) : [];

  switch (word) {
    case 'pause':
      if (args.length)
        return invalid(
          'pause',
          'Pausing is project-wide: type pause alone. To stop one agent Friday started, stop its process in Agents.',
        );
      return { kind: 'pause' };
    case 'resume':
      if (args.length) return invalid('resume', `Resuming is project-wide: type resume alone. ${OR_GOAL}`);
      return { kind: 'resume' };
    case 'halt':
      if (args.length) return invalid('halt', 'Type halt alone: the halt dialog asks for the reason.');
      return { kind: 'halt' };
    case 'status':
      if (args.length) return invalid('status', `Type status alone. ${OR_GOAL}`);
      return { kind: 'status' };
    case 'approve':
      if (args.length)
        return invalid(
          'approve',
          'Type approve alone: Friday names the request it would approve, and Enter again approves only that one.',
        );
      return { kind: 'approve' };
    case 'deny':
      return { kind: 'deny', reason: rest || null };
    case 'open':
      if (args.length !== 1) return invalid('open', `open takes one task id or the start of one. ${OR_GOAL}`);
      return { kind: 'open', ref: args[0] as string };
    case 'start':
      return parseStart(args);
    case 'goal':
      if (!rest) return invalid('goal', 'goal needs the request: goal <what you want done>.');
      return { kind: 'goal', text: rest };
    default:
      return { kind: 'propose-goal', text };
  }
}

function parseStart(args: string[]): QuickCommand {
  const usage = `Usage: ${START_USAGE}. ${OR_GOAL}`;
  const [host, key, as, role, ...extra] = args;
  if (!host || !key) return invalid('start', usage);
  const hostName = host.toLowerCase();
  if (!HOSTS.includes(hostName as AgentHostName))
    return invalid('start', `Friday starts claude-code or codex. ${usage}`);
  if (!AGENT_KEY.test(key))
    return invalid(
      'start',
      'An agent key is lower-case letters, digits and dashes, starting with a letter or digit (claude-1).',
    );
  if (as === undefined) return { kind: 'start', host: hostName as AgentHostName, agentKey: key, role: null };
  if (as.toLowerCase() !== 'as' || !role || extra.length) return invalid('start', usage);
  if (!ROLE.test(role))
    return invalid('start', 'A role is lower-case letters, digits, dashes and underscores, starting with a letter.');
  return { kind: 'start', host: hostName as AgentHostName, agentKey: key, role };
}

// ---- approvals

/** A pending approval whose expiry has not passed (the table keeps expired ones pending; plan §2). */
export function isLive(a: ApprovalRow, now: number): boolean {
  if (a.status !== 'pending' || a.expired) return false;
  if (!a.expires_at) return true;
  const t = Date.parse(a.expires_at);
  return Number.isNaN(t) || t > now;
}

/** The waiting approvals as one comparable value: their ids, sorted. */
export function pendingSignature(board: UiSnapshot | null, now: number): string {
  if (!board) return '';
  return board.approvals
    .filter((a) => isLive(a, now))
    .map((a) => a.approval_id)
    .sort()
    .join(',');
}

/** The oldest waiting approval the quick prompt may decide: low or medium risk, unexpired. */
export function oldestQuickApproval(board: UiSnapshot | null, now: number): ApprovalRow | null {
  if (!board) return null;
  const candidates = board.approvals
    .filter((a) => isLive(a, now) && (a.risk === 'low' || a.risk === 'medium'))
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.approval_id.localeCompare(b.approval_id));
  return candidates[0] ?? null;
}

export interface DecisionProposal {
  kind: 'approve' | 'deny';
  approvalId: string;
  /** Shown with visible escapes. */
  capability: string;
  target: string | null;
  reason: string | null;
  /** The waiting set when it was shown; the decision is refused if it changed. */
  signature: string;
  /** The whole question, as one line of text. */
  message: string;
}

export type ProposalResult = { ok: true; proposal: DecisionProposal } | { ok: false; message: string };

/** The first `Enter` of `approve` / `deny`: names the approval it would decide. */
export function proposeDecision(
  kind: 'approve' | 'deny',
  board: UiSnapshot | null,
  now: number,
  reason: string | null = null,
): ProposalResult {
  if (!board) return { ok: false, message: 'Friday is not connected.' };
  const a = oldestQuickApproval(board, now);
  if (!a) {
    const high = board.approvals.filter((x) => isLive(x, now) && x.risk !== 'low' && x.risk !== 'medium').length;
    return {
      ok: false,
      message:
        high > 0
          ? `No low or medium risk approval is waiting. ${plural(high, 'high-risk request')} waits: decide it in its approval card.`
          : 'No approval is waiting.',
    };
  }
  if (a.target !== null && !fits(a.target)) {
    return {
      ok: false,
      message: `The oldest request (${a.approval_id}) has a target too long to show here: decide it in its approval card.`,
    };
  }
  const capability = visible(a.capability);
  const target = a.target === null ? null : visible(a.target);
  const verb = kind === 'approve' ? 'Approve' : 'Deny';
  const what = target ? `${capability} ${target}` : capability;
  const why = kind === 'deny' && reason ? ` with the reason "${visible(reason)}"` : '';
  const scope = kind === 'approve' ? ' once' : '';
  return {
    ok: true,
    proposal: {
      kind,
      approvalId: a.approval_id,
      capability,
      target,
      reason: kind === 'deny' ? reason : null,
      signature: pendingSignature(board, now),
      message: `${verb}${scope} ${what} (${a.approval_id})${why}? Press Enter again`,
    },
  };
}

export const CHANGED_MESSAGE =
  'The waiting approvals changed since this was shown, so nothing was decided. Type approve or deny again.';

/** The second `Enter`: null when the proposal still holds, else why it is refused. */
export function checkProposal(p: DecisionProposal, board: UiSnapshot | null, now: number): string | null {
  if (!board) return 'Friday is not connected.';
  if (pendingSignature(board, now) !== p.signature) return CHANGED_MESSAGE;
  const a = board.approvals.find((x) => x.approval_id === p.approvalId);
  if (!a || !isLive(a, now)) return CHANGED_MESSAGE;
  return null;
}

// ---- open

export type TaskLookup = { ok: true; taskId: string } | { ok: false; message: string };

/** A task by its id or the start of one (with or without the `task_` prefix). */
export function findTask(board: UiSnapshot | null, ref: string): TaskLookup {
  if (!board) return { ok: false, message: 'Friday is not connected.' };
  const r = ref.trim().toLowerCase();
  if (!r) return { ok: false, message: 'open needs a task id.' };
  const exact = board.tasks.find((t) => t.task_id.toLowerCase() === r);
  if (exact) return { ok: true, taskId: exact.task_id };
  const hits = board.tasks.filter((t) => {
    const id = t.task_id.toLowerCase();
    return id.startsWith(r) || (id.startsWith('task_') && id.slice(5).startsWith(r));
  });
  if (hits.length === 1) return { ok: true, taskId: (hits[0] as { task_id: string }).task_id };
  if (hits.length > 1)
    return { ok: false, message: `${plural(hits.length, 'task')} start with ${visible(ref)}: type more of the id.` };
  return { ok: false, message: `No task on the board starts with ${visible(ref)}.` };
}

// ---- status

/** The `status` toast: what runs and what waits for you. */
export function statusLine(board: UiSnapshot | null, now: number): { text: string; detail: string } {
  if (!board) return { text: 'Friday is not connected', detail: '' };
  const count = (s: string) => board.counts[s] ?? 0;
  const approvals = board.approvals.filter((a) => isLive(a, now)).length;
  const questions = board.escalations.filter((e) => e.status === 'pending').length;
  const blocked = board.tasks.filter((t) => t.status === 'WAITING' && t.waiting_reason === 'blocked').length;
  const waiting = approvals + questions + blocked;
  const head = `${board.control.paused ? 'Paused. ' : ''}${count('RUNNING')} running, ${waiting} waiting for you`;
  const parts: string[] = [];
  if (waiting > 0) {
    const why = [
      approvals ? plural(approvals, 'approval') : '',
      questions ? plural(questions, 'question') : '',
      blocked ? plural(blocked, 'blocked agent') : '',
    ].filter(Boolean);
    parts.push(why.join(', '));
  }
  const ready = count('READY');
  const toVerify = count('READY_FOR_VERIFICATION') + count('VERIFYING');
  const failed = count('FAILED') + count('HARNESS_LOST');
  if (ready) parts.push(`${ready} ready`);
  if (toVerify) parts.push(`${toVerify} to verify`);
  if (failed) parts.push(`${failed} failed or lost`);
  const agents = board.agents.filter((a) => a.status !== 'DISCONNECTED' && a.status !== 'TERMINATED').length;
  parts.push(`${plural(agents, 'agent')} connected`);
  return { text: head, detail: parts.join('; ') };
}
