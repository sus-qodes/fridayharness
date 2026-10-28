import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { GitRoot } from '@friday/git';
import { type FactsCache, memoryFactsCache } from './cache.js';
import { extractImports, type ImportFact, type ImportKind } from './extract.js';
import { type LanguageId, languageOf, withTree } from './languages.js';
import { type Certainty, Resolver, readAliases, readWorkspacePackages } from './resolve.js';

export interface GraphNode {
  path: string;
  language: LanguageId;
  test: boolean;
  /** The nearest folder below the root with a package.json, else the top-level folder (ADR-0020 §5). */
  area: string;
  /** Modules outside the root this file uses (`node:fs`, `react`, …). */
  external: string[];
  /** Set when non-test files of other areas import this file. */
  contract?: { areas: string[] };
}

export interface GraphEdge {
  from: string;
  /** Null when the target could not be determined. */
  to: string | null;
  kind: ImportKind;
  specifier: string | null;
  certainty: Certainty;
  reason?: string;
  line: number;
}

export interface GraphStats {
  files: number;
  parsed: number;
  cached: number;
  edges: Record<Certainty, number>;
  contracts: number;
  ms: number;
}

const TEST_PATH = /(^|\/)(test|tests|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const isTestPath = (p: string) => TEST_PATH.test(p) || TEST_NAME.test(p);

/** A file-level graph of one execution root at one source version (ADR-0020). */
export class CodeGraph {
  private readonly incoming = new Map<string, GraphEdge[]>();
  private readonly outgoing = new Map<string, GraphEdge[]>();

  constructor(
    readonly root: string,
    /** `identity().version` of the root when the graph was built. */
    readonly version: string,
    readonly nodes: Map<string, GraphNode>,
    readonly edges: GraphEdge[],
    readonly skipped: { path: string; reason: string }[],
    readonly stats: GraphStats,
  ) {
    for (const e of edges) {
      push(this.outgoing, e.from, e);
      if (e.to) push(this.incoming, e.to, e);
    }
  }

  /** What a file imports (edges out of it). */
  dependencies(file: string): GraphEdge[] {
    return this.outgoing.get(file) ?? [];
  }

  /** Who imports a file (edges into it). */
  consumers(file: string): GraphEdge[] {
    return this.incoming.get(file) ?? [];
  }

  /** Test files that import the file directly. */
  testsOf(file: string): string[] {
    return [
      ...new Set(
        this.consumers(file)
          .filter((e) => this.nodes.get(e.from)?.test)
          .map((e) => e.from),
      ),
    ].sort();
  }

  contracts(): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.contract).sort((a, b) => a.path.localeCompare(b.path));
  }

  unsupported(): GraphEdge[] {
    return this.edges.filter((e) => e.certainty === 'unsupported');
  }

  /** Files within `depth` steps of `file` along exact and inferred edges, either direction, with their distance. */
  neighbourhood(file: string, depth = 1): Map<string, number> {
    const dist = new Map<string, number>([[file, 0]]);
    let frontier = [file];
    for (let d = 1; d <= depth && frontier.length; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const e of [...this.dependencies(f), ...this.consumers(f)]) {
          if (e.certainty === 'unsupported' || !e.to) continue;
          const other = e.from === f ? e.to : e.from;
          if (!dist.has(other)) {
            dist.set(other, d);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return dist;
  }
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export interface BuildOptions {
  cache?: FactsCache;
  /** Files larger than this are skipped (bundles, generated code). Default 1 MB. */
  maxFileBytes?: number;
  /** Yield to the event loop after this many files. Default 25. */
  yieldEvery?: number;
}

/** Builds the graph of an execution root as it is now (ADR-0020 §6). */
export async function buildGraph(root: GitRoot, opts: BuildOptions = {}): Promise<CodeGraph> {
  const started = Date.now();
  const cache = opts.cache ?? memoryFactsCache();
  const maxBytes = opts.maxFileBytes ?? 1024 * 1024;
  const identity = await root.identity();
  const listed = await root.files();
  const files = new Set(listed);
  const facts = new Map<string, ImportFact[]>();
  const skipped: { path: string; reason: string }[] = [];
  const fresh: { sha: string; language: string; facts: ImportFact[] }[] = [];
  const languages = new Map<string, LanguageId>();
  let parsed = 0;
  let cached = 0;
  let count = 0;
  for (const rel of listed) {
    const lang = languageOf(rel);
    if (!lang) continue;
    if (++count % (opts.yieldEvery ?? 25) === 0) await nextTurn();
    const abs = path.join(root.root, rel);
    let bytes: Buffer;
    try {
      const st = await stat(abs);
      if (!st.isFile()) continue;
      if (st.size > maxBytes) {
        skipped.push({ path: rel, reason: `larger than ${maxBytes} bytes` });
        continue;
      }
      bytes = await readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; // deleted in the working tree
      skipped.push({ path: rel, reason: 'unreadable' });
      continue;
    }
    const sha = createHash('sha256').update(bytes).digest('hex');
    let found = cache.get(sha);
    if (found) {
      cached += 1;
    } else {
      try {
        found = await withTree(lang, bytes.toString('utf8'), extractImports);
      } catch (e) {
        skipped.push({ path: rel, reason: `could not be parsed: ${(e as Error).message}` });
        continue;
      }
      parsed += 1;
      fresh.push({ sha, language: lang.id, facts: found });
    }
    facts.set(rel, found);
    languages.set(rel, lang.id);
  }
  cache.putAll(fresh);

  const packages = await readWorkspacePackages(root.root, files);
  const resolver = new Resolver(files, packages, await readAliases(root.root));
  const packageDirs = [
    ...new Set(listed.filter((f) => path.posix.basename(f) === 'package.json').map((f) => path.posix.dirname(f))),
  ]
    .filter((d) => d !== '.')
    .sort((a, b) => b.length - a.length);
  const areaOf = (p: string) =>
    packageDirs.find((d) => p.startsWith(`${d}/`)) ?? (p.includes('/') ? (p.split('/')[0] as string) : '.');

  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  for (const [rel, list] of facts) {
    const node: GraphNode = {
      path: rel,
      language: languages.get(rel) as LanguageId,
      test: isTestPath(rel),
      area: areaOf(rel),
      external: [],
    };
    nodes.set(rel, node);
    for (const f of list) {
      const r = resolver.resolve(rel, f.specifier);
      if (r.type === 'external') {
        if (!node.external.includes(r.module)) node.external.push(r.module);
        continue;
      }
      edges.push(
        r.type === 'file'
          ? {
              from: rel,
              to: r.to,
              kind: f.kind,
              specifier: f.specifier,
              certainty: r.certainty,
              ...(r.reason ? { reason: r.reason } : {}),
              line: f.line,
            }
          : {
              from: rel,
              to: null,
              kind: f.kind,
              specifier: f.specifier,
              certainty: 'unsupported',
              reason: r.reason,
              line: f.line,
            },
      );
    }
    node.external.sort();
  }
  // Shared contracts: imported by non-test files of another area.
  const byTarget = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!e.to || e.certainty === 'unsupported') continue;
    const from = nodes.get(e.from);
    const to = nodes.get(e.to);
    if (!from || !to || from.test || to.test || from.area === to.area) continue;
    const set = byTarget.get(e.to) ?? new Set<string>();
    set.add(from.area);
    byTarget.set(e.to, set);
  }
  for (const [target, areas] of byTarget) {
    const node = nodes.get(target);
    if (node) node.contract = { areas: [...areas].sort() };
  }
  const tally: Record<Certainty, number> = { exact: 0, inferred: 0, unsupported: 0 };
  for (const e of edges) tally[e.certainty] += 1;
  return new CodeGraph(root.root, identity.version, nodes, edges, skipped, {
    files: nodes.size,
    parsed,
    cached,
    edges: tally,
    contracts: byTarget.size,
    ms: Date.now() - started,
  });
}
