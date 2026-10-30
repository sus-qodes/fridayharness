import { buildGraph, type CodeGraph, type FactsCache, openFactsCache } from '@friday/code-graph';
import { GitRoot, type SourceIdentity } from '@friday/git';
import { FridayError } from '@friday/protocol';

interface RootGraph {
  root: Promise<GitRoot>;
  latest?: CodeGraph;
  building?: { promise: Promise<CodeGraph> };
}

/**
 * Code graphs of the project's checkouts (ADR-0020, ADR-0023): the main checkout and each task
 * worktree, rebuilt when that checkout's source version changes. One facts cache serves them
 * all, so a file is parsed once whichever checkout holds it.
 */
export class GraphService {
  #cache: FactsCache | undefined;
  readonly #roots = new Map<string, RootGraph>();

  constructor(
    private readonly opts: { root: string; cacheDir: string; maxRoots?: number; build?: typeof buildGraph },
  ) {}

  private cache(): FactsCache {
    this.#cache ??= openFactsCache(this.opts.cacheDir);
    return this.#cache;
  }

  private entry(root: string): RootGraph {
    const key = process.platform === 'win32' ? root.toLowerCase() : root;
    let e = this.#roots.get(key);
    if (e) {
      // Most recently used last.
      this.#roots.delete(key);
    } else {
      e = { root: GitRoot.open(root) };
    }
    this.#roots.set(key, e);
    while (this.#roots.size > (this.opts.maxRoots ?? 16)) {
      const oldest = this.#roots.keys().next().value as string;
      this.#roots.delete(oldest);
    }
    return e;
  }

  /**
   * The graph of a checkout (the main one by default) at its current version; one build at a time.
   * An approximate identity (sizes and times) does not prove the code is unchanged, so its graph is
   * built again; the content-addressed parse cache keeps that cheap (review F13). A caller that
   * just read the checkout's identity (the context compiler) passes it, so it is not read twice.
   */
  async graph(root: string = this.opts.root, known?: SourceIdentity | null): Promise<CodeGraph> {
    const e = this.entry(root);
    const git = await e.root;
    const identity = known ?? (await git.identity());
    if (e.latest?.version === identity.version && identity.basis === 'content') return e.latest;
    // If another caller is already building, wait for it and then re-read the current identity. The
    // checkout may have changed while that build ran; returning the in-flight graph to a newer
    // caller would expose a stale graph until the next request (review M14.10 race).
    if (e.building) {
      await e.building.promise;
      return this.graph(root);
    }
    // The last graph of this checkout is the starting point: files git says are unchanged keep
    // their facts, and only the changed ones are read again (ADR-0020, amendment of 2026-10-20).
    const previous = e.latest;
    const promise = (this.opts.build ?? buildGraph)(git, {
      cache: this.cache(),
      identity,
      ...(previous ? { previous } : {}),
    });
    e.building = { promise };
    try {
      e.latest = await promise;
      return e.latest;
    } finally {
      if (e.building?.promise === promise) e.building = undefined;
    }
  }

  /** Forgets every parsed file and builds the main checkout's graph again (`friday graph reindex`). */
  async reindex(): Promise<CodeGraph> {
    for (const e of this.#roots.values()) {
      if (e.building) await e.building.promise.catch(() => undefined);
      e.latest = undefined;
    }
    this.cache().clear();
    return this.graph();
  }

  close(): void {
    this.#cache?.close();
    this.#cache = undefined;
  }
}

export function summary(g: CodeGraph) {
  return {
    version: g.version,
    stats: g.stats,
    symbols: { count: g.symbols.length, edges: g.stats.symbol_edges },
    contracts: g.contracts().map((n) => ({ path: n.path, area: n.area, consumers: n.contract?.areas ?? [] })),
    unsupported: g.unsupported(),
    skipped: g.skipped,
  };
}

/** What the graph knows about one file: what it imports, who imports it, its tests and neighbours. */
export function query(g: CodeGraph, rawPath: string, depth: number) {
  const file = rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
  const node = g.nodes.get(file);
  if (!node) {
    throw new FridayError('invalid_request', `${file} is not in the code graph (only TS/JS files git sees are)`);
  }
  return {
    version: g.version,
    node,
    dependencies: g.dependencies(file),
    consumers: g.consumers(file),
    tests: g.testsOf(file),
    neighbourhood: [...g.neighbourhood(file, depth)]
      .filter(([p]) => p !== file)
      .map(([path, distance]) => ({ path, distance }))
      .sort((a, b) => a.distance - b.distance || a.path.localeCompare(b.path)),
  };
}
