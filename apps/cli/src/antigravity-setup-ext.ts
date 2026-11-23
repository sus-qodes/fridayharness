import type { DaemonContext, DaemonOptions } from '@friday/daemon';
import { type AntigravitySetupPlan, type AntigravitySetupResult, FridayError } from '@friday/protocol';
import { AGENT_KEY } from './agent-profiles.js';
import { runSetupCli, type SetupOptions } from './claude-setup-ext.js';

/**
 * Connecting Antigravity from the interface: the same `friday harness config antigravity` and
 * `harness doctor antigravity` a terminal runs, in a child process, previewed before anything is
 * written. It only writes the project's files. Nothing here starts Antigravity: its terms keep a
 * personal account to the Antigravity the person runs themselves, so it attaches when they open it.
 */

/** Antigravity's own name where the request gives none: never Claude Code's `dev-1` (2026-11-17). */
const DEFAULT_KEY = 'antigravity-1';

type App = Parameters<NonNullable<DaemonOptions['extensions']>[number]>[0];
interface Ctx {
  get(k: 'auth'): { token_class: string } | undefined;
  req: { json(): Promise<unknown>; query(k: string): string | undefined };
}

export function antigravitySetupExtension(opts: SetupOptions = {}) {
  return (app: App, ctx: DaemonContext) => {
    const P = `/api/v1/projects/${ctx.project.project_id}`;
    const run = opts.run ?? runSetupCli;
    const base = ['--project', ctx.project.root, '--json'];
    const requireOperator = (c: Ctx) => {
      if (c.get('auth')?.token_class !== 'operator') {
        throw new FridayError('token_scope_insufficient', 'setting up Antigravity needs the operator token');
      }
    };
    const keyOf = (v: unknown): string => {
      if (typeof v !== 'string' || !AGENT_KEY.test(v)) {
        throw new FridayError('invalid_request', 'agent key: lower-case letters, digits and dashes, at most 64');
      }
      return v;
    };
    const plan = async (agentKey: string, apply: boolean): Promise<AntigravitySetupPlan> => {
      const out = JSON.parse(
        await run([...base, 'harness', 'config', 'antigravity', `--agent=${agentKey}`, ...(apply ? [] : ['--print'])]),
      ) as Partial<Omit<AntigravitySetupPlan, 'agent_key'>>;
      return {
        agent_key: agentKey,
        applied: Boolean(out.applied),
        changes: out.changes ?? [],
        antigravity: out.antigravity ?? null,
      };
    };

    app.get(`${P}/agent-setup/antigravity`, async (c) => {
      requireOperator(c as unknown as Ctx);
      return c.json(await plan(keyOf(c.req.query('agent') ?? DEFAULT_KEY), false));
    });
    app.post(`${P}/agent-setup/antigravity`, async (c) => {
      requireOperator(c as unknown as Ctx);
      let body: { agent_key?: unknown };
      try {
        body = (await c.req.json()) as { agent_key?: unknown };
      } catch {
        throw new FridayError('invalid_request', 'the request body must be JSON');
      }
      const applied = await plan(keyOf(body.agent_key ?? DEFAULT_KEY), true);
      let doctor: AntigravitySetupResult['doctor'] = null;
      try {
        doctor = JSON.parse(
          await run([...base, 'harness', 'doctor', 'antigravity', '--quick']),
        ) as AntigravitySetupResult['doctor'];
      } catch (e) {
        doctor = { error: (e as Error).message };
      }
      const result: AntigravitySetupResult = { plan: applied, doctor };
      return c.json(result);
    });
    return undefined;
  };
}
