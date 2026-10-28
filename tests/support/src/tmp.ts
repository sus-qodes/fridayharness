import type { ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { killTree, waitForExit } from './proc.js';

/** Windows MAX_PATH is 260; deep pnpm and git paths need headroom below the test root. */
export const MAX_TEST_ROOT_LENGTH = 80;

const repoRoot = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)));
export const ARTIFACTS_DIR = path.join(repoRoot, 'tests', '.artifacts');

export interface Closeable {
  close(): unknown;
}

type Tracked = { kind: 'process'; child: ChildProcess } | { kind: 'closeable'; resource: Closeable };

export interface TestWorkspace {
  /** Unique temp root, e.g. C:\Users\me\AppData\Local\Temp\fri-a1b2c3 */
  readonly root: string;
  /** A project directory inside the root. */
  readonly projectDir: string;
  /** `<projectDir>/.friday` */
  readonly fridayDir: string;
  /** Stand-in for the per-user private state dir (FRIDAY_STATE_DIR) so tests never touch the real one. */
  readonly stateDir: string;
  /** `<fridayDir>/project.db` */
  readonly dbPath: string;
  /** Registers a child process or closeable to be stopped, in reverse order, before the root is deleted. */
  track<T extends ChildProcess | Closeable>(resource: T): T;
  /** Keeps the directory on disk after cleanup (for debugging). */
  keep(reason?: string): void;
  readonly keptReason: string | null;
  cleanup(): Promise<{ removed: boolean }>;
}

function isChildProcess(value: unknown): value is ChildProcess {
  return (
    typeof value === 'object' &&
    value !== null &&
    'pid' in value &&
    typeof (value as ChildProcess).kill === 'function' &&
    typeof (value as ChildProcess).once === 'function'
  );
}

export async function createTestWorkspace(opts: { prefix?: string; base?: string } = {}): Promise<TestWorkspace> {
  const base = opts.base ?? process.env.FRIDAY_TEST_TMP ?? os.tmpdir();
  await mkdir(base, { recursive: true });
  const root = await mkdtemp(path.join(base, opts.prefix ?? 'fri-'));
  if (root.length > MAX_TEST_ROOT_LENGTH) {
    await rm(root, { recursive: true, force: true });
    throw new Error(
      `Test temp root is ${root.length} characters (limit ${MAX_TEST_ROOT_LENGTH}): ${root}. ` +
        'Set FRIDAY_TEST_TMP to a short directory such as C:\\t',
    );
  }
  const projectDir = path.join(root, 'p');
  const fridayDir = path.join(projectDir, '.friday');
  const stateDir = path.join(root, 's');
  await mkdir(fridayDir, { recursive: true });
  await mkdir(stateDir, { recursive: true });

  const tracked: Tracked[] = [];
  let keptReason: string | null = null;

  return {
    root,
    projectDir,
    fridayDir,
    stateDir,
    dbPath: path.join(fridayDir, 'project.db'),
    track(resource) {
      tracked.push(isChildProcess(resource) ? { kind: 'process', child: resource } : { kind: 'closeable', resource });
      return resource;
    },
    keep(reason = 'kept') {
      keptReason = reason;
    },
    get keptReason() {
      return keptReason;
    },
    async cleanup() {
      for (const item of tracked.splice(0).reverse()) {
        if (item.kind === 'process') {
          const { child } = item;
          if (child.exitCode === null && child.signalCode === null) {
            await killTree(child.pid);
            await waitForExit(child, 5_000).catch(() => undefined);
          }
        } else {
          try {
            await item.resource.close();
          } catch {
            // a resource that fails to close must not block deleting the workspace
          }
        }
      }
      if (keptReason) return { removed: false };
      try {
        // Retries absorb EBUSY/EPERM from antivirus scanners and just-released SQLite WAL handles on Windows.
        await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
        return { removed: true };
      } catch (err) {
        keptReason = `rm failed: ${(err as Error).message}`;
        console.warn(`[test-support] could not delete ${root}: ${keptReason}`);
        return { removed: false };
      }
    },
  };
}

function sanitize(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 60) || 'test';
}

/** Copies the workspace's `.friday/` directory (database, WAL, logs) to tests/.artifacts/<test>/. */
export async function saveArtifacts(ws: TestWorkspace, testName: string): Promise<string | null> {
  if (!existsSync(ws.fridayDir)) return null;
  const dest = path.join(ARTIFACTS_DIR, `${sanitize(testName)}-${path.basename(ws.root)}`);
  try {
    await cp(ws.fridayDir, dest, { recursive: true, force: true });
    return dest;
  } catch {
    return null;
  }
}

/**
 * Creates a fresh workspace before each test and deletes it after.
 * On failure the `.friday/` directory is copied to tests/.artifacts/, and with
 * FRIDAY_TEST_KEEP_ON_FAILURE=1 the whole workspace is kept on disk.
 */
export function useTestWorkspace(opts: { prefix?: string } = {}): () => TestWorkspace {
  let current: TestWorkspace | undefined;
  beforeEach(async () => {
    current = await createTestWorkspace(opts);
  });
  afterEach(async (ctx) => {
    const ws = current;
    current = undefined;
    if (!ws) return;
    if (ctx.task.result?.state === 'fail') {
      await saveArtifacts(ws, ctx.task.name);
      if (process.env.FRIDAY_TEST_KEEP_ON_FAILURE === '1') ws.keep('test failed');
    }
    await ws.cleanup();
  });
  return () => {
    if (!current) throw new Error('useTestWorkspace(): the workspace is only available inside a test');
    return current;
  };
}
