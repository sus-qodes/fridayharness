import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { CodeGraph, SymbolEdge, SymbolNode } from './graph.js';
import type { Certainty } from './resolve.js';

/**
 * The questions asked of the graph (ADR-0037 §3): what a symbol is and who uses it, what a change
 * would reach, and what a file looks like with its bodies folded. Every answer is bounded and says
 * when it was cut; every edge carries how it resolved; nothing judges the code.
 */

export interface SymbolMatch {
  symbol: SymbolNode;
  /** Resolved references into it (exact or inferred edges). */
  callers: SymbolEdge[];
  /** References out of it, resolved or not. */
  callees: SymbolEdge[];
  /** Test files that import the symbol's file. */
  tests: string[];
  callers_cut: number;
  callees_cut: number;
}

export interface SymbolLookup {
  name: string;
  matches: SymbolMatch[];
  /** Unresolved references matched by name alone: guesses, labelled. */
  name_references: SymbolEdge[];
  matches_cut: number;
}

/** The key callers and callees are indexed by: `Class.method` for a member, else the name. */
export const symbolKey = (s: Pick<SymbolNode, 'name' | 'parent'>): string =>
  s.parent ? `${s.parent}.${s.name}` : s.name;

export function lookupSymbol(
  graph: CodeGraph,
  name: string,
  opts: { path?: string; prefix?: string; limit?: number; edges?: number } = {},
): SymbolLookup {
  const limit = opts.limit ?? 20;
  const edges = opts.edges ?? 50;
  const all = graph.findSymbols(name, {
    ...(opts.path ? { path: opts.path } : {}),
    ...(opts.prefix ? { prefix: opts.prefix } : {}),
    limit: 10_000,
  });
  const matches = all.slice(0, limit).map((symbol) => {
    const key = symbolKey(symbol);
    const callers = graph.callersOf(symbol.path, key);
    const callees = graph.calleesOf(symbol.path, key);
    return {
      symbol,
      callers: callers.slice(0, edges),
      callees: callees.slice(0, edges),
      tests: graph.testsOf(symbol.path),
      callers_cut: Math.max(0, callers.length - edges),
      callees_cut: Math.max(0, callees.length - edges),
    };
  });
  return {
    name,
    matches,
    name_references: graph.nameReferences(name).slice(0, edges),
    matches_cut: Math.max(0, all.length - limit),
  };
}

export type Confidence = 'high' | 'medium' | 'low';

export interface BlastSeed {
  path: string;
  /** The symbols changed in the file; empty: the whole file. */
  symbols: string[];
  /** Why a change here may break others: an exported symbol called from another area, a shared contract. */
  breaking: string[];
}

export interface Affected {
  path: string;
  /** The symbol reached, or null for a file reached through an import. */
  symbol: string | null;
  /** `import`: the file imports a changed file; `reference`: a resolved reference to a changed symbol; `name`: a name-only match. */
  via: 'import' | 'reference' | 'name';
  distance: number;
  confidence: Confidence;
  /** What it was reached from. */
  from: string;
}

export interface BlastRadius {
  seeds: BlastSeed[];
  affected: Affected[];
  depth: number;
  cut: number;
  name_matches_included: boolean;
}

const confidenceOf = (c: Certainty): Confidence => (c === 'exact' ? 'high' : c === 'inferred' ? 'medium' : 'low');
const RANK: Record<Confidence, number> = { high: 0, medium: 1, low: 2 };

/**
 * What a change to the seeds would reach, upstream (who imports or calls what changed), to a depth.
 * Each hit carries the confidence of the edges it was reached by and what it was reached from.
 * Name-only matches (a member call on a value whose type the graph does not know) are guesses and
 * come in only when asked.
 */
export function blastRadius(
  graph: CodeGraph,
  seeds: { paths?: readonly string[]; symbols?: readonly { path: string; symbol: string }[] },
  opts: { depth?: number; limit?: number; includeNameMatches?: boolean } = {},
): BlastRadius {
  const depth = Math.min(Math.max(opts.depth ?? 2, 1), 5);
  const limit = opts.limit ?? 200;
  const names = opts.includeNameMatches ?? false;
  const seedMap = new Map<string, Set<string>>();
  for (const p of seeds.paths ?? []) if (graph.nodes.has(p)) seedMap.set(p, seedMap.get(p) ?? new Set());
  for (const s of seeds.symbols ?? []) {
    if (!graph.nodes.has(s.path)) continue;
    const set = seedMap.get(s.path) ?? new Set<string>();
    set.add(s.symbol);
    seedMap.set(s.path, set);
  }
  const seedList: BlastSeed[] = [...seedMap]
    .map(([p, symbols]) => {
      const node = graph.nodes.get(p);
      const breaking: string[] = [];
      if (node?.contract) breaking.push(`shared contract of ${node.contract.areas.join(', ')}`);
      const changed = symbols.size
        ? [...symbols]
        : graph
            .symbolsOf(p)
            .filter((s) => s.exported)
            .map(symbolKey);
      for (const key of changed) {
        const areas = new Set(
          graph
            .callersOf(p, key)
            .map((e) => graph.nodes.get(e.from.path)?.area)
            .filter((a): a is string => Boolean(a) && a !== node?.area),
        );
        if (areas.size) breaking.push(`${key} is exported and called from ${[...areas].sort().join(', ')}`);
      }
      return { path: p, symbols: [...symbols].sort(), breaking: breaking.sort() };
    })
    .sort((a, b) => a.path.localeCompare(b.path));

  const affected = new Map<string, Affected>();
  const better = (a: Affected, b: Affected) =>
    a.distance < b.distance || (a.distance === b.distance && RANK[a.confidence] < RANK[b.confidence]);
  const hit = (a: Affected) => {
    const key = `${a.path}#${a.symbol ?? ''}`;
    const have = affected.get(key);
    if (!have || better(a, have)) affected.set(key, a);
  };
  // Each frontier entry: a file (symbol null) or a symbol of a file.
  type Frontier = { path: string; symbol: string | null; confidence: Confidence };
  let frontier: Frontier[] = seedList.flatMap((s): Frontier[] =>
    s.symbols.length
      ? s.symbols.map((symbol) => ({ path: s.path, symbol, confidence: 'high' }))
      : [{ path: s.path, symbol: null, confidence: 'high' }],
  );
  const seen = new Set(frontier.map((f) => `${f.path}#${f.symbol ?? ''}`));
  const weaker = (a: Confidence, b: Confidence): Confidence => (RANK[a] >= RANK[b] ? a : b);
  for (let d = 1; d <= depth && frontier.length; d++) {
    const next: typeof frontier = [];
    for (const f of frontier) {
      const reached: Affected[] = [];
      if (f.symbol === null) {
        for (const e of graph.consumers(f.path)) {
          if (e.certainty === 'unsupported') continue;
          reached.push({
            path: e.from,
            symbol: null,
            via: 'import',
            distance: d,
            confidence: weaker(f.confidence, confidenceOf(e.certainty)),
            from: f.path,
          });
        }
      } else {
        for (const e of graph.callersOf(f.path, f.symbol)) {
          reached.push({
            path: e.from.path,
            symbol: e.from.symbol,
            via: 'reference',
            distance: d,
            confidence: weaker(f.confidence, confidenceOf(e.certainty)),
            from: `${f.path}#${f.symbol}`,
          });
        }
        if (names) {
          const bare = f.symbol.includes('.') ? (f.symbol.split('.').pop() as string) : f.symbol;
          for (const e of graph.nameReferences(bare)) {
            reached.push({
              path: e.from.path,
              symbol: e.from.symbol,
              via: 'name',
              distance: d,
              confidence: 'low',
              from: `${f.path}#${f.symbol}`,
            });
          }
        }
      }
      for (const a of reached) {
        hit(a);
        const key = `${a.path}#${a.symbol ?? ''}`;
        if (!seen.has(key)) {
          seen.add(key);
          next.push({ path: a.path, symbol: a.symbol, confidence: a.confidence });
        }
      }
    }
    frontier = next;
  }
  const list = [...affected.values()].sort(
    (a, b) =>
      a.distance - b.distance ||
      RANK[a.confidence] - RANK[b.confidence] ||
      a.path.localeCompare(b.path) ||
      (a.symbol ?? '').localeCompare(b.symbol ?? ''),
  );
  return {
    seeds: seedList,
    affected: list.slice(0, limit),
    depth,
    cut: Math.max(0, list.length - limit),
    name_matches_included: names,
  };
}

export interface Skeleton {
  path: string;
  level: 1 | 2;
  /** Lines of the file. */
  lines: number;
  /** The skeleton, each line prefixed with its number; folded bodies shown as `…` with their length. */
  text: string;
  folded: number;
  cut: boolean;
}

const COMMENT = /^\s*(\/\/|\/\*|\*)/;

/**
 * A file with its bodies folded (ADR-0037 §3): L1 keeps imports, exports and each declaration's
 * first line; L2 also the doc comment above a declaration and the whole of exported interfaces,
 * types and enums. Line numbers are kept so a line can be asked for. A context view only.
 */
export async function skeletonOf(
  graph: CodeGraph,
  root: string,
  rel: string,
  level: 1 | 2 = 1,
  opts: { maxChars?: number } = {},
): Promise<Skeleton | null> {
  const node = graph.nodes.get(rel);
  if (!node) return null;
  let text: string;
  try {
    text = await readFile(path.join(root, rel), 'utf8');
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const keep = new Set<number>();
  const facts = graph.facts.get(rel)?.facts;
  for (const i of facts?.imports.map((f) => f.line) ?? []) keep.add(i);
  const symbols = graph.symbolsOf(rel);
  for (const s of symbols) {
    keep.add(s.line);
    const whole = level === 2 && s.exported && (s.kind === 'interface' || s.kind === 'type' || s.kind === 'enum');
    if (whole) for (let l = s.line; l <= s.end_line; l++) keep.add(l);
    if (level === 2) {
      // The doc comment right above: contiguous comment lines.
      for (let l = s.line - 1; l >= 1 && COMMENT.test(lines[l - 1] ?? ''); l--) keep.add(l);
    }
  }
  // Lines inside no symbol are the file's own top level: kept (imports, exports lists, statements).
  const inside = new Set<number>();
  for (const s of symbols) for (let l = s.line + 1; l <= s.end_line; l++) inside.add(l);
  for (let l = 1; l <= lines.length; l++) if (!inside.has(l) && (lines[l - 1] ?? '').trim() !== '') keep.add(l);
  const out: string[] = [];
  let folded = 0;
  let run = 0;
  const flush = () => {
    if (run > 0) {
      out.push(`      … (${run} line${run === 1 ? '' : 's'})`);
      folded += run;
      run = 0;
    }
  };
  for (let l = 1; l <= lines.length; l++) {
    if (keep.has(l)) {
      flush();
      out.push(`${String(l).padStart(5, ' ')}: ${lines[l - 1] ?? ''}`);
    } else if ((lines[l - 1] ?? '').trim() !== '') run += 1;
  }
  flush();
  let body = out.join('\n');
  const max = opts.maxChars ?? 12_000;
  const cut = body.length > max;
  if (cut) body = `${body.slice(0, max - 1)}…`;
  return { path: rel, level, lines: lines.length, text: body, folded, cut };
}
