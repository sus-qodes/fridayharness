import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import type { GitRoot, SourceIdentity } from '@friday/git';
import { type FactsCache, memoryFactsCache } from './cache.js';
import type { ImportKind } from './extract.js';
import { type LanguageId, languageOf, withTree } from './languages.js';
import { type Certainty, Resolver, readTsconfigPaths, readWorkspacePackages } from './resolve.js';
import {
  enclosingSymbol,
  extractFacts,
  type ImportBinding,
  type ParsedFacts,
  type ReferenceFact,
  type ReferenceKind,
  type SymbolFact,
} from './symbols.js';

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
  /** Files carried over from the previous graph without being read: git said their content was unchanged. */
  unchanged: number;
  edges: Record<Certainty, number>;
  contracts: number;
  /** ADR-0037 §1: the symbols declared, and the references between them by how they resolved. */
  symbols: number;
  symbol_edges: Record<Certainty, number>;
  ms: number;
}

const TEST_PATH = /(^|\/)(test|tests|__tests__)\//;
const TEST_NAME = /\.(test|spec)\.[cm]?[jt]sx?$/;
export const isTestPath = (p: string) => TEST_PATH.test(p) || TEST_NAME.test(p);

/** What was read of one file: the sha256 of its bytes, its language and its import facts. */
export interface FileFacts {
  sha: string;
  language: LanguageId;
  facts: ParsedFacts;
}

/** A symbol of a file (ADR-0037 §1). */
export interface SymbolNode extends SymbolFact {
  path: string;
}

/** One end of a symbol edge: a symbol of a file, or its module level (`<module>`). */
export interface SymbolRef {
  path: string;
  symbol: string;
}

/**
 * A reference from one symbol to another, derived from a file's references and bindings and the
 * file graph's edges. `to` is null when it could not be resolved: the reason says why, and the
 * `name` lets a query match it by name alone, labelled as such.
 */
export interface SymbolEdge {
  from: SymbolRef;
  to: SymbolRef | null;
  name: string;
  kind: ReferenceKind;
  certainty: Certainty;
  reason?: string;
  line: number;
}

/** A file-level graph of one execution root at one source version (ADR-0020). */
export class CodeGraph {
  private readonly incoming = new Map<string, GraphEdge[]>();
  private readonly outgoing = new Map<string, GraphEdge[]>();
  private readonly symbolsByPath = new Map<string, SymbolNode[]>();
  private readonly symbolsByName = new Map<string, SymbolNode[]>();
  private readonly symbolIn = new Map<string, SymbolEdge[]>();
  private readonly symbolOut = new Map<string, SymbolEdge[]>();
  private readonly byName = new Map<string, SymbolEdge[]>();
  /** `identity().version` of the root when the graph was built. */
  readonly version: string;

  constructor(
    readonly root: string,
    /** The root's identity when the graph was built; the next build starts from it. */
    readonly identity: SourceIdentity,
    readonly nodes: Map<string, GraphNode>,
    readonly edges: GraphEdge[],
    readonly skipped: { path: string; reason: string }[],
    readonly stats: GraphStats,
    /** Each parsed file's facts, so the next build of this root can keep the unchanged ones. */
    readonly facts: ReadonlyMap<string, FileFacts> = new Map(),
    /** The size limit used when this graph decided whether to read or skip a file. */
    readonly maxFileBytes = 1024 * 1024,
    /** Every symbol of every file (ADR-0037 §1), sorted by path and line. */
    readonly symbols: SymbolNode[] = [],
    /** Every reference between symbols, resolved or not, sorted by file and line. */
    readonly symbolEdges: SymbolEdge[] = [],
    /** The Merkle tree's root hash when this graph was built (ADR-0037 §2); null when none was scanned. */
    readonly treeHash: string | null = null,
  ) {
    this.version = identity.version;
    for (const e of edges) {
      push(this.outgoing, e.from, e);
      if (e.to) push(this.incoming, e.to, e);
    }
    for (const s of symbols) {
      push(this.symbolsByPath, s.path, s);
      push(this.symbolsByName, s.name, s);
    }
    for (const e of symbolEdges) {
      push(this.symbolOut, `${e.from.path}#${e.from.symbol}`, e);
      if (e.to) push(this.symbolIn, `${e.to.path}#${e.to.symbol}`, e);
      else push(this.byName, e.name, e);
    }
  }

  /** The symbols a file declares, in line order. */
  symbolsOf(file: string): SymbolNode[] {
    return this.symbolsByPath.get(file) ?? [];
  }

  /** The symbols named `name` (exact, case-sensitive), optionally within one file or under a path prefix. */
  findSymbols(name: string, opts: { path?: string; prefix?: string; limit?: number } = {}): SymbolNode[] {
    const all = this.symbolsByName.get(name) ?? [];
    const matched = all.filter(
      (s) => (!opts.path || s.path === opts.path) && (!opts.prefix || s.path.startsWith(opts.prefix)),
    );
    return matched.slice(0, opts.limit ?? 20);
  }

  /** Resolved references into a symbol of a file: who calls, constructs, types or renders it. */
  callersOf(file: string, symbol: string): SymbolEdge[] {
    return this.symbolIn.get(`${file}#${symbol}`) ?? [];
  }

  /** References out of a symbol of a file, resolved or not. */
  calleesOf(file: string, symbol: string): SymbolEdge[] {
    return this.symbolOut.get(`${file}#${symbol}`) ?? [];
  }

  /** Unresolved references matched by name alone (a member call on an unknown value): guesses, labelled. */
  nameReferences(name: string): SymbolEdge[] {
    return this.byName.get(name) ?? [];
  }

  /** The symbol of a file whose range holds the line, else the module level. */
  enclosingSymbol(file: string, line: number): string {
    return enclosingSymbol(this.symbolsOf(file), line);
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
  /** The root's identity, when the caller just read it; read here otherwise. */
  identity?: SourceIdentity;
  /**
   * The last graph of the same root. Files whose content git says is unchanged since it was
   * built keep their facts unread; the rest are read as usual. Every edge is resolved anew.
   */
  previous?: CodeGraph;
  /** The root's files, when the caller just listed them; listed here otherwise. */
  files?: readonly string[];
  /**
   * What changed since `previous` by the Merkle tree's account (ADR-0037 §2), used only when git
   * cannot vouch for the checkout (an approximate identity). Null or absent: everything is read.
   */
  changedPaths?: ReadonlySet<string> | null;
  /** The Merkle tree's root hash for this build, recorded on the graph. */
  treeHash?: string | null;
}

/**
 * The files whose content may differ from the previous graph's, or null when that cannot be
 * known and everything must be read. A file not in the set has the same content as before: with
 * the same HEAD, only a file dirty then or dirty now can differ; across commits, also a file the
 * two commits differ in. Both identities must be content-based (ADR-0019 §3).
 */
async function changedSince(root: GitRoot, previous: CodeGraph, identity: SourceIdentity): Promise<Set<string> | null> {
  const before = previous.identity;
  if (previous.root !== root.root) return null;
  if (before.basis !== 'content' || identity.basis !== 'content') return null;
  if (!before.head || !identity.head) return null;
  const changed = new Set<string>([...before.paths, ...identity.paths]);
  if (before.head !== identity.head) {
    for (const p of await root.changedBetween(before.head, identity.head)) changed.add(p);
  }
  return changed;
}

/** Builds the graph of an execution root as it is now (ADR-0020 §6). */
export async function buildGraph(root: GitRoot, opts: BuildOptions = {}): Promise<CodeGraph> {
  const started = Date.now();
  const cache = opts.cache ?? memoryFactsCache();
  const maxBytes = opts.maxFileBytes ?? 1024 * 1024;
  const identity = opts.identity ?? (await root.identity());
  const listed = opts.files ? [...opts.files] : await root.files();
  const files = new Set(listed);
  const sameLimit = opts.previous && opts.previous.maxFileBytes === maxBytes;
  const byGit = sameLimit ? await changedSince(root, opts.previous as CodeGraph, identity) : null;
  // Git's account first; the Merkle tree's when git cannot vouch and the caller scanned it.
  const changed = byGit ?? (sameLimit && opts.changedPaths ? new Set(opts.changedPaths) : null);
  const facts = new Map<string, ParsedFacts>();
  const fileFacts = new Map<string, FileFacts>();
  const skipped: { path: string; reason: string }[] = [];
  const fresh: { sha: string; language: string; facts: ParsedFacts }[] = [];
  const languages = new Map<string, LanguageId>();
  let parsed = 0;
  let cached = 0;
  let unchanged = 0;
  let count = 0;
  for (const rel of listed) {
    const lang = languageOf(rel);
    if (!lang) continue;
    const kept = changed && !changed.has(rel) ? opts.previous?.facts.get(rel) : undefined;
    if (kept) {
      unchanged += 1;
      facts.set(rel, kept.facts);
      fileFacts.set(rel, kept);
      languages.set(rel, kept.language);
      continue;
    }
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
        found = await withTree(lang, bytes.toString('utf8'), extractFacts);
      } catch (e) {
        skipped.push({ path: rel, reason: `could not be parsed: ${(e as Error).message}` });
        continue;
      }
      parsed += 1;
      fresh.push({ sha, language: lang.id, facts: found });
    }
    facts.set(rel, found);
    fileFacts.set(rel, { sha, language: lang.id, facts: found });
    languages.set(rel, lang.id);
  }
  cache.putAll(fresh);

  const packages = await readWorkspacePackages(root.root, files);
  const resolver = new Resolver(files, packages, await readTsconfigPaths(root.root, files));
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
    for (const f of list.imports) {
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
  const { symbols, symbolEdges, symbolTally } = deriveSymbols(facts, edges);
  return new CodeGraph(
    root.root,
    identity,
    nodes,
    edges,
    skipped,
    {
      files: nodes.size,
      parsed,
      cached,
      unchanged,
      edges: tally,
      contracts: byTarget.size,
      symbols: symbols.length,
      symbol_edges: symbolTally,
      ms: Date.now() - started,
    },
    fileFacts,
    maxBytes,
    symbols,
    symbolEdges,
    opts.treeHash ?? null,
  );
}

/**
 * Symbol nodes and the edges between them (ADR-0037 §1), from each file's symbols, bindings and
 * references and the file graph's edges. A reference to a local symbol is an edge within the file;
 * a reference to an imported name follows the import's file edge and lands on the symbol the target
 * declares and exports, else it is unsupported with the reason; a member call on a value the graph
 * does not know is kept by name alone. Nothing is guessed: every edge says how it resolved.
 */
function deriveSymbols(
  facts: ReadonlyMap<string, ParsedFacts>,
  edges: readonly GraphEdge[],
): { symbols: SymbolNode[]; symbolEdges: SymbolEdge[]; symbolTally: Record<Certainty, number> } {
  const symbols: SymbolNode[] = [];
  const symbolEdges: SymbolEdge[] = [];
  const symbolTally: Record<Certainty, number> = { exact: 0, inferred: 0, unsupported: 0 };
  const fileEdges = new Map<string, GraphEdge[]>();
  for (const e of edges) push(fileEdges, e.from, e);
  const paths = [...facts.keys()].sort();
  for (const rel of paths) {
    for (const s of (facts.get(rel) as ParsedFacts).symbols) symbols.push({ ...s, path: rel });
  }
  /** The top-level symbol of a file by name, exported or not. */
  const topLevel = (rel: string, name: string): SymbolFact | undefined =>
    facts.get(rel)?.symbols.find((s) => s.parent === null && s.name === name);
  const exportedOf = (rel: string, name: string): SymbolFact | undefined => {
    const s = topLevel(rel, name);
    return s?.exported ? s : undefined;
  };
  for (const rel of paths) {
    const f = facts.get(rel) as ParsedFacts;
    const bindings = new Map(f.bindings.map((b) => [b.local, b]));
    const local = new Map(f.symbols.filter((s) => s.parent === null).map((s) => [s.name, s]));
    const mine = fileEdges.get(rel) ?? [];
    const edgeFor = (specifier: string | null): GraphEdge | undefined => mine.find((e) => e.specifier === specifier);
    const emit = (r: ReferenceFact, to: SymbolRef | null, certainty: Certainty, reason?: string) => {
      const edge: SymbolEdge = {
        from: { path: rel, symbol: enclosingSymbol(f.symbols, r.line) },
        to,
        name: r.name,
        kind: r.kind,
        certainty,
        ...(reason ? { reason } : {}),
        line: r.line,
      };
      symbolEdges.push(edge);
      symbolTally[certainty] += 1;
    };
    /** Follows an import binding to the symbol `name` of its target file. */
    const viaImport = (r: ReferenceFact, b: ImportBinding, name: string) => {
      const fe = edgeFor(b.specifier);
      if (!fe) return emit(r, null, 'unsupported', `no import edge for "${b.specifier ?? '(computed)'}"`);
      if (fe.certainty === 'unsupported' || !fe.to) {
        return emit(
          r,
          null,
          'unsupported',
          `the import of "${b.specifier}" is unsupported: ${fe.reason ?? 'unresolved'}`,
        );
      }
      const target = facts.get(fe.to);
      if (!target) return emit(r, null, 'unsupported', `${fe.to} is not in the graph`);
      const wanted = name === 'default' ? target.default_export : name;
      const found = wanted ? exportedOf(fe.to, wanted) : undefined;
      if (!found) {
        return emit(
          r,
          null,
          'unsupported',
          name === 'default'
            ? `${fe.to} names no default export the graph can follow`
            : `${fe.to} does not declare an exported ${name} (a re-export, or a name it does not define)`,
        );
      }
      emit(r, { path: fe.to, symbol: found.name }, fe.certainty);
    };
    for (const r of f.references) {
      if (r.via === null) {
        const b = bindings.get(r.name);
        if (b) {
          if (b.imported === '*') emit(r, null, 'unsupported', `${r.name} is a namespace import, not a symbol`);
          else viaImport(r, b, b.imported);
          continue;
        }
        const s = local.get(r.name);
        if (s) emit(r, { path: rel, symbol: s.name }, 'exact');
        // A name the file neither declares nor imports (a global, a parameter) is nobody's edge.
        continue;
      }
      if (r.via === 'this') {
        const from = enclosingSymbol(f.symbols, r.line);
        const owner = from.includes('.') ? (from.split('.')[0] as string) : from;
        const member = f.symbols.find((s) => s.parent === owner && s.name === r.name);
        if (member) emit(r, { path: rel, symbol: `${owner}.${member.name}` }, 'exact');
        else emit(r, null, 'unsupported', `${owner} declares no member ${r.name} the graph can see`);
        continue;
      }
      const b = bindings.get(r.via);
      if (b?.imported === '*') {
        viaImport(r, b, r.name);
        continue;
      }
      if (b) {
        emit(
          r,
          null,
          'unsupported',
          `${r.name} is a member of the import ${r.via}, whose shape the graph does not follow`,
        );
        continue;
      }
      const ns = local.get(r.via);
      if (ns?.kind === 'namespace') {
        const member = f.symbols.find((s) => s.parent === ns.name && s.name === r.name);
        if (member) emit(r, { path: rel, symbol: `${ns.name}.${member.name}` }, 'exact');
        else emit(r, null, 'unsupported', `namespace ${ns.name} declares no ${r.name}`);
        continue;
      }
      emit(
        r,
        null,
        'unsupported',
        `name only: a member of ${r.via === '?' ? 'an expression' : r.via}, whose type the graph does not know`,
      );
    }
  }
  symbols.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.name.localeCompare(b.name));
  symbolEdges.sort((a, b) => a.from.path.localeCompare(b.from.path) || a.line - b.line || a.name.localeCompare(b.name));
  return { symbols, symbolEdges, symbolTally };
}
