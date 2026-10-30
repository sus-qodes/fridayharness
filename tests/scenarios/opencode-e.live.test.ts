/**
 * OpenCode checkpoint E (plan M14.5): is a small model on this machine worth sending small tasks
 * to, and does Friday change that? Three task kinds of the fixture shop (tests/helpers/opencode-e.ts)
 * done two ways on the same pinned OpenCode and the same local model:
 *   plain   OpenCode alone: the same controlled profile, every call allowed, the task as its prompt;
 *           no packet, no verification, no second try;
 *   friday  the OpenCode worker under Friday: the task delivered with its packet, every call judged,
 *           the claim verified by the project's tests, a refused claim sent back once.
 * The same hidden checks judge both (tests/fixtures/opencode-e/acceptance.hidden.test.mjs). Recorded
 * per task: right on the first try, right in the end, attempts, seconds, and what the model calls
 * cost as OpenCode counted them (a local model: nothing paid).
 *
 * It runs only when the owner allows it, never in CI, with the variables of checkpoint C and
 *   FRIDAY_OPENCODE_E_OUT     a folder outside the repository for the results
 *   FRIDAY_OPENCODE_E_TASKS   which task kinds, comma-separated (all three)
 *   FRIDAY_OPENCODE_E_WAYS    which ways, comma-separated (plain,friday)
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { OpenCodeSpawnAdapter, OpenCodeWorker, openCodeOutcome } from '@friday/adapter-opencode';
import { materializeFixtureShop } from '@friday/cli';
import { createDaemon, type Daemon } from '@friday/daemon';
import type { TaskView, VerificationView } from '@friday/protocol';
import { DaemonClient } from '@friday/sdk';
import { useTestWorkspace } from '@friday/test-support';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cli, REPO_ROOT } from '../helpers/cli.js';
import { E_TASKS, judgeE, plainPrompt, prepareEShop } from '../helpers/opencode-e.js';
import { allEvents, outsideRepository } from '../helpers/token-baseline.js';

const LIVE = process.env.FRIDAY_OPENCODE_LIVE === '1';
const BIN = process.env.FRIDAY_OPENCODE_BIN;
const DEPS = process.env.FRIDAY_OPENCODE_DEPS_DIR;
const MODEL_URL = process.env.FRIDAY_OPENCODE_MODEL_URL ?? 'http://127.0.0.1:11434/v1';
const MODEL = process.env.FRIDAY_OPENCODE_MODEL ?? 'qwen2.5:7b';
const OUT = process.env.FRIDAY_OPENCODE_E_OUT;
const TASK_MS = 20 * 60_000;
/** Which task kinds and which ways run (all of them by default). */
const TASKS = E_TASKS.filter((t) => (process.env.FRIDAY_OPENCODE_E_TASKS ?? t.key).split(',').includes(t.key));
const WAYS = (process.env.FRIDAY_OPENCODE_E_WAYS ?? 'plain,friday').split(',').map((w) => w.trim());

if (!LIVE || !OUT)
  console.info(
    'OpenCode checkpoint E: skipped, FRIDAY_OPENCODE_LIVE or FRIDAY_OPENCODE_E_OUT is not set (docs/integration/opencode.md)',
  );

const ws = useTestWorkspace();
let saved: string | undefined;
beforeEach(() => {
  saved = process.env.FRIDAY_STATE_DIR;
  process.env.FRIDAY_STATE_DIR = ws().stateDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.FRIDAY_STATE_DIR;
  else process.env.FRIDAY_STATE_DIR = saved;
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!LIVE || !OUT)('OpenCode checkpoint E: small tasks on a local model, alone and under Friday', () => {
  it(
    'does each task kind both ways and judges the final code by the same hidden checks',
    async () => {
      if (!BIN || !DEPS) throw new Error('set FRIDAY_OPENCODE_BIN and FRIDAY_OPENCODE_DEPS_DIR');
      if (!OUT || !outsideRepository(OUT, REPO_ROOT))
        throw new Error('set FRIDAY_OPENCODE_E_OUT outside the repository');
      mkdirSync(OUT, { recursive: true });
      const profiles = path.join(ws().root, 'profiles');
      mkdirSync(profiles, { recursive: true });
      const results: Record<string, unknown> = {
        model: MODEL,
        model_url: MODEL_URL,
        started_at: new Date().toISOString(),
      };
      const save = () => writeFileSync(path.join(OUT, 'results.json'), `${JSON.stringify(results, null, 2)}\n`);
      const inference = { baseURL: MODEL_URL, model: MODEL };

      // OpenCode alone: one fresh copy of the shop per task, the task as the prompt, judged once.
      const plain: Record<string, unknown> = {};
      results.plain = plain;
      for (const t of WAYS.includes('plain') ? TASKS : []) {
        const { root } = materializeFixtureShop(path.join(ws().root, `plain-${t.key}`));
        await prepareEShop(root);
        const host = new OpenCodeSpawnAdapter({
          // OpenCode alone registers nothing; the client is never called.
          bootstrap: new DaemonClient({
            baseUrl: 'http://127.0.0.1:9',
            projectId: 'none',
            token: 'none',
            tokenClass: 'bootstrap',
          }),
          projectId: 'none',
          agentKey: 'plain',
          cwd: root,
          host: { command: BIN },
          dependenciesDir: DEPS,
          inference,
          workDir: profiles,
          hostEnv: { ...process.env },
          register: false,
          title: `plain ${t.key}`,
          check: async () => ({
            decision: 'allow',
            reason: 'OpenCode alone: every call allowed',
            rule: 'plain',
            approval_id: null,
          }),
        });
        const started = Date.now();
        let usage: Record<string, unknown> | null = null;
        let error: string | null = null;
        try {
          await host.start();
          usage = openCodeOutcome(await host.submitPrompt(plainPrompt(t), { timeoutMs: TASK_MS })).usage;
        } catch (e) {
          error = (e as Error).message;
        } finally {
          await host.close();
        }
        const v = judgeE(root);
        plain[t.key] = {
          right: v.tasks[t.key],
          project_tests: v.project,
          failed_checks: Object.entries(v.checks)
            .filter(([n, ok]) => n.startsWith(`${t.key}:`) && !ok)
            .map(([n]) => n),
          attempts: 1,
          seconds: Math.round((Date.now() - started) / 1000),
          usage,
          error,
        };
        save();
      }

      // Under Friday: one project, one worker, the tasks one after another.
      if (!WAYS.includes('friday')) return;
      const { root } = materializeFixtureShop(path.join(ws().root, 'friday'));
      await prepareEShop(root);
      const daemon: Daemon = await createDaemon({
        projectRoot: root,
        stateDir: ws().stateDir,
        tickMs: 500,
        pollIntervalMs: 50,
        logToFile: true,
        brain: { autoStart: false },
      });
      ws().track({ close: () => daemon.close('test cleanup') });
      const pid = daemon.project.project_id;
      const bootstrap = new DaemonClient({
        baseUrl: daemon.url,
        projectId: pid,
        token: daemon.tokens.bootstrap,
        tokenClass: 'bootstrap',
      });
      const logs: string[] = [];
      const worker = new OpenCodeWorker({
        bootstrap,
        projectId: pid,
        agentKey: 'oc-1',
        role: 'developer',
        host: { command: BIN },
        dependenciesDir: DEPS,
        inference,
        workDir: profiles,
        hostEnv: { ...process.env },
        turnTimeoutMs: TASK_MS,
        log: (m) => logs.push(`${new Date().toISOString()} ${m}`),
      });
      ws().track({ close: () => worker.close() });
      await worker.start();
      const friday = (...args: string[]) => cli(['--project', root, ...args]);
      const fridayJson = async <T>(...args: string[]): Promise<T> => {
        const r = await friday(...args, '--json');
        if (r.code !== 0) throw new Error(`friday ${args.join(' ')} failed (${r.code}): ${r.stderr || r.stdout}`);
        return JSON.parse(r.stdout) as T;
      };
      const task = (id: string): TaskView => daemon.state.q.task(pid, id);
      const ended = async (id: string) => {
        const end = Date.now() + TASK_MS + 60_000;
        for (;;) {
          const s = task(id).status;
          if (['READY_FOR_VERIFICATION', 'WAITING', 'FAILED', 'CANCELLED', 'HARNESS_LOST'].includes(s)) return s;
          if (Date.now() > end) return s;
          await sleep(1000);
        }
      };
      const underFriday: Record<string, unknown> = {};
      results.friday = underFriday;
      try {
        for (const t of TASKS) {
          const started = Date.now();
          const { task_id: id } = await fridayJson<TaskView>(
            'task',
            'create',
            t.summary,
            '--description',
            t.description,
            '--kind',
            t.kind,
            ...t.scope.write.flatMap((w) => ['--scope-write', w]),
            '--ready',
          );
          // Sent to the worker now: `--assign` on create only reserves, and no Master Brain runs here.
          await fridayJson('task', 'assign', id, '--agent', 'oc-1');
          const verdicts: { status: string; checks: { name: string; status: string; summary: string | null }[] }[] = [];
          let firstTry: boolean | null = null;
          for (let attempt = 1; attempt <= 2; attempt += 1) {
            const status = await ended(id);
            if (status !== 'READY_FOR_VERIFICATION') break;
            const v = await fridayJson<{ task: TaskView; verification: VerificationView }>('verify', id);
            verdicts.push({
              status: v.task.status,
              checks: v.verification.checks.map((c) => ({
                name: c.name,
                status: c.status,
                summary: c.summary ?? null,
              })),
            });
            if (attempt === 1) firstTry = v.task.status === 'COMPLETED';
            if (v.task.status !== 'FAILED' || attempt === 2) break;
            const failed = v.verification.checks
              .filter((c) => c.status !== 'PASSED')
              .map((c) => `${c.name}: ${c.summary ?? ''}`.slice(0, 300));
            await friday('task', 'rework', id, '--reason', `Verification failed. ${failed.join(' | ')}`.slice(0, 900));
            // Sent again: a reworked task waits for delegation, and no Master Brain runs here.
            await fridayJson('task', 'assign', id, '--agent', 'oc-1');
          }
          // The final code is the task's worktree, where its last attempt worked.
          const runs = daemon.state.q.runs(id);
          const worktree = runs.at(-1)?.execution_root;
          const v = judgeE(worktree && existsSync(worktree) ? worktree : root);
          underFriday[t.key] = {
            status: task(id).status,
            right_first_try: firstTry,
            right: v.tasks[t.key],
            project_tests: v.project,
            failed_checks: Object.entries(v.checks)
              .filter(([n, ok]) => n.startsWith(`${t.key}:`) && !ok)
              .map(([n]) => n),
            attempts: runs.length,
            seconds: Math.round((Date.now() - started) / 1000),
            verifications: verdicts,
            usage: allEvents(daemon.state.store, pid)
              .filter(
                (e) =>
                  e.type === 'agent.event' &&
                  (e.payload as { task_id?: string; event_type?: string }).task_id === id &&
                  (e.payload as { event_type?: string }).event_type === 'host.usage',
              )
              .map((e) => (e.payload as { data?: unknown }).data),
            decisions: allEvents(daemon.state.store, pid)
              .filter((e) => e.type === 'policy.evaluated' && (e.payload as { task_id?: string }).task_id === id)
              .map((e) => {
                const p = e.payload as { tool?: string; decision?: string; reason?: string };
                return { tool: p.tool, decision: p.decision, reason: p.reason };
              }),
          };
          save();
        }
      } finally {
        await worker.close().catch(() => undefined);
        results.logs = logs;
        results.ended_at = new Date().toISOString();
        save();
      }
      expect(Object.keys(underFriday)).toEqual(TASKS.map((t) => t.key));
    },
    120 * 60_000,
  );
});
