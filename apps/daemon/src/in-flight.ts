/**
 * Work the daemon started and has not finished: integrations, task worktree jobs. The daemon's
 * shutdown waits for it, within a bound, so no git process it started outlives it in the user's
 * checkout, and nothing it records finds the database already closed.
 */
export class InFlight {
  readonly #jobs = new Set<Promise<unknown>>();

  /** Tracks one piece of work until it settles; returns it unchanged. */
  track<T>(job: Promise<T>): Promise<T> {
    this.#jobs.add(job);
    const done = () => {
      this.#jobs.delete(job);
    };
    job.then(done, done);
    return job;
  }

  /** Resolves true once the work in flight has settled, or false after `ms` with some still running. */
  async idle(ms: number): Promise<boolean> {
    if (!this.#jobs.size) return true;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>((r) => {
      timer = setTimeout(() => r(false), ms);
    });
    const settled = Promise.allSettled([...this.#jobs]).then(() => true);
    const ok = await Promise.race([settled, late]);
    clearTimeout(timer);
    return ok;
  }
}
