import { execFile } from 'node:child_process';
import { tmpdir } from 'node:os';
import type { DaemonContext, DaemonOptions } from '@friday/daemon';
import { type ClaudeSetupPlan, type ClaudeSetupResult, FridayError } from '@friday/protocol';
import { cliEntry } from './agent-launcher.js';
import { AGENT_KEY } from './agent-profiles.js';

/**
 * Connecting Claude Code in VS Code from the interface (plan M9 §5.10): the same
 * `friday harness config claude-code` and `harness doctor claude-code` a terminal runs, in a child
 * process (never on the daemon's event loop), previewed before anything is written.
 */

type App = Parameters<NonNullable<DaemonOptions['extensions']>[number]>[0];
interface Ctx {
  get(k: 'auth'): { token_class: string } | undefined;
  req: { json(): Promise<unknown>; query(k: string): string | undefined };
}

export interface SetupOptions {
  /** Runs the CLI with these arguments and answers its standard output (tests inject it). */
  run?: (args: string[]) => Promise<string>;
}

function runCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [cliEntry(), ...args],
      { cwd: tmpdir(), windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        // The doctor exits 1 when a check fails; its JSON is still the answer.
        if (stdout.trim().startsWith('{')) resolve(stdout);
        else reject(new FridayError('internal_error', (stderr || err?.message || 'no answer').slice(0, 500)));
      },
    );
  });
}

export function claudeSetupExtension(opts: SetupOptions = {}) {
  return (app: App, ctx: DaemonContext) => {
    const pid = ctx.project.project_id;
    const P = `/api/v1/projects/${pid}`;
    const run = opts.run ?? runCli;
    const base = ['--project', ctx.project.root, '--json'];
    const requireOperator = (c: Ctx) => {
      if (c.get('auth')?.token_class !== 'operator') {
        throw new FridayError('token_scope_insufficient', 'setting up Claude Code needs the operator token');
      }
    };
    const keyOf = (v: unknown): string => {
      if (typeof v !== 'string' || !AGENT_KEY.test(v)) {
        throw new FridayError('invalid_request', 'agent key: lower-case letters, digits and dashes, at most 64');
      }
      return v;
    };
    const plan = async (agentKey: string, apply: boolean): Promise<ClaudeSetupPlan> => {
      const out = JSON.parse(
        await run([...base, 'harness', 'config', 'claude-code', `--agent=${agentKey}`, ...(apply ? [] : ['--print'])]),
      ) as Omit<ClaudeSetupPlan, 'agent_key'>;
      return {
        agent_key: agentKey,
        applied: Boolean(out.applied),
        changes: out.changes ?? [],
        claude_code: out.claude_code ?? null,
      };
    };

    app.get(`${P}/agent-setup/claude-code`, async (c) => {
      requireOperator(c as unknown as Ctx);
      return c.json(await plan(keyOf(c.req.query('agent') ?? 'dev-1'), false));
    });
    app.post(`${P}/agent-setup/claude-code`, async (c) => {
      requireOperator(c as unknown as Ctx);
      let body: { agent_key?: unknown };
      try {
        body = (await c.req.json()) as { agent_key?: unknown };
      } catch {
        throw new FridayError('invalid_request', 'the request body must be JSON');
      }
      const applied = await plan(keyOf(body.agent_key ?? 'dev-1'), true);
      let doctor: ClaudeSetupResult['doctor'] = null;
      try {
        doctor = JSON.parse(
          await run([...base, 'harness', 'doctor', 'claude-code', '--quick']),
        ) as ClaudeSetupResult['doctor'];
      } catch (e) {
        doctor = { error: (e as Error).message };
      }
      const result: ClaudeSetupResult = { plan: applied, doctor };
      return c.json(result);
    });
    return undefined;
  };
}
