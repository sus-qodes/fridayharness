/**
 * The M3 gate (plan M3) on fixture-shop: a real `friday run` daemon, the fake planner, two
 * FakeHarness agents working on one goal, and the CLI for the human's part.
 *
 * - Part 12 §4: a worker contacts another agent by role; Friday validates, resolves the target,
 *   compiles minimal context, routes and records.
 * - Part 12 §3: the backend asks what the frontend expects; the answer arrives correlated, with
 *   structured facts, and no transcript is copied anywhere (the graph-backed context of §3 is M4).
 * - Replay equals live: a snapshot plus the tail and the full log both rebuild the live state.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { materializeFixtureShop } from '@friday/cli';
import { FridayError, type InboxItem, type MessageView, type TaskView } from '@friday/protocol';
import { DaemonClient, loadProject } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT, spawnFridayRun } from '../helpers/cli.js';
import type { TestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'planner', 'stripe-subscriptions');
let savedStateDir: string | undefined;

beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, what: string, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(v).slice(0, 400)}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe('M3 gate on fixture-shop', () => {
  it('routes messages by role between agents of one goal, answers with facts, and replays to the live state', async () => {
    const { root } = materializeFixtureShop(path.join(ws().root, 'shop'));
    appendFileSync(
      path.join(root, '.friday', 'config.yaml'),
      `\nmaster_brain:\n  provider: fake\n  fake_responses: ${JSON.stringify(FIXTURES)}\n`,
    );
    const daemon = await spawnFridayRun(ws(), 30_000, root);
    const ref = loadProject(root);
    const operator = DaemonClient.forProject(ref, 'operator', { clientName: 'gate' });
    const td = {
      url: daemon.url,
      project: ref,
      bootstrap: DaemonClient.forProject(ref, 'bootstrap', { clientName: 'gate' }),
    } as unknown as TestDaemon;
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', role: 'backend' });
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    const qa = await FakeHarness.connect(td, { agentKey: 'qa-1', role: 'qa' });
    ws().track({ close: () => Promise.all([be.close(), fe.close(), qa.close()]) });
    const friday = (...args: string[]) => cli(['--project', root, ...args]);

    // A goal with backend and frontend work running in parallel.
    const created = await friday(
      'goal',
      'create',
      'Add Stripe subscriptions, keep one-time checkout working, add tests',
      '--wait',
      '20',
    );
    expect(created.code, created.stderr).toBe(0);
    expect((await friday('plan', 'approve')).code).toBe(0);
    const tasks = await until(
      () => operator.get<{ tasks: TaskView[] }>(operator.projectPath('/tasks')),
      (r) => r.tasks.filter((t) => t.status === 'RUNNING').length === 2,
      'both parallel tasks to run',
    );
    const running = tasks.tasks.filter((t) => t.status === 'RUNNING');
    const backendTask = running.find((t) => t.role === 'backend') as TaskView;
    const frontendTask = running.find((t) => t.role === 'frontend') as TaskView;

    // §4: the frontend worker asks the backend role; Friday resolves it to be-1 and records it.
    const ask = await fe.client.call('communication.request', {
      to: 'role:backend',
      mode: 'request',
      subject: 'subscription status values',
      content: 'Need confirmation of subscription status values (reason: API compatibility).',
      task_id: frontendTask.task_id,
    });
    expect(ask).toMatchObject({ status: 'queued', note: 'role:backend reached be-1' });
    const backendInbox = await be.client.call('message.inbox', { max: 5 });
    const item = backendInbox.items[0] as InboxItem;
    expect(item).toMatchObject({
      message_id: ask.message_id,
      from: { agent_key: 'fe-1', role: 'frontend' },
      relationship: expect.stringContaining('you both work on goal'),
      sender_task: { task_id: frontendTask.task_id, write: frontendTask.scope?.write },
      trust: 'peer-untrusted',
    });
    // Minimal context: the contract's fields, the message itself, nothing from any session.
    expect(Object.keys(item).sort()).toEqual(
      [
        'attempt',
        'blocking',
        'body',
        'body_artifact_ref',
        'correlation_id',
        'delivery_id',
        'facts',
        'from',
        'in_reply_to',
        'message_id',
        'mode',
        'priority',
        'relationship',
        'reply_by',
        'reserved_until',
        'response_to',
        'sender_task',
        'sent_at',
        'state',
        'subject',
        'task_id',
        'trust',
      ].sort(),
    );
    await be.client.call('communication.request', {
      to: 'fe-1',
      mode: 'response',
      response_to: ask.message_id,
      content: 'Statuses are active, past_due and canceled.',
      facts: [{ fact: 'subscription status is one of active, past_due, canceled', area: 'billing' }],
      task_id: backendTask.task_id,
    });

    // §3: the backend asks what the frontend expects; the answer comes back correlated, with facts.
    const shape = await be.client.call('communication.request', {
      to: 'role:frontend',
      mode: 'request',
      subject: 'response shape',
      content: 'What response shape does the frontend now expect?',
      blocking: true,
      task_id: backendTask.task_id,
    });
    const frontInbox = await fe.client.call('message.inbox', { max: 5 });
    expect(frontInbox.items.map((i) => [i.mode, i.subject ?? i.in_reply_to]).sort()).toEqual([
      ['request', 'response shape'],
      ['response', 'subscription status values'],
    ]);
    await fe.client.call('message.ack', {
      ids: frontInbox.items.filter((i) => i.mode === 'response').map((i) => i.delivery_id),
    });
    await fe.client.call('communication.request', {
      to: 'be-1',
      mode: 'response',
      response_to: shape.message_id,
      content: 'shared/src/api.ts CheckoutResponse with { amount, currency, status }.',
      facts: [{ fact: 'the frontend reads CheckoutResponse from shared/src/api.ts', area: 'api' }],
      task_id: frontendTask.task_id,
    });
    const answer = (await be.client.call('message.inbox', { max: 5 })).items[0] as InboxItem;
    expect(answer).toMatchObject({
      mode: 'response',
      correlation_id: shape.correlation_id,
      in_reply_to: 'response shape',
      facts: [
        { fact: 'the frontend reads CheckoutResponse from shared/src/api.ts', status: 'unverified', source: 'fe-1' },
      ],
    });
    await be.client.call('message.ack', { ids: [answer.delivery_id] });

    // An agent with no related work is refused.
    const refused = await qa.client
      .call('communication.request', { to: 'be-1', mode: 'request', content: 'hi' })
      .catch((e: unknown) => e as FridayError);
    expect(refused).toBeInstanceOf(FridayError);
    expect((refused as FridayError).code).toBe('COS-3000');

    // The human's view: both requests settled by their replies.
    const listed = JSON.parse((await friday('--json', 'messages')).stdout) as MessageView[];
    const requests = listed.filter((m) => m.mode === 'request');
    expect(requests.map((m) => [m.subject, m.status, m.settled_reason])).toEqual([
      ['response shape', 'settled', 'replied'],
      ['subscription status values', 'settled', 'replied'],
    ]);
    // No message body is copied into any task, run or context packet.
    const events = await operator.get<{ events: { type: string; payload: unknown }[] }>(
      operator.projectPath('/events'),
      { query: { limit: '5000' } },
    );
    for (const e of events.events.filter((x) => !x.type.startsWith('communication.'))) {
      expect(JSON.stringify(e.payload)).not.toContain('Statuses are active, past_due and canceled');
    }

    // Replay equals live: from a snapshot plus the tail, and from the whole log.
    const snap = await friday('--json', 'events', 'snapshot');
    expect(snap.code, snap.stderr).toBe(0);
    const snapshotId = (JSON.parse(snap.stdout) as { snapshot_id: string }).snapshot_id;
    await fe.client.call('communication.request', { to: 'master', mode: 'notification', content: 'tail event' });
    const tail = await friday(
      'events',
      'replay',
      '--into',
      path.join(ws().root, 'replay-tail'),
      '--snapshot',
      snapshotId,
    );
    expect(tail.code, tail.stderr).toBe(0);
    expect(tail.stdout).toContain('Every table equals the live state.');
    const full = await friday('events', 'replay', '--into', path.join(ws().root, 'replay-full'));
    expect(full.stdout).toContain('Every table equals the live state.');
    const backup = await friday('backup', '--into', path.join(ws().root, 'backup'));
    expect(backup.code, backup.stderr).toBe(0);
    expect(existsSync(path.join(ws().root, 'backup', 'project.db'))).toBe(true);
    expect(JSON.parse(readFileSync(path.join(ws().root, 'backup', 'manifest.json'), 'utf8')).project_id).toBe(
      ref.project_id,
    );
  });
});
