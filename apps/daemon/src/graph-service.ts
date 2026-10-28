import { buildGraph, type CodeGraph, type FactsCache, openFactsCache } from '@friday/code-graph';
import { GitRoot } from '@friday/git';
import { FridayError } from '@friday/protocol';

/**
 * The code graph of the project's execution root (ADR-0020), rebuilt when the root's source
 * version changes. Until M5 the execution root is the main checkout (ADR-0014).
 */
export class GraphService {
  #root: Promise<GitRoot> | undefined;
  #cache: FactsCache | undefined;
  #latest: CodeGraph | undefined;
  #building: Promise<CodeGraph> | undefined;

  constructor(private readonly opts: { root: string; cacheDir: string }) {}

  private cache(): FactsCache {
    this.#cache ??= openFactsCache(this.opts.cacheDir);
    return this.#cache;
  }

  /** The graph at the root's current version; one build at a time. */
  async graph(): Promise<CodeGraph> {
    this.#root ??= GitRoot.open(this.opts.root);
    const root = await this.#root;
    const version = (await root.identity()).version;
    if (this.#latest?.version === version) return this.#latest;
    this.#building ??= buildGraph(root, { cache: this.cache() }).finally(() => {
      this.#building = undefined;
    });
    this.#latest = await this.#building;
    return this.#latest;
  }

  /** Forgets every parsed file and builds again (`friday graph reindex`). */
  async reindex(): Promise<CodeGraph> {
    if (this.#building) await this.#building.catch(() => undefined);
    this.cache().clear();
    this.#latest = undefined;
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
