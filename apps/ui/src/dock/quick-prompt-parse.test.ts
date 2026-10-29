import { describe, expect, it } from 'vitest';
import { makeApproval, makeEscalation, makeScenario, makeSnapshot, makeTask } from '../test/fixtures.js';
import {
  CHANGED_MESSAGE,
  checkProposal,
  findTask,
  isLive,
  oldestQuickApproval,
  parseQuickPrompt,
  pendingSignature,
  proposeDecision,
  type QuickCommand,
  statusLine,
} from './quick-prompt-parse.js';

const NOW = Date.parse('2026-10-17T10:00:00.000Z');

describe('parseQuickPrompt', () => {
  const table: [string, QuickCommand['kind'], Partial<Record<string, unknown>>?][] = [
    ['', 'empty'],
    ['   ', 'empty'],
    ['pause', 'pause'],
    ['  PAUSE  ', 'pause'],
    ['resume', 'resume'],
    ['Resume', 'resume'],
    ['halt', 'halt'],
    ['status', 'status'],
    ['approve', 'approve'],
    ['deny', 'deny', { reason: null }],
    ['deny   not in this task, please', 'deny', { reason: 'not in this task, please' }],
    ['open task_00000000000000000000api001', 'open', { ref: 'task_00000000000000000000api001' }],
    ['open api0', 'open', { ref: 'api0' }],
    ['start claude-code claude-2', 'start', { host: 'claude-code', agentKey: 'claude-2', role: null }],
    ['start codex codex-1 as frontend', 'start', { host: 'codex', agentKey: 'codex-1', role: 'frontend' }],
    ['START Codex codex-1 AS qa_lead', 'start', { host: 'codex', agentKey: 'codex-1', role: 'qa_lead' }],
    ['goal Add Stripe subscriptions', 'goal', { text: 'Add Stripe subscriptions' }],
    ['Goal   keep checkout working ', 'goal', { text: 'keep checkout working' }],
    ['Fix the auth tests', 'propose-goal', { text: 'Fix the auth tests' }],
    ['What is currently running?', 'propose-goal', { text: 'What is currently running?' }],
    ['create a task to fix pricing', 'propose-goal', { text: 'create a task to fix pricing' }],
  ];

  for (const [input, kind, fields] of table) {
    it(`parses ${JSON.stringify(input)} as ${kind}`, () => {
      const cmd = parseQuickPrompt(input);
      expect(cmd.kind).toBe(kind);
      if (fields) expect(cmd).toMatchObject(fields);
    });
  }

  const invalid: [string, RegExp][] = [
    ['pause dev-backend', /project-wide/],
    ['resume everything', /project-wide/],
    ['halt now please', /halt dialog/],
    ['status of tasks', /status alone/],
    ['approve apr_123', /Enter again approves only that one/],
    ['open', /one task id/],
    ['open a b', /one task id/],
    ['goal', /goal needs the request/],
    ['goal    ', /goal needs the request/],
    ['start', /Usage/],
    ['start claude-code', /Usage/],
    ['start gemini g-1', /claude-code or codex/],
    ['start codex Codex_1', /agent key/],
    ['start codex -rf', /agent key/],
    ['start codex codex-1 for qa', /Usage/],
    ['start codex codex-1 as', /Usage/],
    ['start codex codex-1 as qa extra', /Usage/],
    ['start codex codex-1 as 9lives', /role/],
  ];
  for (const [input, message] of invalid) {
    it(`refuses ${JSON.stringify(input)} with a reason`, () => {
      const cmd = parseQuickPrompt(input);
      expect(cmd.kind).toBe('invalid');
      if (cmd.kind === 'invalid') expect(cmd.message).toMatch(message);
    });
  }

  it('never treats free language as a command it understood', () => {
    for (const text of ['please pause the backend agent', 'can you approve it', 'show status']) {
      expect(parseQuickPrompt(text).kind).toBe('propose-goal');
    }
  });
});

describe('approvals the quick prompt may decide', () => {
  const oldLow = makeApproval({ approval_id: 'apr_old', created_at: '2026-10-17T09:00:00.000Z', risk: 'low' });
  const newMedium = makeApproval({ approval_id: 'apr_new', created_at: '2026-10-17T09:30:00.000Z', risk: 'medium' });
  const oldestHigh = makeApproval({ approval_id: 'apr_high', created_at: '2026-10-17T08:00:00.000Z', risk: 'high' });
  const expired = makeApproval({ approval_id: 'apr_exp', created_at: '2026-10-17T07:00:00.000Z', expired: true });
  const pastExpiry = makeApproval({
    approval_id: 'apr_past',
    created_at: '2026-10-17T07:30:00.000Z',
    expires_at: '2026-10-17T09:59:59.000Z',
  });
  const granted = makeApproval({ approval_id: 'apr_done', created_at: '2026-10-17T06:00:00.000Z', status: 'granted' });

  it('judges liveness by status, the expired flag and the expiry time', () => {
    expect(isLive(oldLow, NOW)).toBe(true);
    expect(isLive(expired, NOW)).toBe(false);
    expect(isLive(pastExpiry, NOW)).toBe(false);
    expect(isLive(granted, NOW)).toBe(false);
    expect(isLive(makeApproval({ expires_at: null }), NOW)).toBe(true);
  });

  it('names the oldest pending low or medium, unexpired approval', () => {
    const board = makeSnapshot({ approvals: [newMedium, oldestHigh, expired, pastExpiry, granted, oldLow] });
    expect(oldestQuickApproval(board, NOW)?.approval_id).toBe('apr_old');
    const noLow = makeSnapshot({ approvals: [newMedium, oldestHigh] });
    expect(oldestQuickApproval(noLow, NOW)?.approval_id).toBe('apr_new');
    expect(oldestQuickApproval(makeSnapshot({ approvals: [oldestHigh] }), NOW)).toBeNull();
    expect(oldestQuickApproval(null, NOW)).toBeNull();
  });

  it('signs the waiting set by its ids, whatever the order', () => {
    const a = makeSnapshot({ approvals: [oldLow, newMedium, expired] });
    const b = makeSnapshot({ approvals: [newMedium, oldLow] });
    expect(pendingSignature(a, NOW)).toBe('apr_new,apr_old');
    expect(pendingSignature(b, NOW)).toBe(pendingSignature(a, NOW));
  });

  it('proposes the named approval with capability, target and id', () => {
    const board = makeSnapshot({ approvals: [oldLow, newMedium] });
    const r = proposeDecision('approve', board, NOW);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.proposal.approvalId).toBe('apr_old');
    expect(r.proposal.message).toBe(
      'Approve once shell.git.commit git commit -m "pricing" (apr_old)? Press Enter again',
    );
    const d = proposeDecision('deny', board, NOW, 'not now');
    expect(d.ok && d.proposal.message).toBe(
      'Deny shell.git.commit git commit -m "pricing" (apr_old) with the reason "not now"? Press Enter again',
    );
    expect(d.ok && d.proposal.reason).toBe('not now');
  });

  it('says why nothing can be proposed', () => {
    const none = proposeDecision('approve', makeSnapshot(), NOW);
    expect(none).toEqual({ ok: false, message: 'No approval is waiting.' });
    const high = proposeDecision('approve', makeSnapshot({ approvals: [oldestHigh] }), NOW);
    expect(high.ok).toBe(false);
    if (!high.ok) expect(high.message).toMatch(/1 high-risk request waits: decide it in its approval card/);
    expect(proposeDecision('approve', null, NOW)).toEqual({ ok: false, message: 'Friday is not connected.' });
  });

  it('refuses to name a target that does not fit', () => {
    const long = makeApproval({ approval_id: 'apr_long', target: 'x'.repeat(5000) });
    const r = proposeDecision('approve', makeSnapshot({ approvals: [long] }), NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/too long to show here/);
  });

  it('shows hidden characters in the target as visible marks', () => {
    const sneaky = makeApproval({ target: 'rm -rf /‮txt.exe​' });
    const r = proposeDecision('approve', makeSnapshot({ approvals: [sneaky] }), NOW);
    expect(r.ok && r.proposal.target).toBe('rm -rf /⟨U+202E⟩txt.exe⟨U+200B⟩');
    expect(r.ok && r.proposal.message).not.toMatch(/‮/);
  });

  it('accepts the second Enter only while the waiting set is unchanged', () => {
    const board = makeSnapshot({ approvals: [oldLow, newMedium] });
    const r = proposeDecision('approve', board, NOW);
    if (!r.ok) throw new Error('expected a proposal');
    expect(checkProposal(r.proposal, board, NOW)).toBeNull();
    // A new request arrived (even a high-risk one): refused.
    const grown = makeSnapshot({ approvals: [oldLow, newMedium, oldestHigh] });
    expect(checkProposal(r.proposal, grown, NOW)).toBe(CHANGED_MESSAGE);
    // The named one was decided elsewhere: refused.
    const decided = makeSnapshot({ approvals: [{ ...oldLow, status: 'granted' }, newMedium] });
    expect(checkProposal(r.proposal, decided, NOW)).toBe(CHANGED_MESSAGE);
    // The named one expired meanwhile: refused.
    expect(checkProposal(r.proposal, board, Date.parse('2026-10-17T11:00:01.000Z'))).toBe(CHANGED_MESSAGE);
    expect(checkProposal(r.proposal, null, NOW)).toBe('Friday is not connected.');
  });
});

describe('findTask', () => {
  const board = makeScenario();

  it('finds a task by its id or a unique start of it', () => {
    expect(findTask(board, 'task_00000000000000000000api001')).toEqual({
      ok: true,
      taskId: 'task_00000000000000000000api001',
    });
    expect(findTask(board, 'TASK_00000000000000000000API001')).toMatchObject({ ok: true });
    expect(findTask(board, '0000000000000000000doc')).toEqual({ ok: true, taskId: 'task_0000000000000000000doc001' });
    expect(findTask(board, 'task_0000000000000000000loo')).toEqual({
      ok: true,
      taskId: 'task_0000000000000000000loose01',
    });
  });

  it('asks for more of an ambiguous id and says when nothing matches', () => {
    const r = findTask(board, 'task_000');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^5 tasks start with task_000/);
    const none = findTask(board, 'zzz‮');
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.message).toBe('No task on the board starts with zzz⟨U+202E⟩.');
    expect(findTask(null, 'x')).toEqual({ ok: false, message: 'Friday is not connected.' });
  });
});

describe('statusLine', () => {
  it('counts what runs and what waits for you', () => {
    const board = makeScenario();
    const s = statusLine(board, NOW);
    expect(s.text).toBe('1 running, 3 waiting for you');
    expect(s.detail).toBe('1 approval, 1 question, 1 blocked agent; 1 ready; 2 agents connected');
  });

  it('says when Friday is paused and counts failures and checks to run', () => {
    const board = makeSnapshot({
      control: { paused: true, reason: null, changed_at: null, changed_by: null, halted_at: null },
      counts: { READY_FOR_VERIFICATION: 2, VERIFYING: 1, FAILED: 1, HARNESS_LOST: 1 },
      tasks: [makeTask({ status: 'FAILED' })],
      escalations: [makeEscalation({ status: 'answered' })],
    });
    const s = statusLine(board, NOW);
    expect(s.text).toBe('Paused. 0 running, 0 waiting for you');
    expect(s.detail).toBe('3 to verify; 2 failed or lost; 0 agents connected');
    expect(statusLine(null, NOW).text).toBe('Friday is not connected');
  });
});
