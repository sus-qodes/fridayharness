/**
 * OpenCode checkpoint D (plan M14.4): the worker lifecycle, live, with the pinned OpenCode 1.19.3 and
 * a model on this machine (the same server and variables as checkpoint C). A disposable repository
 * with git, a real daemon, one OpenCode worker of role backend. Three scenarios:
 * - a task from start to claim: delivered as one prompt with its packet, its calls judged for that
 *   task and run, the final answer recorded as the claim with the worktree's changed paths;
 * - a busy session cancelled: after its first allowed call the task is cancelled; the session must
 *   stop, and no call, file, claim or usage may follow the stop;
 * - the worker dies mid-task: its run is lost, a new worker of the same harness resumes it in a new
 *   session, under the authority of that moment, and claims it.
 * A scenario whose model made no call before the step it needs is recorded as not tried.
 *
 * It runs only when the owner allows it, never in CI:
 *   FRIDAY_OPENCODE_LIVE=1, FRIDAY_OPENCODE_BIN, FRIDAY_OPENCODE_DEPS_DIR, FRIDAY_OPENCODE_MODEL_URL,
 *   FRIDAY_OPENCODE_MODEL as for checkpoint C (docs/integration/opencode.md), and
 *   FRIDAY_OPENCODE_D_OUT     a folder outside the repository for the results
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OpenCodeWorker } from '@friday/adapter-opencode';
import type { TaskStartParams, TaskView } from '@friday/protocol';
import { useTestWorkspace } from '@friday/test-support';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/cli.js';
import { startTestDaemon, type TestDaemon } from '../helpers/daemon.js';
import { allEvents, outsideRepository } from '../helpers/token-baseline.js';

const LIVE = process.env.FRIDAY_OPENCODE_LIVE === '1';
const BIN = process.env.FRIDAY_OPENCODE_BIN;
const DEPS = process.env.FRIDAY_OPENCODE_DEPS_DIR;
const MODEL_URL = process.env.FRIDAY_OPENCODE_MODEL_URL ?? 'http://127.0.0.1:11434/v1';
const MODEL = process.env.FRIDAY_OPENCODE_MODEL ?? 'qwen2.5:7b';
const OUT = process.env.FRIDAY_OPENCODE_D_OUT;
/** One task may take this long on a processor: the model reads OpenCode's whole prompt. */
const TASK_MS = 20 * 60_000;

if (!LIVE || !OUT)
  console.info(
    'OpenCode checkpoint D: skipped, FRIDAY_OPENCODE_LIVE or FRIDAY_OPENCODE_D_OUT is not set (docs/integration/opencode.md)',
  );

const ws = useTestWorkspace();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until<T>(fn: () => T, ok: (v: T) => boolean, ms: number): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (ok(v)) return v;
    if (Date.now() > end) return null;
    await sleep(500);
  }
}

describe.skipIf(!LIVE || !OUT)('OpenCode checkpoint D: the worker lifecycle with a local model', () => {
  it(
    'takes a task to a claim, stops a cancelled session, and resumes a run after the worker dies',
    async () => {
      if (!BIN || !DEPS) throw new Error('set FRIDAY_OPENCODE_BIN and FRIDAY_OPENCODE_DEPS_DIR');
      if (!OUT || !outsideRepository(OUT, REPO_ROOT))
        throw new Error('set FRIDAY_OPENCODE_D_OUT outside the repository');
      mkdirSync(OUT, { recursive: true });
      const td: TestDaemon = await startTestDaemon(ws(), { git: true, brain: false });
      const pid = td.project.project_id;
      const profiles = path.join(ws().root, 'profiles');
      mkdirSync(profiles, { recursive: true });
      const logs: string[] = [];
      const worker = (key = 'opencode:live-d') => {
        const w = new OpenCodeWorker({
          bootstrap: td.bootstrap,
          projectId: pid,
          agentKey: 'oc-1',
          role: 'backend',
          harnessKey: key,
          host: { command: BIN },
          dependenciesDir: DEPS,
          inference: { baseURL: MODEL_URL, model: MODEL },
          workDir: profiles,
          hostEnv: { ...process.env },
          turnTimeoutMs: TASK_MS,
          log: (m) => logs.push(`${new Date().toISOString()} ${m}`),
        });
        ws().track({ close: () => w.close() });
        return w;
      };
      const task = (id: string): TaskView => td.daemon.state.q.task(pid, id);
      const create = async (summary: string, description: string) => {
        const t = await td.operator.post<TaskView>(td.operator.projectPath('/tasks'), {
          summary,
          description,
          scope: { write: ['src/**'], read: [] },
          ready: true,
        });
        await td.operator.post(td.operator.projectPath(`/tasks/${t.task_id}/assign`), { agent_key: 'oc-1' });
        return t.task_id;
      };
      const decisions = (id: string) =>
        allEvents(td.daemon.state.store, pid)
          .filter((e) => e.type === 'policy.evaluated' && (e.payload as { task_id?: string }).task_id === id)
          .map((e) => {
            const p = e.payload as { tool?: string; decision?: string; reason?: string; targets?: unknown };
            return { at: e.occurred_at, tool: p.tool, decision: p.decision, reason: p.reason, targets: p.targets };
          });
      const claimOf = (id: string) => td.daemon.state.q.runs(id).at(-1)?.claim ?? null;
      const usage = (id: string) =>
        allEvents(td.daemon.state.store, pid)
          .filter(
            (e) =>
              e.type === 'agent.event' &&
              (e.payload as { task_id?: string; event_type?: string }).task_id === id &&
              (e.payload as { event_type?: string }).event_type === 'host.usage',
          )
          .map((e) => (e.payload as { data?: unknown }).data);
      const files = (dir: string) =>
        existsSync(path.join(dir, 'src')) ? readdirSync(path.join(dir, 'src')).sort() : [];
      const results: Record<string, unknown> = {
        model: MODEL,
        model_url: MODEL_URL,
        started_at: new Date().toISOString(),
      };
      const save = () =>
        writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify({ ...results, logs }, null, 2)}\n`);
      const workDir = (w: OpenCodeWorker, id: string) =>
        (
          w.received.filter((m) => (m.params as TaskStartParams).task_id === id).at(-1)?.params as
            | TaskStartParams
            | undefined
        )?.working_directory ?? '';

      try {
        // 1. A task from start to claim.
        const one = worker();
        await one.start();
        const t1 = await create(
          'Create src/greeting.ts',
          "Create the file src/greeting.ts with exactly this one line: export const greeting = 'hello';",
        );
        const started1 = Date.now();
        const end1 = await until(
          () => task(t1).status,
          (s) => ['READY_FOR_VERIFICATION', 'WAITING', 'FAILED', 'CANCELLED', 'HARNESS_LOST'].includes(s),
          TASK_MS + 60_000,
        );
        const dir1 = workDir(one, t1);
        results.claim = {
          status: end1 ?? task(t1).status,
          seconds: Math.round((Date.now() - started1) / 1000),
          claim: claimOf(t1),
          files: files(dir1),
          decisions: decisions(t1),
          usage: usage(t1),
          verdict: end1 === 'READY_FOR_VERIFICATION' && files(dir1).includes('greeting.ts') ? 'passed' : 'failed',
        };
        save();

        // 2. A busy session cancelled after its first allowed call.
        const t2 = await create(
          'Create five numbered files',
          'Create five files, one at a time, each with one write: src/n1.ts containing export const n = 1; then src/n2.ts with export const n = 2; and so on up to src/n5.ts.',
        );
        const busy = await until(
          () => decisions(t2).filter((d) => d.decision === 'allow').length,
          (n) => n >= 1,
          TASK_MS,
        );
        if (busy === null) results.cancel = { verdict: 'not tried', status: task(t2).status, decisions: decisions(t2) };
        else {
          const run2 = task(t2).current_run_id as string;
          const dir2 = workDir(one, t2);
          await td.operator.post(td.operator.projectPath(`/tasks/${t2}/cancel`), { reason: 'not wanted any more' });
          await until(
            () => one.running(run2),
            (r) => !r,
            60_000,
          );
          const stoppedAt = new Date().toISOString();
          const filesAtStop = files(dir2);
          const callsAtStop = decisions(t2).length;
          // A minute in which nothing may happen: no call, no file, no claim, no usage.
          await sleep(60_000);
          const after = decisions(t2).filter((d) => d.at > stoppedAt);
          results.cancel = {
            stopped_at: stoppedAt,
            status: task(t2).status,
            calls_at_stop: callsAtStop,
            calls_after_stop: after,
            files_at_stop: filesAtStop,
            files_a_minute_later: files(dir2),
            claim: claimOf(t2),
            usage: usage(t2),
            verdict:
              task(t2).status === 'CANCELLED' &&
              after.length === 0 &&
              JSON.stringify(files(dir2)) === JSON.stringify(filesAtStop) &&
              !claimOf(t2) &&
              usage(t2).length === 0
                ? 'passed'
                : 'failed',
          };
        }
        save();

        // 3. The worker dies mid-task; a new one resumes the run in a new session.
        const t3 = await create(
          'Create three files',
          'Create three files, one at a time: src/m1.ts containing export const m = 1; then src/m2.ts with export const m = 2; then src/m3.ts with export const m = 3.',
        );
        const working = await until(
          () => decisions(t3).filter((d) => d.decision === 'allow').length,
          (n) => n >= 1,
          TASK_MS,
        );
        if (working === null)
          results.resume = { verdict: 'not tried', status: task(t3).status, decisions: decisions(t3) };
        else {
          const run3 = task(t3).current_run_id as string;
          const session1 = one.session(run3);
          const dir3 = workDir(one, t3);
          await one.crash();
          const lost = await until(
            () => task(t3).status,
            (s) => s === 'HARNESS_LOST',
            3 * 60_000,
          );
          const two = worker();
          await two.start();
          const resumed = await until(
            () => two.received.find((m) => m.method === 'task.resume'),
            (m) => Boolean(m),
            2 * 60_000,
          );
          const end3 = await until(
            () => task(t3).status,
            (s) => ['READY_FOR_VERIFICATION', 'WAITING', 'FAILED', 'CANCELLED'].includes(s),
            TASK_MS + 60_000,
          );
          const runs = td.daemon.state.q.runs(t3);
          results.resume = {
            lost: lost !== null,
            resumed: Boolean(resumed),
            same_run: runs.at(-1)?.run_id === run3,
            first_session: session1,
            resumed_session: runs.at(-1)?.session_ref ?? null,
            status: end3 ?? task(t3).status,
            claim: claimOf(t3),
            files: files(dir3),
            decisions: decisions(t3),
            usage: usage(t3),
            verdict:
              lost !== null && resumed && end3 === 'READY_FOR_VERIFICATION' && runs.at(-1)?.session_ref !== session1
                ? 'passed'
                : 'failed',
          };
          await two.close();
        }
        await one.close().catch(() => undefined);
      } finally {
        results.ended_at = new Date().toISOString();
        results.profiles_left = existsSync(profiles) ? readdirSync(profiles) : [];
        save();
      }
      const verdicts = ['claim', 'cancel', 'resume'].map(
        (k) => (results[k] as { verdict?: string } | undefined)?.verdict,
      );
      expect(verdicts.every((v) => v === 'passed' || v === 'not tried')).toBe(true);
      expect(results.profiles_left).toEqual([]);
    },
    90 * 60_000,
  );
});
