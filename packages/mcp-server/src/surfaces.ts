/**
 * The handoff's surfaces as Friday tools (ADR-0038 §1): views over the code graph, the raw output
 * Friday keeps, and a lesson learned from a failure. None is always loaded; none is in the spawned
 * set. Each handler is one call of the daemon, which bounds and redacts the answer and names what it
 * describes (the graph's version, the artifact, the failure).
 */
import { FridayError, type ResultOf } from '@friday/protocol';
import { z } from 'zod';
import type { FridaySession } from './session.js';
import type { FridayTool, ToolResult } from './tools.js';

type SymbolEdge = NonNullable<ResultOf<'graph.query'>['symbol']>['name_references'][number];

const edgeFrom = (e: SymbolEdge) =>
  `${e.from.path}#${e.from.symbol}:${e.line} (${e.certainty}${e.reason ? `: ${e.reason}` : ''})`;
const edgeTo = (e: SymbolEdge) =>
  e.to
    ? `${e.to.path}#${e.to.symbol} (${e.kind}, ${e.certainty})`
    : `${e.name} (${e.kind}, ${e.certainty}${e.reason ? `: ${e.reason}` : ''})`;

/** A graph answer in words: one block per match, the guesses apart, the graph's version last. */
export function graphQueryText(r: ResultOf<'graph.query'>): string {
  const lines: string[] = [];
  if (r.asked === 'symbol' && r.symbol) {
    const s = r.symbol;
    if (!s.matches.length && !s.name_references.length) {
      lines.push(
        `No symbol named ${s.name} in the code graph (TypeScript and JavaScript files git sees, by exact name). Try words instead, or check the spelling.`,
      );
    }
    for (const m of s.matches) {
      const y = m.symbol;
      lines.push(
        `${y.path}:${y.line}-${y.end_line}  ${y.kind}${y.parent ? ` of ${y.parent}` : ''}${y.exported ? ', exported' : ''}`,
        `  ${y.signature}`,
        `  called or used by: ${m.callers.map(edgeFrom).join('; ') || 'nobody the graph can see'}${m.callers_cut ? ` (+${m.callers_cut} more)` : ''}`,
        `  uses: ${m.callees.map(edgeTo).join('; ') || 'nothing the graph can see'}${m.callees_cut ? ` (+${m.callees_cut} more)` : ''}`,
        `  tests of its file: ${m.tests.join(', ') || 'none'}`,
      );
    }
    if (s.matches_cut) lines.push(`(${s.matches_cut} more symbols named ${s.name})`);
    if (s.name_references.length) {
      lines.push(
        `Name-only matches (member calls on values the graph does not know; guesses): ${s.name_references.map((e) => `${e.from.path}:${e.line} in ${e.from.symbol}`).join('; ')}`,
      );
    }
  } else if (r.asked === 'file' && r.file) {
    const f = r.file;
    const how = (e: (typeof f.dependencies)[number]) =>
      e.certainty === 'exact' ? e.kind : `${e.kind}, ${e.certainty}${e.reason ? `: ${e.reason}` : ''}`;
    lines.push(
      `${f.node.path}  (area ${f.node.area}${f.node.test ? ', test' : ''}${f.node.contract ? `; shared contract of ${f.node.contract.areas.join(', ')}` : ''})`,
      `Imports: ${f.dependencies.map((e) => `${e.to ?? `(${e.specifier ?? 'computed'})`} [${how(e)}]`).join(', ') || 'nothing in the project'}`,
      `Imported by: ${f.consumers.map((e) => `${e.from} [${how(e)}]`).join(', ') || 'nobody'}`,
      `Tests: ${f.tests.join(', ') || 'none import it directly'}`,
      f.node.external.length ? `Outside the project: ${f.node.external.join(', ')}` : '',
      `Nearby: ${f.neighbourhood.map((n) => `${n.path} (${n.distance})`).join(', ') || 'nothing'}`,
    );
  } else if (r.asked === 'search') {
    const hits = r.hits ?? [];
    lines.push(
      hits.length
        ? hits
            .map(
              (h) =>
                `- ${h.kind === 'symbol' ? (h.symbol_kind ?? 'symbol') : 'file'} ${h.name}  ${h.line ? `${h.path}:${h.line}` : h.path}${h.signature ? `  ${h.signature}` : ''}`,
            )
            .join('\n')
        : 'Nothing found.',
    );
  }
  lines.push(`(code graph ${r.version})`);
  return lines.filter(Boolean).join('\n');
}

export function blastRadiusText(r: ResultOf<'graph.blast_radius'>): string {
  const lines = r.seeds.map(
    (s) =>
      `Changed: ${s.path}${s.symbols.length ? ` (${s.symbols.join(', ')})` : ''}${s.breaking.length ? `  breaking: ${s.breaking.join('; ')}` : ''}`,
  );
  lines.push(
    r.affected.length
      ? r.affected
          .map(
            (a) =>
              `- ${a.distance} ${a.confidence}: ${a.symbol ? `${a.path}#${a.symbol}` : a.path} via ${a.via} from ${a.from}`,
          )
          .join('\n')
      : 'Nothing the graph can see depends on it.',
    `Depth ${r.depth}${r.cut ? `; ${r.cut} more not shown` : ''}${r.name_matches_included ? '; name-only matches included (guesses)' : '; name-only matches left out (names: true)'}. (code graph ${r.version})`,
  );
  return lines.join('\n');
}

export function skeletonText(r: ResultOf<'graph.skeleton'>): string {
  const parts = r.files.map(
    (f) => `${f.path} (L${f.level}: ${f.lines} lines, ${f.folded} folded${f.cut ? ', cut' : ''})\n${f.text}`,
  );
  for (const m of r.missing) parts.push(`${m.path}: ${m.reason}`);
  parts.push(`(code graph ${r.version})`);
  return parts.join('\n\n');
}

export function artifactText(r: ResultOf<'artifact.read'>): string {
  const range = r.to ? `lines ${r.from}-${r.to} of ${r.lines_total}` : `no line of ${r.lines_total}`;
  const head = `${r.artifact_ref} (${r.kind} ${r.of.id}${r.of.task_id ? ` of ${r.of.task_id}` : ''}): ${range}${r.matched !== null ? `; ${r.matched} matched` : ''}${r.truncated ? `; more: ask again with offset ${r.to + 1}` : ''}.`;
  return r.text ? `${head}\n${r.text}` : head;
}

/** The kinds a lesson from a failure may have (ADR-0038 §5). */
const FAILURE_LESSON_KINDS = ['learned-risk', 'bug-pattern', 'operational-runbook'] as const;

export function createSurfaceTools(session: FridaySession): FridayTool[] {
  const call = async <T>(fn: (client: Awaited<ReturnType<FridaySession['ready']>>) => Promise<T>): Promise<T> =>
    fn(await session.ready());
  return [
    {
      name: 'friday_graph_query',
      title: 'Ask the code graph',
      description:
        'One question of the code graph of your checkout (TypeScript and JavaScript files git sees): a symbol by name (where it is, its signature, who calls or uses it, what it uses, its tests), a file by path (what it imports, who imports it, its tests, its neighbourhood), or symbols and files by words. Exactly one of name, path or words. Answers are bounded and name the graph version they describe; nothing here is guessed, and name-only matches are labelled as guesses.',
      shape: {
        name: z.string().min(1).max(200).optional(),
        path: z.string().min(1).max(500).optional(),
        words: z.string().min(1).max(200).optional(),
        in_path: z.string().max(500).optional().describe('with name: only in this file'),
        prefix: z.string().max(500).optional().describe('with name: only under this folder'),
        depth: z.number().int().min(1).max(5).optional().describe('with path: how far the neighbourhood reaches'),
        kind: z.enum(['symbol', 'file']).optional().describe('with words: only this kind of hit'),
        limit: z.number().int().min(1).max(100).optional(),
      },
      alwaysLoad: false,
      readOnly: true,
      handler: async (a): Promise<ToolResult> => {
        const asked = ['name', 'path', 'words'].filter((k) => typeof a[k] === 'string' && (a[k] as string).trim());
        if (asked.length !== 1) throw new FridayError('invalid_request', 'ask one question: name, path or words');
        const res = await call((c) =>
          c.call('graph.query', {
            ...(a.name ? { name: a.name as string } : {}),
            ...(a.path ? { path: a.path as string } : {}),
            ...(a.words ? { words: a.words as string } : {}),
            ...(a.in_path ? { in_path: a.in_path as string } : {}),
            ...(a.prefix ? { prefix: a.prefix as string } : {}),
            ...(a.depth ? { depth: a.depth as number } : {}),
            ...(a.kind ? { kind: a.kind as 'symbol' } : {}),
            ...(a.limit ? { limit: a.limit as number } : {}),
          }),
        );
        return { text: graphQueryText(res), structured: res as unknown as Record<string, unknown> };
      },
    },
    {
      name: 'friday_blast_radius',
      title: 'What a change would reach',
      description:
        'Before changing a shared symbol or file: what depends on it upstream, to a depth, each hit with a confidence (high: exact edges, medium: inferred, low: name-only guesses, included only with names: true). Seed it with paths, symbols as "file#name", or diff: true for the files your working tree changed. It lists; it judges nothing.',
      shape: {
        paths: z.array(z.string().min(1).max(500)).max(50).optional(),
        symbols: z.array(z.string().min(1).max(700)).max(50).optional().describe('as file#name'),
        diff: z.boolean().optional().describe("the working tree's changed files as seeds"),
        depth: z.number().int().min(1).max(5).optional().describe('default 2'),
        names: z.boolean().optional().describe('include name-only matches (guesses)'),
      },
      alwaysLoad: false,
      readOnly: true,
      handler: async (a): Promise<ToolResult> => {
        const res = await call((c) =>
          c.call('graph.blast_radius', {
            paths: (a.paths as string[] | undefined) ?? [],
            symbols: (a.symbols as string[] | undefined) ?? [],
            diff: Boolean(a.diff),
            ...(a.depth ? { depth: a.depth as number } : {}),
            names: Boolean(a.names),
          }),
        );
        return { text: blastRadiusText(res), structured: res as unknown as Record<string, unknown> };
      },
    },
    {
      name: 'friday_skeleton_read',
      title: 'Read files with their bodies folded',
      description:
        "Up to five files with their bodies folded, line numbers kept: level 1 keeps imports, exports and each declaration's first line; level 2 also keeps doc comments and exported types whole. A context view, cheaper than reading the file; read the file itself before editing it. Files the graph does not hold (not TypeScript or JavaScript git sees) are named back.",
      shape: {
        paths: z.array(z.string().min(1).max(500)).min(1).max(5),
        level: z.number().int().min(1).max(2).optional(),
      },
      alwaysLoad: false,
      readOnly: true,
      handler: async (a): Promise<ToolResult> => {
        const res = await call((c) =>
          c.call('graph.skeleton', {
            paths: a.paths as string[],
            level: a.level === 2 ? 2 : 1,
          }),
        );
        return { text: skeletonText(res), structured: res as unknown as Record<string, unknown> };
      },
    },
    {
      name: 'friday_ccr_retrieve',
      title: 'Read raw output',
      description:
        'The whole, redacted output behind a filtered result, when the summary and the end of the output are not enough: an artifact reference ("artifact:<id>") named by friday_run_operation, by a verification check of your task, or by a message to you. Bounded: offset (a line, from 1), limit (lines, at most 400), find (only the lines containing the text, numbered); at most 16,000 characters per call, and the answer says how to read on. Only the output of your own work.',
      shape: {
        artifact_ref: z.string().regex(/^artifact:[A-Za-z0-9_-]+$/),
        offset: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(400).optional(),
        find: z.string().min(1).max(200).optional(),
      },
      alwaysLoad: false,
      readOnly: true,
      handler: async (a): Promise<ToolResult> => {
        const res = await call((c) =>
          c.call('artifact.read', {
            artifact_ref: a.artifact_ref as string,
            ...(a.offset ? { offset: a.offset as number } : {}),
            ...(a.limit ? { limit: a.limit as number } : {}),
            ...(a.find ? { find: a.find as string } : {}),
          }),
        );
        return { text: artifactText(res), structured: res as unknown as Record<string, unknown> };
      },
    },
    {
      name: 'friday_mem_learn_from_failure',
      title: 'Learn from a failure',
      description:
        "After a failure of your task was resolved (a verification Friday refused, an operation that failed): propose what the project should learn from it. Friday records the failure it came from in its own words as the lesson's origin; the lesson reaches other agents only once a human approves it or your task's verification passes. kind: learned-risk (default), bug-pattern or operational-runbook; paths: what it is about; failure: the verification (default: your task's latest failed one) or an operation run by id.",
      shape: {
        subject: z.string().min(1).max(200),
        content: z.string().min(1).max(4000),
        kind: z.enum(FAILURE_LESSON_KINDS).optional(),
        paths: z.array(z.string().min(1).max(300)).max(20).optional(),
        tags: z.array(z.string().min(1).max(64)).max(10).optional(),
        failure: z.object({ kind: z.enum(['verification', 'operation']), id: z.string().min(1).optional() }).optional(),
        task_id: z.string().optional().describe('the task the failure belongs to, when you hold none'),
      },
      alwaysLoad: false,
      readOnly: false,
      handler: async (a): Promise<ToolResult> => {
        const client = await session.ready();
        const me = await session.me().catch(() => undefined);
        // The task: the one held, else the one named, else the one reserved for this agent after rework.
        const reserved = me?.claimable.filter((t) => t.reserved_for_agent_key === me.agent.agent_key) ?? [];
        const taskId =
          (a.task_id as string | undefined) ??
          me?.current_task?.task_id ??
          (reserved.length === 1 ? reserved[0]?.task_id : undefined);
        const failure = (a.failure as { kind: 'verification' | 'operation'; id?: string } | undefined) ?? {
          kind: 'verification',
        };
        const res = await client.call('learning.propose', {
          kind: (a.kind as (typeof FAILURE_LESSON_KINDS)[number] | undefined) ?? 'learned-risk',
          subject: a.subject as string,
          content: a.content as string,
          tags: (a.tags as string[] | undefined) ?? [],
          paths: (a.paths as string[] | undefined) ?? [],
          ...(taskId ? { task_id: taskId } : {}),
          from_failure: { kind: failure.kind, ...(failure.id ? { id: failure.id } : {}) },
          idempotency_key: `learn_failure:${JSON.stringify([taskId, a.subject, a.content, failure])}`.slice(0, 200),
        });
        const p = res.proposal;
        const origin = p.origin ? `${p.origin.kind} ${p.origin.id} (${p.origin.detail})` : 'the failure';
        return {
          text: `Proposed ${p.proposal_id} for the whole project, learned from ${origin}. It reaches other agents once a human approves it or your task passes verification; the failure itself promotes nothing.`,
          structured: res as unknown as Record<string, unknown>,
        };
      },
    },
  ];
}

/** The tools of ADR-0038 §1 and the daemon capability each needs (`GET /me` says which it has). */
export const SURFACE_TOOL_CAPABILITY: Record<string, 'graph' | 'artifacts'> = {
  friday_graph_query: 'graph',
  friday_blast_radius: 'graph',
  friday_skeleton_read: 'graph',
  friday_ccr_retrieve: 'artifacts',
};
