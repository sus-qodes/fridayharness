import { describe, expect, it } from 'vitest';
import { antigravitySetupExtension } from './antigravity-setup-ext.js';

type Handler = (c: unknown) => Promise<unknown>;

const ROOT = 'C:/work/shop';
const P = '/api/v1/projects/proj_1/agent-setup/antigravity';
const PLAN = {
  host: 'antigravity',
  applied: false,
  changes: [{ path: '.agents/hooks.json', action: 'create', tracked: true, note: 'Friday hooks', diff: '+ {}' }],
  antigravity: { cli: { binary: 'agy.exe', version: '1.4.4' }, app: null, hook_level: 'unverified' },
};

/** The extension on a stand-in for the daemon's app: its routes, and every CLI run it asked for. */
function mount(answer: (args: string[]) => string | Error) {
  const routes = new Map<string, Handler>();
  const runs: string[][] = [];
  const app = {
    get: (path: string, h: Handler) => routes.set(`GET ${path}`, h),
    post: (path: string, h: Handler) => routes.set(`POST ${path}`, h),
  };
  const run = async (args: string[]) => {
    runs.push(args);
    const a = answer(args);
    if (a instanceof Error) throw a;
    return a;
  };
  antigravitySetupExtension({ run })(app as never, { project: { project_id: 'proj_1', root: ROOT } } as never);
  const call = (
    route: string,
    opts: { token?: string; query?: Record<string, string>; body?: unknown; badJson?: boolean } = {},
  ) => {
    const handler = routes.get(route);
    if (!handler) throw new Error(`no route ${route}`);
    return handler({
      get: () => ({ token_class: opts.token ?? 'operator' }),
      req: {
        query: (k: string) => opts.query?.[k],
        json: async () => {
          if (opts.badJson) throw new SyntaxError('not JSON');
          return opts.body ?? {};
        },
      },
      json: (v: unknown) => v,
    });
  };
  return { routes, runs, call };
}

describe('connecting Antigravity from the interface', () => {
  it('serves a preview and an apply, and nothing that starts Antigravity', () => {
    const { routes } = mount(() => JSON.stringify(PLAN));
    expect([...routes.keys()].sort()).toEqual([`GET ${P}`, `POST ${P}`]);
  });

  it('previews with --print, for the agent key asked for', async () => {
    const { runs, call } = mount(() => JSON.stringify(PLAN));
    expect(await call(`GET ${P}`, { query: { agent: 'ag-2' } })).toEqual({
      agent_key: 'ag-2',
      applied: false,
      changes: PLAN.changes,
      antigravity: PLAN.antigravity,
    });
    expect(runs).toEqual([
      ['--project', ROOT, '--json', 'harness', 'config', 'antigravity', '--agent=ag-2', '--print'],
    ]);
    // No key given: Antigravity's own name, never the `dev-1` Claude Code in VS Code works under.
    await call(`GET ${P}`);
    expect(runs[1]).toContain('--agent=antigravity-1');
  });

  it('applies, then asks the doctor, and runs only Friday’s own harness commands', async () => {
    const { runs, call } = mount((args) =>
      args.includes('doctor')
        ? JSON.stringify({ achieved: 'not attached', checks: [{ id: 'ag.binary', status: 'ok', message: 'found' }] })
        : JSON.stringify({ ...PLAN, applied: true }),
    );
    expect(await call(`POST ${P}`, { body: { agent_key: 'dev-1' } })).toEqual({
      plan: { agent_key: 'dev-1', applied: true, changes: PLAN.changes, antigravity: PLAN.antigravity },
      doctor: { achieved: 'not attached', checks: [{ id: 'ag.binary', status: 'ok', message: 'found' }] },
    });
    expect(runs).toEqual([
      ['--project', ROOT, '--json', 'harness', 'config', 'antigravity', '--agent=dev-1'],
      ['--project', ROOT, '--json', 'harness', 'doctor', 'antigravity', '--quick'],
    ]);
  });

  it('keeps the applied plan when the doctor gives no answer', async () => {
    const { call } = mount((args) =>
      args.includes('doctor') ? new Error('timed out') : JSON.stringify({ ...PLAN, applied: true }),
    );
    expect(await call(`POST ${P}`, { body: {} })).toMatchObject({
      plan: { agent_key: 'antigravity-1', applied: true },
      doctor: { error: 'timed out' },
    });
  });

  it('fills what an older CLI leaves out', async () => {
    const { call } = mount(() => '{}');
    expect(await call(`GET ${P}`)).toEqual({
      agent_key: 'antigravity-1',
      applied: false,
      changes: [],
      antigravity: null,
    });
  });

  it('refuses another token class, a bad agent key and a body that is not JSON, before running anything', async () => {
    const { runs, call } = mount(() => JSON.stringify(PLAN));
    await expect(call(`GET ${P}`, { token: 'harness' })).rejects.toThrow(/operator token/);
    await expect(call(`POST ${P}`, { token: 'ui' })).rejects.toThrow(/operator token/);
    await expect(call(`GET ${P}`, { query: { agent: 'Bad Key' } })).rejects.toThrow(/agent key/);
    await expect(call(`POST ${P}`, { body: { agent_key: '--print' } })).rejects.toThrow(/agent key/);
    await expect(call(`POST ${P}`, { badJson: true })).rejects.toThrow(/must be JSON/);
    expect(runs).toEqual([]);
  });
});
