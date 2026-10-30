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
    .command('reindex')
    .description('forget every parsed file and build the graph again')
    .action(async () => {
      const { client } = operator(g());
      const s = await client.post<Summary>(client.projectPath('/graph/reindex'), {}, { timeoutMs: 300_000 });
      out(g(), s, () => renderSummary(s));
    });
}
