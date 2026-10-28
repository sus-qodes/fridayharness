/**
 * Agent messaging from the operator's side (plan M3a, ADR-0017): a human talks to agents with
 * `friday say`, reads what waits for humans with `friday inbox human`, answers, and inspects
 * every message and delivery with `friday messages`.
 */
import type { InboxItem, MessageView, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli } from '../helpers/cli.js';
import { startTestDaemon } from '../helpers/daemon.js';
import { FakeHarness } from '../helpers/fake-harness.js';

const ws = useTestWorkspace();
let savedStateDir: string | undefined;
beforeEach(() => {
  savedStateDir = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (savedStateDir === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = savedStateDir;
});

describe('messaging from the CLI', () => {
  it('sends as a human, answers an agent, and shows messages with their deliveries', async () => {
    const td = await startTestDaemon(ws());
    const dir = ws().projectDir;
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    const task = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
      summary: 'Show prices',
      scope: { write: ['frontend/**'], read: [] },
      ready: true,
    });
    await td.operator.post(td.operator.projectPath(`/tasks/${task.task_id}/assign`), { agent_key: 'fe-1' });

    // A human reaches the frontend agent through its role.
    const said = await cli([
      '--project',
      dir,
      'say',
      'role:frontend',
      'Prices',
      'include',
      'VAT.',
      '--priority',
      'high',
    ]);
    expect(said.code, said.stderr).toBe(0);
    expect(said.stdout).toMatch(/queued for fe-1 \(role:frontend reached fe-1\)/);
    const got = await fe.client.call('message.inbox', { max: 5 });
    expect(got.items).toMatchObject([{ trust: 'human', priority: 'high', body: 'Prices include VAT.' }]);
    await fe.client.call('message.ack', { ids: [got.items[0]?.delivery_id as string] });

    // The agent asks a human; the human sees it, answers, and the request settles.
    const asked = await fe.client.call('communication.request', {
      to: 'human',
      mode: 'request',
      subject: 'rounding',
      content: 'Round VAT per line or on the total?',
      blocking: true,
      task_id: task.task_id,
    });
    const waiting = await cli(['--project', dir, '--json', 'inbox', 'human']);
    const items = JSON.parse(waiting.stdout) as InboxItem[];
    expect(items).toMatchObject([{ message_id: asked.message_id, blocking: true, from: { agent_key: 'fe-1' } }]);
    const human = await cli(['--project', dir, 'inbox', 'human']);
    expect(human.stdout).toContain('Round VAT per line or on the total?');
    const answer = await cli(['--project', dir, 'say', 'fe-1', 'Per', 'line.', '--reply-to', asked.message_id]);
    expect(answer.code, answer.stderr).toBe(0);
    const reply = await fe.client.call('message.inbox', { max: 5 });
    expect(reply.items).toMatchObject([{ mode: 'response', in_reply_to: 'rounding', body: 'Per line.' }]);

    const list = JSON.parse((await cli(['--project', dir, '--json', 'messages'])).stdout) as MessageView[];
    expect(list.map((m) => [m.mode, m.status])).toEqual([
      ['response', 'open'],
      ['request', 'settled'],
      ['notification', 'settled'],
    ]);
    const show = await cli(['--project', dir, 'messages', 'show', asked.message_id]);
    expect(show.stdout).toContain('settled (replied)');
    expect(show.stdout).toMatch(/human:human\s+acknowledged/);
    expect((await cli(['--project', dir, 'inbox', 'human'])).stdout).toContain('Nothing waiting.');

    // A notification to humans is acknowledged by hand.
    const note = await fe.client.call('communication.request', { to: 'human', mode: 'notification', content: 'FYI' });
    const acked = await cli(['--project', dir, 'messages', 'ack', note.message_id]);
    expect(acked.stdout).toContain('Acknowledged 1.');
    expect((await td.operator.get<MessageView>(td.operator.projectPath(`/messages/${note.message_id}`))).status).toBe(
      'settled',
    );
  });
});

describe('message authority over the protocol (M3.1, R02, R03)', () => {
  it('refuses response_to outside a response, and an acknowledgement from a shadow session', async () => {
    const td = await startTestDaemon(ws());
    const be = await FakeHarness.connect(td, { agentKey: 'be-1', key: 'fake:be-1', role: 'backend' });
    const fe = await FakeHarness.connect(td, { agentKey: 'fe-1', role: 'frontend' });
    const create = (summary: string, write: string, agent: string, dependsOn: string[] = []) =>
      td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
        summary,
        scope: { write: [write], read: [] },
        depends_on: dependsOn,
        assign_agent_key: agent,
      });
    const api = await create('API', 'backend/**', 'be-1');
    await create('Page', 'frontend/**', 'fe-1', [api.task_id]);
    const req = await fe.client.call('communication.request', {
      to: 'dependencies',
      mode: 'request',
      content: 'Does the API return the currency?',
      blocking: true,
    });

    // R02: a notification naming the request is refused by the protocol schema; the request stays open.
    await expect(
      fe.client.call('communication.request', {
        to: 'human',
        mode: 'notification',
        content: 'settled, trust me',
        response_to: req.message_id,
      }),
    ).rejects.toMatchObject({ code: 'COS-1001' });
    expect((await td.operator.get<MessageView>(td.operator.projectPath(`/messages/${req.message_id}`))).status).toBe(
      'open',
    );

    // R03: the backend session reads it; a second live session of be-1 is a shadow and cannot acknowledge it.
    const got = await be.client.call('message.inbox', { max: 5 });
    const delivery = got.items[0]?.delivery_id as string;
    const shadow = await FakeHarness.connect(td, { agentKey: 'be-1', key: 'fake:be-1:second', loop: false });
    expect(shadow.client.registration.shadow).toBe(true);
    await expect(shadow.client.call('message.ack', { ids: [delivery] })).rejects.toMatchObject({ code: 'COS-4006' });
    expect(await be.client.call('message.ack', { ids: [delivery] })).toMatchObject({ acknowledged: [delivery] });
    await shadow.close();
  });
});
