import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import { table } from './output.js';

/** The code graph of the project's execution root (plan M4b, ADR-0020). */

interface Edge {
  from: string;
  to: string | null;
  kind: string;
  specifier: string | null;
  certainty: 'exact' | 'inferred' | 'unsupported';
  reason?: string;
  line: number;
}
interface Summary {
  version: string;
  stats: {
    files: number;
    parsed: number;
    cached: number;
    unchanged?: number;
    edges: Record<string, number>;
    contracts: number;
    ms: number;
  };
  contracts: { path: string; area: string; consumers: string[] }[];
  unsupported: Edge[];
  skipped: { path: string; reason: string }[];
}
interface Query {
  version: string;
  node: { path: string; area: string; test: boolean; external: string[]; contract?: { areas: string[] } };
  dependencies: Edge[];
  consumers: Edge[];
  tests: string[];
  neighbourhood: { path: string; distance: number }[];
}

interface SymbolEdge {
  from: { path: string; symbol: string };
  to: { path: string; symbol: string } | null;
  name: string;
  kind: string;
  certainty: 'exact' | 'inferred' | 'unsupported';
  reason?: string;
  line: number;
}
interface SymbolAnswer {
  version: string;
  name: string;
  matches: {
    symbol: {
      path: string;
      name: string;
      kind: string;
      line: number;
      end_line: number;
      exported: boolean;
      parent: string | null;
      signature: string;
    };
    callers: SymbolEdge[];
    callees: SymbolEdge[];
    tests: string[];
    callers_cut: number;
    callees_cut: number;
  }[];
  name_references: SymbolEdge[];
  matches_cut: number;
}
interface BlastAnswer {
  version: string;
  seeds: { path: string; symbols: string[]; breaking: string[] }[];
  affected: {
    path: string;
    symbol: string | null;
    via: string;
    distance: number;
    confidence: string;
    from: string;
  }[];
  depth: number;
  cut: number;
  name_matches_included: boolean;
}
interface SkeletonAnswer {
  path: string;
  level: number;
  lines: number;
  text: string;
  folded: number;
  cut: boolean;
}
interface Hit {
  kind: 'symbol' | 'file';
  path: string;
  name: string;
  symbol_kind: string | null;
  line: number | null;
  signature: string | null;
  score: number;
}

const collect = (v: string, prev: string[] = []) => [...prev, v];
const edgeFrom = (e: SymbolEdge) =>
  `${e.from.path}#${e.from.symbol}:${e.line} (${e.certainty}${e.reason ? `: ${e.reason}` : ''})`;
const edgeTo = (e: SymbolEdge) =>
  e.to
    ? `${e.to.path}#${e.to.symbol} (${e.kind}, ${e.certainty})`
    : `${e.name} (${e.kind}, ${e.certainty}${e.reason ? `: ${e.reason}` : ''})`;

function renderSymbol(r: SymbolAnswer): string {
  if (!r.matches.length && !r.name_references.length) return `No symbol named ${r.name} in the code graph.`;
  const lines: string[] = [];
  for (const m of r.matches) {
    const s = m.symbol;
    lines.push(
      `${s.path}:${s.line}-${s.end_line}  ${s.kind}${s.parent ? ` of ${s.parent}` : ''}${s.exported ? ', exported' : ''}`,
      `  ${s.signature}`,
      `  called or used by: ${m.callers.map(edgeFrom).join('; ') || 'nobody the graph can see'}${m.callers_cut ? ` (+${m.callers_cut} more)` : ''}`,
      `  uses: ${m.callees.map(edgeTo).join('; ') || 'nothing the graph can see'}${m.callees_cut ? ` (+${m.callees_cut} more)` : ''}`,
      `  tests of its file: ${m.tests.join(', ') || 'none'}`,
    );
  }
  if (r.matches_cut) lines.push(`(${r.matches_cut} more symbols named ${r.name})`);
  if (r.name_references.length) {
    lines.push(
      `Name-only matches (member calls on values the graph does not know; guesses): ${r.name_references.map((e) => `${e.from.path}:${e.line} in ${e.from.symbol}`).join('; ')}`,
    );
  }
  return lines.join('\n');
}

function renderBlast(r: BlastAnswer): string {
  const lines = r.seeds.map(
    (s) =>
      `Changed: ${s.path}${s.symbols.length ? ` (${s.symbols.join(', ')})` : ''}${s.breaking.length ? `  breaking: ${s.breaking.join('; ')}` : ''}`,
  );
  lines.push(
    r.affected.length
      ? table(
          ['DISTANCE', 'CONFIDENCE', 'AFFECTED', 'VIA', 'FROM'],
          r.affected.map((a) => [
            String(a.distance),
            a.confidence,
            a.symbol ? `${a.path}#${a.symbol}` : a.path,
            a.via,
            a.from,
          ]),
          { maxWidth: 60 },
        )
      : 'Nothing the graph can see depends on it.',
    `Depth ${r.depth}${r.cut ? `; ${r.cut} more not shown` : ''}${r.name_matches_included ? '; name-only matches included (guesses)' : '; name-only matches left out (--names)'}.`,
  );
  return lines.join('\n');
}

const target = (e: Edge) => e.to ?? `(${e.specifier ?? 'computed'})`;
const how = (e: Edge) =>
  e.certainty === 'exact' ? e.kind : `${e.kind}, ${e.certainty}${e.reason ? `: ${e.reason}` : ''}`;

function renderSummary(s: Summary): string {
  return [
    `Code graph at ${s.version}: ${s.stats.files} files, ${s.stats.edges.exact ?? 0} exact, ${s.stats.edges.inferred ?? 0} inferred and ${s.stats.edges.unsupported ?? 0} unsupported edges (built in ${s.stats.ms} ms; ${s.stats.parsed} parsed, ${s.stats.cached} from cache, ${s.stats.unchanged ?? 0} kept from the last graph).`,
    s.contracts.length
      ? `Shared contracts:\n${table(
          ['FILE', 'AREA', 'USED BY'],
          s.contracts.map((c) => [c.path, c.area, c.consumers.join(', ')]),
        )}`
      : 'No shared contracts.',
    s.unsupported.length
      ? `Not resolved (reported, not guessed):\n${s.unsupported.map((e) => `  ${e.from}:${e.line}  ${e.specifier ?? '(computed)'}  ${e.reason ?? ''}`).join('\n')}`
      : '',
    s.skipped.length ? `Skipped:\n${s.skipped.map((x) => `  ${x.path}  ${x.reason}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

export function registerGraphCommands(program: Command, g: () => GlobalOptions): void {
  const graph = program
    .command('graph')
    .description('the code graph: which files import, test and share contracts with which');
  graph.action(async () => {
    const { client } = operator(g());
    const s = await client.get<Summary>(client.projectPath('/graph'), { timeoutMs: 120_000 });
    out(g(), s, () => renderSummary(s));
  });
  graph
    .command('query <file>')
    .description('what a file imports, who imports it, its tests and its neighbourhood')
    .option('--depth <n>', 'neighbourhood depth (1-5)', Number, 1)
    .action(async (file: string, o: { depth: number }) => {
      const { client } = operator(g());
      const q = await client.get<Query>(
        `${client.projectPath('/graph/query')}?path=${encodeURIComponent(file)}&depth=${o.depth}`,
        { timeoutMs: 120_000 },
      );
      out(g(), q, () =>
        [
          `${q.node.path}  (area ${q.node.area}${q.node.test ? ', test' : ''}${q.node.contract ? `; shared contract of ${q.node.contract.areas.join(', ')}` : ''})`,
          `Imports:\n${q.dependencies.map((e) => `  ${target(e)}  ${how(e)}`).join('\n') || '  nothing in the project'}`,
          `Imported by:\n${q.consumers.map((e) => `  ${e.from}  ${how(e)}`).join('\n') || '  nobody'}`,
          `Tests: ${q.tests.join(', ') || 'none import it directly'}`,
          q.node.external.length ? `Outside the project: ${q.node.external.join(', ')}` : '',
          `Within ${o.depth} step${o.depth > 1 ? 's' : ''}: ${q.neighbourhood.map((n) => `${n.path} (${n.distance})`).join(', ') || 'nothing'}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });
  graph
    .command('symbol <name>')
    .description('a symbol: where it is, its signature, who calls or uses it, what it uses, its tests')
    .option('--path <file>', 'only in this file')
    .option('--prefix <dir>', 'only under this folder')
    .action(async (name: string, o: { path?: string; prefix?: string }) => {
      const { client } = operator(g());
      const r = await client.get<SymbolAnswer>(client.projectPath('/graph/symbol'), {
        query: { name, path: o.path, prefix: o.prefix },
        timeoutMs: 120_000,
      });
      out(g(), r, () => renderSymbol(r));
    });
  graph
    .command('blast-radius [paths...]')
    .description('what a change to these files (or --symbol file#name, or --diff) would reach, with confidence')
    .option('--symbol <ref>', 'a symbol, as file#name (repeatable)', collect, [])
    .option('--diff', "seed it with the working tree's changed files")
    .option('--depth <n>', 'how far upstream (1-5)', Number, 2)
    .option('--names', 'include name-only matches (guesses)')
    .action(async (paths: string[], o: { symbol: string[]; diff?: boolean; depth: number; names?: boolean }) => {
      const { client } = operator(g());
      const r = await client.get<BlastAnswer>(client.projectPath('/graph/blast-radius'), {
        query: {
          path: paths,
          symbol: o.symbol,
          diff: o.diff ? 'true' : undefined,
          depth: o.depth,
          names: o.names ? 'true' : undefined,
        },
        timeoutMs: 120_000,
      });
      out(g(), r, () => renderBlast(r));
    });
  graph
    .command('skeleton <file>')
    .description(
      'the file with its bodies folded: signatures and types (L1), plus doc comments and exported types (L2)',
    )
    .option('--level <n>', '1 or 2', Number, 1)
    .action(async (file: string, o: { level: number }) => {
      const { client } = operator(g());
      const r = await client.get<SkeletonAnswer>(client.projectPath('/graph/skeleton'), {
        query: { path: file, level: o.level === 2 ? '2' : '1' },
        timeoutMs: 120_000,
      });
      out(
        g(),
        r,
        () => `${r.path} (L${r.level}: ${r.lines} lines, ${r.folded} folded${r.cut ? ', cut' : ''})\n${r.text}`,
      );
    });
  graph
    .command('search <words...>')
    .description('symbols and files by the words of their names and paths (BM25)')
    .option('--kind <kind>', 'symbol or file')
    .option('--limit <n>', 'at most (1-100)', Number, 20)
    .action(async (words: string[], o: { kind?: string; limit: number }) => {
      const { client } = operator(g());
      const r = await client.get<{ hits: Hit[] }>(client.projectPath('/graph/search'), {
        query: { q: words.join(' '), kind: o.kind, limit: o.limit },
        timeoutMs: 120_000,
      });
      out(g(), r, () =>
        r.hits.length
          ? table(
              ['SCORE', 'KIND', 'NAME', 'WHERE', 'SIGNATURE'],
              r.hits.map((h) => [
                String(h.score),
                h.kind === 'symbol' ? (h.symbol_kind ?? 'symbol') : 'file',
                h.name,
                h.line ? `${h.path}:${h.line}` : h.path,
                h.signature ?? '',
              ]),
              { maxWidth: 60 },
            )
          : 'Nothing found.',
      );
    });
  graph
    .command('reindex')
    .description('forget every parsed file and build the graph again')
    .action(async () => {
      const { client } = operator(g());
      const s = await client.post<Summary>(client.projectPath('/graph/reindex'), {}, { timeoutMs: 300_000 });
      out(g(), s, () => renderSummary(s));
    });
}
