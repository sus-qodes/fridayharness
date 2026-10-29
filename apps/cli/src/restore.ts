import { createHash } from 'node:crypto';
import { cpSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import {
  BACKUP_PREFIX,
  checkedOutBranches,
  GitRoot,
  isFridayRef,
  placeRef,
  RESTORED_PREFIX,
  type RefPlacement,
  readBundle,
  unbundle,
} from '@friday/git';
import { FridayError } from '@friday/protocol';
import { FRIDAY_DIR, type ProjectRef, readDiscovery } from '@friday/sdk';

/**
 * Restores a backup made by `friday backup` (M3.1, R08; review F16). The contract:
 * - Friday must not be running for the project;
 * - the backup must be this project's, complete, and match its manifest byte for byte;
 * - its code (format 2) goes into this clone first: the bundle's objects are stored, and its refs
 *   are added without moving any ref of the clone back (`placeRef`); a task worktree's uncommitted
 *   work goes under `refs/friday/restored/<task>`, for recovery to bring back;
 * - the current database (with its WAL files) and artifacts are set aside, never deleted, in
 *   `.friday/cache/pre-restore-<time>/`, and put back if the restore fails;
 * - a backup holds no credential, so after the next start every session registers again, and
 *   work whose session does not come back within its lease is recovered as after a crash.
 */

interface Manifest {
  format?: string;
  format_version?: number;
  project_id?: string;
  event_head?: number;
  schema_version?: number;
  created_at?: string;
  artifacts?: { path: string; bytes: number; sha256: string }[];
  code?: {
    included?: boolean;
    reason?: string;
    bundle?: string;
    sha256?: string;
    refs?: { ref: string; commit: string }[];
  };
}

export interface RestoreReport {
  project_id: string;
  from: string;
  event_head: number;
  schema_version: number;
  backup_created_at: string | null;
  artifacts: number;
  /** Where the state that was replaced now is, or null when there was none. */
  set_aside: string | null;
  /** What happened to the code the backup holds (review F16). */
  code: {
    included: boolean;
    /** Why the backup holds no code. */
    reason: string | null;
    /** Each of the backup's refs, as placed in this clone. */
    refs: RefPlacement[];
    /** Task worktrees whose uncommitted work the backup recorded, and the ref that holds it here. */
    uncommitted: { task_id: string; ref: string }[];
  };
}

async function hashFile(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** True when a daemon answers at the address the project's discovery file names. */
async function daemonRunning(ref: ProjectRef): Promise<boolean> {
  const d = readDiscovery(ref);
  if (!d) return false;
  try {
    await fetch(`http://127.0.0.1:${d.port}/health`, { signal: AbortSignal.timeout(1500) });
    return true;
  } catch {
    return false;
  }
}

const refuse = (message: string) => new FridayError('invalid_request', message);

export async function restoreProject(ref: ProjectRef, from: string, now: Date = new Date()): Promise<RestoreReport> {
  const src = path.resolve(from);
  const manifestFile = path.join(src, 'manifest.json');
  if (!existsSync(manifestFile)) throw refuse(`${src} has no manifest.json; it is not a Friday backup`);
  let m: Manifest;
  try {
    m = JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest;
  } catch (e) {
    throw refuse(`the manifest of ${src} cannot be read: ${(e as Error).message}`);
  }
  if (m.format !== 'friday-backup' || (m.format_version !== 1 && m.format_version !== 2)) {
    throw refuse(`${src} is not a Friday backup this version can restore (format ${m.format} ${m.format_version})`);
  }
  if (m.project_id !== ref.project_id) {
    throw refuse(`the backup belongs to project ${m.project_id}; this project is ${ref.project_id}`);
  }
  if (!existsSync(path.join(src, 'project.db'))) throw refuse(`${src} has no project.db`);
  const artifacts = m.artifacts ?? [];
  for (const a of artifacts) {
    if (a.path.split('/').some((part) => part === '..' || part === '')) {
      throw refuse(`the manifest names an artifact outside the backup: ${a.path}`);
    }
    const file = path.join(src, 'artifacts', ...a.path.split('/'));
    if (!existsSync(file)) throw refuse(`the backup is incomplete: artifacts/${a.path} is missing`);
    if ((await hashFile(file)) !== a.sha256) {
      throw refuse(`the backup is damaged: artifacts/${a.path} does not match its manifest`);
    }
  }
  // The code (review F16): checked completely before anything changes.
  const code = m.code?.included ? m.code : null;
  let bundleFile: string | null = null;
  let bundleRefs: { ref: string; commit: string }[] = [];
  let gitRoot: string | null = null;
  if (code) {
    const name = code.bundle ?? '';
    if (!name || name !== path.basename(name))
      throw refuse(`the manifest names a code bundle outside the backup: ${name}`);
    bundleFile = path.join(src, name);
    if (!existsSync(bundleFile)) throw refuse(`the backup is incomplete: ${name} is missing`);
    if ((await hashFile(bundleFile)) !== code.sha256) {
      throw refuse(`the backup is damaged: ${name} does not match its manifest`);
    }
    gitRoot = await GitRoot.open(ref.root)
      .then((r) => r.root)
      .catch(() => null);
    if (!gitRoot) {
      throw refuse(
        `the backup holds the project's code, but ${ref.root} is not a git repository: restore into a clone of the project`,
      );
    }
    bundleRefs = await readBundle(gitRoot, bundleFile);
    const listed = new Set((code.refs ?? []).map((r) => `${r.ref} ${r.commit}`));
    if (bundleRefs.length !== listed.size || bundleRefs.some((r) => !listed.has(`${r.ref} ${r.commit}`))) {
      throw refuse(`the backup is damaged: the refs of ${name} do not match its manifest`);
    }
    const foreign = bundleRefs.find((r) => !isFridayRef(r.ref));
    if (foreign) throw refuse(`the code bundle holds ${foreign.ref}, which is not one of Friday's refs`);
  }
  if (await daemonRunning(ref)) {
    throw refuse('Friday is running for this project; stop it first ("friday daemon stop")');
  }

  // The code goes in first. Refs are only added or moved forward, so a failure leaves the clone's
  // own refs as they were, and the database is not touched yet.
  const placed: RefPlacement[] = [];
  const uncommitted: { task_id: string; ref: string }[] = [];
  if (gitRoot && bundleFile) {
    try {
      await unbundle(gitRoot, bundleFile);
      const checkedOut = await checkedOutBranches(gitRoot);
      const stamp = now.toISOString().replace(/[:.]/g, '-');
      for (const r of bundleRefs) {
        // A worktree's uncommitted work is kept here until recovery brings it back.
        const target = r.ref.startsWith(BACKUP_PREFIX)
          ? `${RESTORED_PREFIX}${r.ref.slice(BACKUP_PREFIX.length)}`
          : r.ref;
        const p = await placeRef(gitRoot, target, r.commit, { checkedOut, stamp });
        placed.push(p);
        if (target !== r.ref) {
          const name = target.slice(RESTORED_PREFIX.length);
          uncommitted.push({ task_id: name.split('.')[0] ?? name, ref: p.stored_at ?? target });
        }
      }
    } catch (e) {
      const done = placed.filter((p) => p.outcome === 'created' || p.outcome === 'advanced' || p.stored_at);
      throw new FridayError(
        'internal_error',
        `the code could not be restored: ${(e as Error).message}; the database was not changed${
          done.length ? `; refs written so far: ${done.map((p) => p.stored_at ?? p.ref).join(', ')}` : ''
        }`,
      );
    }
  }

  const dir = path.join(ref.root, FRIDAY_DIR);
  const current = ['project.db', 'project.db-wal', 'project.db-shm', 'artifacts'].filter((n) =>
    existsSync(path.join(dir, n)),
  );
  // Set the current state aside first. A WAL file left next to a restored database would be
  // applied to it, so the -wal and -shm files move with their database.
  const aside = current.length
    ? path.join(dir, 'cache', `pre-restore-${now.toISOString().replace(/[:.]/g, '-')}`)
    : null;
  const moved: string[] = [];
  const putBack = () => {
    for (const n of ['project.db', 'artifacts']) rmSync(path.join(dir, n), { recursive: true, force: true });
    for (const n of moved.reverse()) renameSync(path.join(aside as string, n), path.join(dir, n));
  };
  try {
    if (aside) {
      mkdirSync(aside, { recursive: true });
      for (const n of current) {
        renameSync(path.join(dir, n), path.join(aside, n));
        moved.push(n);
      }
    }
    cpSync(path.join(src, 'project.db'), path.join(dir, 'project.db'));
    if (existsSync(path.join(src, 'artifacts'))) {
      cpSync(path.join(src, 'artifacts'), path.join(dir, 'artifacts'), { recursive: true });
    }
  } catch (e) {
    try {
      putBack();
    } catch {
      // Leave what is there; the error below names where the previous state is.
    }
    const where = aside ? `; the previous state is in ${aside}` : '';
    throw new FridayError('internal_error', `the restore failed: ${(e as Error).message}${where}`);
  }
  return {
    project_id: ref.project_id,
    from: src,
    event_head: m.event_head ?? 0,
    schema_version: m.schema_version ?? 0,
    backup_created_at: m.created_at ?? null,
    artifacts: artifacts.length,
    set_aside: aside,
    code: {
      included: code !== null,
      reason: code
        ? null
        : (m.code?.reason ??
          'this backup was made before backups held code (format 1): work that was only in the clone it came from is not in it'),
      refs: placed,
      uncommitted,
    },
  };
}
