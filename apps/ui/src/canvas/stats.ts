/**
 * `+N −M` per task (plan §7.2): for the tasks on screen, when the dispatcher marked a task's line
 * counts stale after a write (`ui.staleStats`), or when there are none yet and the task has a run,
 * read `GET tasks/:tid/diff?stat=1` at most once per second per task, one request in flight per
 * task, and keep the sums in `ui.stats`. The canvas shows "—" until the answer comes. A stale mark
 * is cleared only when it did not change while the request ran, so a write during the read is
 * read again. A failed read waits `retryMs` before it is tried again, unless a newer write marks it.
 */
import type { TaskDiff } from '@friday/protocol';
import type { FridayApi } from '../api/client.js';
import type { FridayStore } from '../store/state.js';

export interface StatRefresherDeps {
  store: FridayStore;
  api: Pick<FridayApi, 'taskDiff'>;
  now(): number;
}

export interface StatRefresherOptions {
  minIntervalMs?: number;
  retryMs?: number;
}

/** Sums a stat diff's line counts (binary files count as nothing). */
export function sumStats(diff: Pick<TaskDiff, 'files'>): { added: number; removed: number; files: number } {
  let added = 0;
  let removed = 0;
  for (const f of diff.files ?? []) {
    added += typeof f.added === 'number' && Number.isFinite(f.added) ? f.added : 0;
    removed += typeof f.removed === 'number' && Number.isFinite(f.removed) ? f.removed : 0;
  }
  return { added, removed, files: (diff.files ?? []).length };
}

export class StatRefresher {
  readonly #deps: StatRefresherDeps;
  readonly #min: number;
  readonly #retry: number;
  readonly #inFlight = new Set<string>();
  readonly #lastRequest = new Map<string, number>();
  readonly #failedAt = new Map<string, { at: number; stale: number | undefined }>();
  readonly #files = new Map<string, number>();
  #visible: string[] = [];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #timerAt = Number.POSITIVE_INFINITY;
  #destroyed = false;

  constructor(deps: StatRefresherDeps, opts: StatRefresherOptions = {}) {
    this.#deps = deps;
    this.#min = opts.minIntervalMs ?? 1000;
    this.#retry = opts.retryMs ?? 30_000;
  }

  /** The tasks on screen (cards and pods' tasks); checks them at once. */
  setVisible(ids: Iterable<string>): void {
    this.#visible = [...new Set(ids)];
    this.check();
  }

  /** Changed files of the last answer for a task. */
  filesOf(taskId: string): number | null {
    return this.#files.get(taskId) ?? null;
  }

  /** True when the task's counts should be read (ignoring the throttle). */
  needs(taskId: string): boolean {
    const ui = this.#deps.store.select('ui');
    const board = this.#deps.store.select('board');
    const stale = ui.staleStats[taskId];
    const failed = this.#failedAt.get(taskId);
    if (failed && this.#deps.now() - failed.at < this.#retry && stale === failed.stale) return false;
    if (stale !== undefined) return true;
    return !ui.stats[taskId] && !!board?.runs[taskId];
  }

  check(): void {
    if (this.#destroyed) return;
    const now = this.#deps.now();
    let wait = Number.POSITIVE_INFINITY;
    for (const id of this.#visible) {
      if (this.#inFlight.has(id) || !this.needs(id)) continue;
      const last = this.#lastRequest.get(id);
      if (last !== undefined && now - last < this.#min) {
        wait = Math.min(wait, last + this.#min - now);
        continue;
      }
      this.#fire(id, now);
    }
    if (Number.isFinite(wait)) this.#schedule(now + wait);
  }

  destroy(): void {
    this.#destroyed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  #schedule(at: number): void {
    if (this.#timer && this.#timerAt <= at) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timerAt = at;
    this.#timer = setTimeout(
      () => {
        this.#timer = null;
        this.#timerAt = Number.POSITIVE_INFINITY;
        this.check();
      },
      Math.max(0, at - this.#deps.now()),
    );
  }

  #fire(id: string, now: number): void {
    const { store, api } = this.#deps;
    const staleSeen = store.select('ui').staleStats[id];
    this.#inFlight.add(id);
    this.#lastRequest.set(id, now);
    api
      .taskDiff(id, true)
      .then((diff) => {
        if (this.#destroyed) return;
        const sums = sumStats(diff);
        this.#files.set(id, sums.files);
        this.#failedAt.delete(id);
        const ui = store.select('ui');
        const staleStats = { ...ui.staleStats };
        if (staleStats[id] === staleSeen) delete staleStats[id];
        store.patch('ui', {
          stats: { ...ui.stats, [id]: { added: sums.added, removed: sums.removed, at: this.#deps.now() } },
          staleStats,
        });
      })
      .catch(() => {
        this.#failedAt.set(id, { at: this.#deps.now(), stale: staleSeen });
      })
      .finally(() => {
        this.#inFlight.delete(id);
        if (!this.#destroyed) this.check();
      });
  }
}
