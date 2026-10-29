import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { FRIDAY_DIR_GITIGNORE } from '@friday/cli';
import { createDaemon, type Daemon, type DaemonOptions } from '@friday/daemon';
import { DaemonClient, type ProjectRef, renderInitialConfig } from '@friday/sdk';
import { deterministicGit, type FakeClock, type TestWorkspace } from '@friday/test-support';

/** Fixed, valid project id for tests (Crockford base32 suffix). */
export const TEST_PROJECT_ID = `proj_${'0'.repeat(24)}t1`;

export interface TestDaemon {
  daemon: Daemon;
  url: string;
  project: ProjectRef;
  operator: DaemonClient;
  bootstrap: DaemonClient;
  ws: TestWorkspace;
}

/** Writes `.friday/config.yaml` and `.friday/.gitignore` into the workspace project. */
export function initTestProject(
  ws: TestWorkspace,
  opts: { projectId?: string; extraConfig?: string; editConfig?: (yaml: string) => string } = {},
): void {
  mkdirSync(ws.fridayDir, { recursive: true });
  const yaml = renderInitialConfig(opts.projectId ?? TEST_PROJECT_ID, 'test-project') + (opts.extraConfig ?? '');
  writeFileSync(path.join(ws.fridayDir, 'config.yaml'), opts.editConfig ? opts.editConfig(yaml) : yaml);
  writeFileSync(path.join(ws.fridayDir, '.gitignore'), FRIDAY_DIR_GITIGNORE);
}

/**
 * Starts a real daemon (real HTTP on 127.0.0.1, real SQLite) for the workspace's project.
 * The lease timer is off by default so tests drive `daemon.tick()` with a FakeClock.
 */
export async function startTestDaemon(
  ws: TestWorkspace,
  opts: {
    clock?: FakeClock;
    git?: boolean;
    extraConfig?: string;
    /** Rewrites the generated config.yaml (to replace a block the template already has). */
    editConfig?: (yaml: string) => string;
    tickMs?: number;
    extensions?: DaemonOptions['extensions'];
    verify?: DaemonOptions['verify'];
    brain?: DaemonOptions['brain'];
    /** A built interface bundle to serve at /ui/ (M9). */
    uiDir?: string;
    /** The project is already a Friday project (`friday init` ran, or a restart): keep its config. */
    initialized?: boolean;
  } = {},
): Promise<TestDaemon> {
  if (!opts.initialized) {
    initTestProject(ws, {
      ...(opts.extraConfig ? { extraConfig: opts.extraConfig } : {}),
      ...(opts.editConfig ? { editConfig: opts.editConfig } : {}),
    });
  }
  if (opts.git) {
    writeFileSync(path.join(ws.projectDir, 'README.md'), '# test project\n');
    const git = deterministicGit(ws.projectDir);
    await git.init();
    await git.commitAll('init');
  }
  const daemon = await createDaemon({
    projectRoot: ws.projectDir,
    stateDir: ws.stateDir,
    tickMs: opts.tickMs ?? 0,
    pollIntervalMs: 25,
    logToFile: true,
    ...(opts.clock ? { clock: opts.clock } : {}),
    ...(opts.extensions ? { extensions: opts.extensions } : {}),
    ...(opts.verify ? { verify: opts.verify } : {}),
    ...(opts.brain !== undefined ? { brain: opts.brain } : {}),
    ...(opts.uiDir ? { uiDir: opts.uiDir } : {}),
  });
  ws.track({ close: () => daemon.close('test cleanup') });
  const base = { baseUrl: daemon.url, projectId: daemon.project.project_id };
  return {
    daemon,
    url: daemon.url,
    project: daemon.project,
    operator: new DaemonClient({ ...base, token: daemon.tokens.operator, tokenClass: 'operator' }),
    bootstrap: new DaemonClient({ ...base, token: daemon.tokens.bootstrap, tokenClass: 'bootstrap' }),
    ws,
  };
}

/** Raw HTTP request with full control over headers (fetch forbids overriding Host). */
export async function rawRequest(
  url: string,
  opts: { method?: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<{ status: number; json: unknown }> {
  const { request } = await import('node:http');
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request(
      { host: u.hostname, port: u.port, path: opts.path, method: opts.method ?? 'GET', headers: opts.headers ?? {} },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          let json: unknown = data;
          try {
            json = JSON.parse(data);
          } catch {
            // keep text
          }
          resolve({ status: res.statusCode ?? 0, json });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}
