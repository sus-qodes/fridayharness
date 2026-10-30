import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { BuildProgress } from '@friday/code-graph';
import { GitRoot } from '@friday/git';
import type { Actor } from '@friday/protocol';
import { FRIDAY_DIR, type ProjectRef } from '@friday/sdk';
import type { FridayState } from '@friday/state';
import { GraphService } from './graph-service.js';
import type { Logger } from './log.js';

/**
 * A project's one-time setup: the code graph is built when the project is initialized, so the
 * Studio and the first agent start from a ready graph instead of waiting for it; from then on
 * the graph follows the checkout (the Merkle tree and the facts cache, ADR-0037 §2). `friday init`
 * runs the build in the terminal and writes the record; a daemon that finds no record (a project
 * initialized without one, or with `setup.graph: false` and then turned on) runs it once at start
 * and records the same lines as observations, so a setup screen shows them as they happen.
 */

export const SETUP_FILE = 'setup.json';
export const SETUP_ACTOR: Actor = { kind: 'system', id: 'setup' };

export type SetupStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped';

export interface GraphSetupStats {
  files: number;
  edges: number;
  symbols: number;
  skipped: number;
  ms: number;
}

export interface GraphSetupStep {
  status: SetupStatus;
  /** The progress lines, in order, as a setup screen shows them. */
  lines: string[];
  started_at: string | null;
  finished_at: string | null;
  stats: GraphSetupStats | null;
  tree_hash: string | null;
  /** Why it failed or was skipped. */
  reason: string | null;
}

export interface SetupRecord {
  schema_version: 1;
  graph: GraphSetupStep;
}

export function setupRecordPath(projectRoot: string): string {
  return path.join(projectRoot, FRIDAY_DIR, 'graph', SETUP_FILE);
}

/** The record `friday init` or the daemon wrote, or null when none exists or it cannot be read. */
export function readSetupRecord(projectRoot: string): SetupRecord | null {
  const file = setupRecordPath(projectRoot);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<SetupRecord>;
    if (parsed.schema_version !== 1 || typeof parsed.graph !== 'object' || parsed.graph === null) return null;
    return parsed as SetupRecord;
  } catch {
    return null;
  }
}

/** Written whole: a temporary file renamed over the record, so a reader never sees half of it. */
export function writeSetupRecord(projectRoot: string, record: SetupRecord): void {
  const file = setupRecordPath(projectRoot);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
  renameSync(tmp, file);
}

const emptyStep = (): GraphSetupStep => ({
  status: 'pending',
  lines: [],
  started_at: null,
  finished_at: null,
  stats: null,
  tree_hash: null,
  reason: null,
});

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

const count = (n: number) => n.toLocaleString('en-US');

/**
 * Turns the builder's progress into the lines a person reads: one when the files are listed, one
 * at every tenth of the reading and at its end, one when resolution starts, one when the graph is
 * ready. Nothing in between, so a terminal and a setup screen stay short.
 */
export class ProgressLines {
  #lastTenth = -1;

  line(p: BuildProgress): string | null {
    switch (p.phase) {
      case 'listing':
        return `Listing files: ${count(p.files)} source files`;
      case 'reading': {
        const tenth = p.total === 0 ? 10 : Math.floor((p.done * 10) / p.total);
        if (tenth <= this.#lastTenth && p.done < p.total) return null;
        this.#lastTenth = tenth;
        const detail = [
          p.parsed ? `${count(p.parsed)} parsed` : '',
          p.cached ? `${count(p.cached)} from the cache` : '',
          p.unchanged ? `${count(p.unchanged)} unchanged` : '',
        ]
          .filter(Boolean)
          .join(', ');
        return `Reading files: ${count(p.done)}/${count(p.total)}${detail ? ` (${detail})` : ''}`;
      }
      case 'resolving':
        return `Resolving imports and symbols across ${count(p.files)} files`;
      case 'done':
        return `Code graph ready: ${count(p.files)} files, ${count(p.edges)} imports, ${count(p.symbols)} symbols in ${seconds(p.ms)}${p.skipped ? ` (${count(p.skipped)} skipped)` : ''}`;
    }
  }
}

export interface BuildProjectGraphOptions {
  /** The project's root (where `.friday/` is). */
  projectRoot: string;
  /** Each progress line as it happens. */
  onLine?: (line: string) => void;
  /** A graph service to build with (the daemon's own); else one is opened on `.friday/graph` and closed after. */
  graph?: GraphService;
  now?: () => Date;
}

/**
 * Builds the project's code graph once and records the outcome in `.friday/graph/setup.json`.
 * Never throws: a folder without git is `skipped`, a build error is `failed`, each with its reason
 * in the record, because a project is usable without the graph (it is then built on first use).
 */
export async function buildProjectGraph(opts: BuildProjectGraphOptions): Promise<GraphSetupStep> {
  const now = opts.now ?? (() => new Date());
  const step = emptyStep();
  step.status = 'running';
  step.started_at = now().toISOString();
  const say = (line: string) => {
    step.lines.push(line);
    opts.onLine?.(line);
  };
  const finish = (status: SetupStatus, reason: string | null): GraphSetupStep => {
    step.status = status;
    step.reason = reason;
    step.finished_at = now().toISOString();
    writeSetupRecord(opts.projectRoot, { schema_version: 1, graph: step });
    return step;
  };
  say('Building the code graph');
  let root: GitRoot;
  try {
    root = await GitRoot.open(opts.projectRoot);
  } catch {
    say('No git repository here yet: the code graph is built once the repository has git');
    return finish('skipped', 'not a git repository');
  }
  const service =
    opts.graph ?? new GraphService({ root: root.root, cacheDir: path.join(opts.projectRoot, FRIDAY_DIR, 'graph') });
  const lines = new ProgressLines();
  try {
    const graph = await service.graph(root.root, undefined, {
      onProgress: (p) => {
        const line = lines.line(p);
        if (line) say(line);
        if (p.phase === 'done') {
          step.stats = { files: p.files, edges: p.edges, symbols: p.symbols, skipped: p.skipped, ms: p.ms };
        }
      },
    });
    step.tree_hash = graph.treeHash;
    return finish('done', null);
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    say(`The code graph could not be built: ${message}`);
    return finish('failed', message);
  } finally {
    if (!opts.graph) service.close();
  }
}

export interface SetupStatusView {
  /** `done` once every step that applies has finished. */
  state: SetupStatus;
  graph: GraphSetupStep;
}

/**
 * The daemon's side: serves the setup status and runs the graph build once when the project has
 * no record yet and `setup.graph` is on, recording every line as an observation.
 */
export class SetupManager {
  #graph: GraphSetupStep;
  #running: Promise<void> | null = null;
  #stopped = false;

  constructor(
    private readonly opts: {
      state: FridayState;
      project: ProjectRef;
      graph: GraphService;
      logger: Logger;
      enabled: () => boolean;
    },
  ) {
    this.#graph = readSetupRecord(opts.project.root)?.graph ?? emptyStep();
  }

  status(): SetupStatusView {
    const g = this.#graph;
    return { state: g.status === 'pending' ? (this.opts.enabled() ? 'pending' : 'skipped') : g.status, graph: g };
  }

  /** Whether a build must run now: no finished record and the setting is on. */
  needed(): boolean {
    return this.opts.enabled() && (this.#graph.status === 'pending' || this.#graph.status === 'failed');
  }

  /** Runs the build in the background when it is needed; resolves when it has finished. */
  start(): Promise<void> {
    if (this.#running) return this.#running;
    if (this.#stopped || !this.needed()) return Promise.resolve();
    this.#running = this.run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  /**
   * No build starts from here on; a build in flight is waited for, within the bound, so the
   * daemon never closes the graph's stores under it. True when nothing is running any more.
   */
  async stop(boundMs = 30_000): Promise<boolean> {
    this.#stopped = true;
    if (!this.#running) return true;
    const done = await Promise.race([
      this.#running.then(() => true),
      new Promise<boolean>((r) => setTimeout(() => r(false), boundMs).unref()),
    ]);
    return done;
  }

  private observe(type: string, payload: Record<string, unknown>): void {
    try {
      this.opts.state.recordObservation(this.opts.project.project_id, SETUP_ACTOR, type, { step: 'graph', ...payload });
    } catch (e) {
      this.opts.logger.warn('setup observation not recorded', { message: (e as Error).message });
    }
  }

  private async run(): Promise<void> {
    this.observe('setup.started', {});
    this.#graph = await buildProjectGraph({
      projectRoot: this.opts.project.root,
      graph: this.opts.graph,
      onLine: (line) => {
        this.#graph = { ...this.#graph, status: 'running', lines: [...this.#graph.lines, line] };
        this.observe('setup.progress', { line });
      },
    });
    if (this.#graph.status === 'done') {
      this.observe('setup.completed', { stats: this.#graph.stats, tree_hash: this.#graph.tree_hash });
      this.opts.logger.info('code graph built at setup', { ...this.#graph.stats });
    } else {
      this.observe('setup.failed', { status: this.#graph.status, reason: this.#graph.reason });
      this.opts.logger.warn('code graph not built at setup', {
        status: this.#graph.status,
        reason: this.#graph.reason,
      });
    }
  }
}
