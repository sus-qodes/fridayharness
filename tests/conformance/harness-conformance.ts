/**
 * Harness adapter conformance suite (spec Part 11 §13, Part 14 §12). Every adapter must pass
 * these 11 cases against a real daemon. M1 runs it against FakeHarness; later adapters plug in
 * their own subject.
 */
import type { TaskView } from '@friday/protocol';
import type { FakeClock } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import type { TestDaemon } from '../helpers/daemon.js';
import type { FakeHarness } from '../helpers/fake-harness.js';

export interface ConformanceSubject {
  td: TestDaemon;
  clock: FakeClock;
  /** Attaches a harness of the adapter under test (spawn mode, delivery loop running). */
  attach(opts?: { key?: string; agentKey?: string }): Promise<FakeHarness>;
}

async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (ok(v)) return v;
    if (Date.now() > deadline)
      throw new Error(`condition not met within ${timeoutMs} ms: ${JSON.stringify(v).slice(0, 300)}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function runHarnessConformance(name: string, makeSubject: () => Promise<ConformanceSubject>): void {
  describe(`harness conformance: ${name}`, () => {
    const task = async (s: ConformanceSubject, id: string) =>
      (await s.td.operator.get<{ task: TaskView }>(s.td.operator.projectPath(`/tasks/${id}`))).task;
    const createAssigned = async (s: ConformanceSubject, h: FakeHarness, agentKey = 'dev-1') => {
      const t = await s.td.operator.post<TaskView>(s.td.operator.projectPath('/tasks'), {
        summary: 'conformance task',
        ready: true,
      });
      await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: agentKey });
      await h.waitFor('task.start');
      return eventually(
        () => task(s, t.task_id),
        (x) => x.status === 'RUNNING',
      );
    };

    it('1. registers and becomes READY', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const harness = await s.td.operator.get<{ status: string; vendor: string }>(
        s.td.operator.projectPath(`/harnesses/${h.harnessId}`),
      );
      expect(harness.status).toBe('READY');
      const events = await s.td.operator.get<{ events: { type: string }[] }>(s.td.operator.projectPath('/events'));
      expect(events.events.map((e) => e.type)).toContain('harness.registered');
    });

    it('2. declares capabilities that the daemon serves back verbatim', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const caps = { task_start: true, task_cancel: true, context_request: true, reconnect: true, streaming: false };
      await h.client.call('harness.capabilities', { capabilities: caps });
      const harness = await s.td.operator.get<{ capabilities: unknown }>(
        s.td.operator.projectPath(`/harnesses/${h.harnessId}`),
      );
      expect(harness.capabilities).toEqual(caps);
    });

    it('3. accepts a task: ASSIGNED → RUNNING after task.start is acknowledged', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const t = await createAssigned(s, h);
      expect(t.assigned_harness_id).toBe(h.harnessId);
    });

    it('4. receives context for its task in the Part 14 packet shape', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const t = await createAssigned(s, h);
      const packet = await h.client.requestContext({ task_id: t.task_id });
      expect(packet).toMatchObject({
        project_id: s.td.project.project_id,
        task_id: t.task_id,
        staleness: { is_stale: false },
      });
      expect(packet.sections.map((x) => x.kind)).toEqual(
        expect.arrayContaining(['task.contract', 'protocol.reminder']),
      );
      for (const section of packet.sections)
        for (const src of section.sources) expect(src.selection_reason).toBeTruthy();
    });

    it('5. emits progress that is stored with its task and run', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const t = await createAssigned(s, h);
      const res = await h.client.emitEvent({
        task_id: t.task_id,
        run_id: t.current_run_id as string,
        event_type: 'tool.completed',
        summary: 'ran tests',
      });
      const events = await s.td.operator.get<{ events: { event_id: string; payload: Record<string, unknown> }[] }>(
        s.td.operator.projectPath(`/tasks/${t.task_id}/events`),
      );
      const stored = events.events.find((e) => e.event_id === res.event_id);
      expect(stored?.payload).toMatchObject({
        task_id: t.task_id,
        run_id: t.current_run_id,
        event_type: 'tool.completed',
      });
    });

    it('6. requests context and the request is recorded with provenance', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const t = await createAssigned(s, h);
      const packet = await h.client.requestContext({ task_id: t.task_id, kind: 'task' });
      const events = await s.td.operator.get<{
        events: { type: string; payload: { packet?: { context_id: string } } }[];
      }>(s.td.operator.projectPath(`/tasks/${t.task_id}/events`));
      const compiled = events.events
        .filter((e) => e.type === 'context.compiled')
        .map((e) => e.payload.packet?.context_id);
      expect(compiled).toContain(packet.context_id);
    });

    it('7. requests permission and cannot approve it itself', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const res = await h.client.requestPermission({
        action_class: 'network.read',
        resource: 'api.stripe.com',
        justification: 'integration test',
      });
      expect(res.status).toBe('pending');
      const self = await fetch(`${s.td.url}${s.td.operator.projectPath(`/approvals/${res.approval_id}/approve`)}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${h.token}` },
      });
      expect(self.status).toBe(403);
      expect(((await self.json()) as { error: { code: string } }).error.code).toBe('COS-3006');
      const bogus = await h.rawRpc('approval.decide', { approval_id: res.approval_id });
      expect((bogus.body.error as { data: { code: string } }).data.code).toBe('COS-1000');
    });

    it('8. reports a result: a completion claim moves the task to READY_FOR_VERIFICATION, never COMPLETED', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const t = await createAssigned(s, h);
      const out = await h.client.reportResult({
        task_id: t.task_id,
        run_id: t.current_run_id as string,
        status: 'completed_claim',
        summary: 'done',
      });
      expect(out.task_status).toBe('READY_FOR_VERIFICATION');
      expect((await task(s, t.task_id)).status).toBe('READY_FOR_VERIFICATION');
    });

    it('9. is told to cancel and the task ends CANCELLED', async () => {
      const s = await makeSubject();
      const h = await s.attach();
      const t = await createAssigned(s, h);
      await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/cancel`), { reason: 'not needed' });
      const msg = await h.waitFor('task.cancel');
      expect(msg.params).toMatchObject({ task_id: t.task_id, run_id: t.current_run_id });
      expect((await task(s, t.task_id)).status).toBe('CANCELLED');
    });

    it('10. reconnects after losing its lease and resumes the same run', async () => {
      const s = await makeSubject();
      const h = await s.attach({ key: 'reconnecting-harness' });
      const t = await createAssigned(s, h);
      await h.crash();
      s.clock.advance(31_000);
      s.td.daemon.tick();
      expect((await task(s, t.task_id)).status).toBe('HARNESS_LOST');
      await h.reconnect();
      await h.waitFor('task.resume');
      const resumed = await eventually(
        () => task(s, t.task_id),
        (x) => x.status === 'RUNNING',
      );
      expect(resumed.current_run_id).toBe(t.current_run_id);
    });

    it('11. preserves task and run identity across events and attempts', async () => {
      const s = await makeSubject();
      const h = await s.attach({ key: 'identity-1' });
      const t = await createAssigned(s, h);
      await h.client.emitEvent({ task_id: t.task_id, run_id: t.current_run_id as string, event_type: 'progress' });
      const events = await s.td.operator.get<{ events: { type: string; payload: Record<string, unknown> }[] }>(
        s.td.operator.projectPath(`/tasks/${t.task_id}/events`),
      );
      const runIds = new Set(events.events.map((e) => e.payload.run_id).filter(Boolean));
      expect([...runIds]).toEqual([t.current_run_id]);
      // A new session for the same agent continues the work as attempt 2 of the same task.
      await h.crash();
      s.clock.advance(31_000);
      s.td.daemon.tick();
      await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/release`), { reason: 'reassign' });
      const h2 = await s.attach({ key: 'identity-2' });
      await s.td.operator.post(s.td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'dev-1' });
      await h2.waitFor('task.start');
      const again = await eventually(
        () => task(s, t.task_id),
        (x) => x.status === 'RUNNING',
      );
      expect(again.task_id).toBe(t.task_id);
      const detail = await s.td.operator.get<{ runs: { attempt: number }[] }>(
        s.td.operator.projectPath(`/tasks/${t.task_id}`),
      );
      expect(detail.runs.map((r) => r.attempt)).toEqual([1, 2]);
    });
  });
}
