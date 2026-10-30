import { createInterface } from 'node:readline/promises';
import type { IntentItem, ProjectIntentProposeRequest, ProjectIntentView } from '@friday/protocol';
import type { DaemonClient } from '@friday/sdk';
import { type Command, Option } from 'commander';
import { type GlobalOptions, operator, out, UsageError } from './context.js';
import { shortTime, table } from './output.js';

/** What the whole project is for (ADR-0034 §1–§2): drafted, asked or edited, then approved by you. */

const collect = (v: string, prev: string[] = []) => [...prev, v];

const LISTS = [
  ['constraints', 'constraint', 'must always hold / never happen'],
  ['outcomes', 'outcome', 'success looks like'],
  ['non_goals', 'non-goal', 'deliberately not doing'],
  ['definition_of_done', 'done when', 'the quality bar'],
] as const;
type ListKey = (typeof LISTS)[number][0];

interface IntentState {
  approved: ProjectIntentView | null;
  proposed: ProjectIntentView | null;
}

function renderIntent(v: ProjectIntentView): string {
  const who = v.proposed_by.kind === 'master_brain' ? 'drafted by Friday' : `written by ${v.proposed_by.id}`;
  const lines = [`Project intent v${v.version}  ${v.status}  (${who}, ${shortTime(v.created_at)})`, `  ${v.objective}`];
  for (const [key, label] of LISTS) {
    for (const item of v[key]) {
      const from = item.source === 'planner' ? ` (Friday, from ${item.from_paths.join(', ') || 'the repository'})` : '';
      lines.push(`  ${label}: ${item.text}${from}`);
    }
  }
  if (v.decided_by) {
    lines.push(
      `  ${v.status === 'rejected' ? 'rejected' : 'approved'} by ${v.decided_by.id}${v.decision_note ? `: ${v.decision_note}` : ''}`,
    );
  }
  return lines.join('\n');
}

function renderState(s: IntentState): string {
  const lines: string[] = [];
  if (s.approved) lines.push(renderIntent(s.approved));
  else lines.push('No approved project intent yet: agents work without one until you approve a version.');
  if (s.proposed) {
    lines.push(
      '',
      'Waiting for your decision:',
      renderIntent(s.proposed),
      `  approve: friday intent approve   change it: friday intent edit ...   reject: friday intent reject`,
    );
  } else if (!s.approved) {
    lines.push(
      '',
      'Get one: "friday intent draft" (Friday drafts it from your README and docs)',
      '     or: "friday intent ask" (answer five short questions).',
    );
  }
  return lines.join('\n');
}

async function intentState(client: DaemonClient): Promise<IntentState> {
  return client.get<IntentState>(client.projectPath('/intent'));
}

/** Keeps a line's provenance when it is unchanged, so a kept suggestion stays marked as Friday's. */
const asInput = (items: IntentItem[]) =>
  items.map((i) => (i.from_paths.length ? { text: i.text, from_paths: i.from_paths } : i.text));

async function propose(client: DaemonClient, body: ProjectIntentProposeRequest): Promise<ProjectIntentView> {
  return client.post<ProjectIntentView>(client.projectPath('/intent'), body);
}

/** Lines typed one per row; an empty row ends the list. */
async function askList(rl: ReturnType<typeof createInterface>, question: string): Promise<string[]> {
  process.stdout.write(`\n${question}\n  (one per line; press Enter on an empty line when done)\n`);
  const lines: string[] = [];
  for (;;) {
    const line = (await rl.question('  > ')).trim();
    if (!line) return lines;
    lines.push(line);
  }
}

async function versionOrProposed(client: DaemonClient, version: string | undefined): Promise<number> {
  if (version) {
    const n = Number(version.replace(/^v/, ''));
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`not a version: ${version}`);
    return n;
  }
  const s = await intentState(client);
  if (!s.proposed) throw new UsageError('no project intent is waiting for a decision; see "friday intent"');
  return s.proposed.version;
}

export function registerIntentCommands(program: Command, g: () => GlobalOptions): void {
  const intent = program
    .command('intent')
    .description('what the whole project is for: every agent sees the version you approve')
    .action(async () => {
      const { client } = operator(g());
      const s = await intentState(client);
      out(g(), s, () => renderState(s));
    });

  intent
    .command('history')
    .description('every version of the project intent, newest first')
    .action(async () => {
      const { client } = operator(g());
      const { versions } = await client.get<{ versions: ProjectIntentView[] }>(client.projectPath('/intent/versions'));
      out(g(), { versions }, () =>
        versions.length
          ? table(
              ['VERSION', 'STATUS', 'BY', 'WHEN', 'OBJECTIVE'],
              versions.map((v) => [`v${v.version}`, v.status, v.proposed_by.id, shortTime(v.created_at), v.objective]),
              { maxWidth: 80 },
            )
          : 'No project intent yet.',
      );
    });

  intent
    .command('draft')
    .description('ask Friday to draft the project intent from your README and docs; you approve it after')
    .option('--force', 'draft even while another proposal waits (it replaces that proposal)')
    .option(
      '--feedback <text>',
      'tell Friday what to change in the waiting proposal (or the approved intent); it drafts a new version from that',
    )
    .option(
      '--from <version>',
      'with --feedback: the version to revise (default: the waiting proposal, else the approved one)',
    )
    .action(async (o: { force?: boolean; feedback?: string; from?: string }) => {
      if (o.from !== undefined && !o.feedback) throw new UsageError('--from needs --feedback');
      const from = o.from === undefined ? undefined : Number(o.from);
      if (from !== undefined && !(Number.isInteger(from) && from > 0)) {
        throw new UsageError(`--from: not a version: ${o.from}`);
      }
      const { client } = operator(g());
      const r = await client.post<{ result: string; proposed: ProjectIntentView | null }>(
        client.projectPath('/intent/draft'),
        {
          force: Boolean(o.force),
          ...(o.feedback ? { feedback: o.feedback } : {}),
          ...(from !== undefined ? { from } : {}),
        },
        { timeoutMs: 600_000 },
      );
      out(g(), r, () => {
        if (r.result.startsWith('proposed') && r.proposed) {
          return [
            renderIntent(r.proposed),
            '',
            'Approve it: friday intent approve   change it first: friday intent draft --feedback "..." (or friday intent edit ...)   reject: friday intent reject',
          ].join('\n');
        }
        return [
          `Friday did not draft an intent: ${r.result}`,
          'You can answer five questions instead: friday intent ask',
        ].join('\n');
      });
    });

  intent
    .command('ask')
    .description('answer five short questions; your answers become a proposal you can approve')
    .option('--approve', 'approve your answers right away')
    .action(async (o: { approve?: boolean }) => {
      if (!process.stdin.isTTY) {
        throw new UsageError('"friday intent ask" needs a terminal; use "friday intent edit --objective ..." instead');
      }
      const { client } = operator(g());
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      let body: ProjectIntentProposeRequest;
      try {
        process.stdout.write('Five short questions about this project. Plain words are best.\n');
        let objective = '';
        while (!objective) {
          objective = (await rl.question('\n1. What is this project for, and for whom?\n  > ')).trim();
        }
        body = {
          objective,
          constraints: await askList(rl, '2. What must always be true, or must never happen? (e.g. "never show ads")'),
          outcomes: await askList(rl, '3. What does success look like for the people who use it?'),
          non_goals: await askList(rl, '4. What is this project deliberately NOT doing? (e.g. "no social feeds")'),
          definition_of_done: await askList(rl, '5. When is a piece of work "done"? (e.g. "build and tests pass")'),
        };
      } finally {
        rl.close();
      }
      let v = await propose(client, body);
      if (o.approve && v.status === 'proposed') {
        v = await client.post<ProjectIntentView>(client.projectPath(`/intent/versions/${v.version}/approve`), {});
      }
      out(g(), v, () =>
        [renderIntent(v), ...(v.status === 'proposed' ? ['', 'Approve it: friday intent approve'] : [])].join('\n'),
      );
    });

  intent
    .command('edit')
    .description(
      'propose a changed version, starting from the waiting proposal or the approved one; each list you give replaces that list',
    )
    .option('--objective <text>', 'what the project is for, and for whom')
    .option('--constraint <text>', 'must always hold or never happen (repeatable)', collect, [])
    .option('--outcome <text>', 'what success looks like (repeatable)', collect, [])
    .option('--non-goal <text>', 'what the project deliberately does not do (repeatable)', collect, [])
    .option('--done <text>', 'the quality bar for finished work (repeatable)', collect, [])
    .addOption(
      new Option('--clear <list>', 'empty a list (repeatable)')
        .choices(['constraints', 'outcomes', 'non-goals', 'done'])
        .argParser(collect)
        .default([]),
    )
    .option('--approve', 'approve the new version right away')
    .action(
      async (o: {
        objective?: string;
        constraint: string[];
        outcome: string[];
        nonGoal: string[];
        done: string[];
        clear: string[];
        approve?: boolean;
      }) => {
        const { client } = operator(g());
        const s = await intentState(client);
        const base = s.proposed ?? s.approved;
        const objective = o.objective ?? base?.objective;
        if (!objective) throw new UsageError('there is no intent to start from yet: give --objective');
        const given: Record<ListKey, string[]> = {
          constraints: o.constraint,
          outcomes: o.outcome,
          non_goals: o.nonGoal,
          definition_of_done: o.done,
        };
        const clearName: Record<ListKey, string> = {
          constraints: 'constraints',
          outcomes: 'outcomes',
          non_goals: 'non-goals',
          definition_of_done: 'done',
        };
        const lists = Object.fromEntries(
          LISTS.map(([key]) => {
            if (given[key].length) return [key, given[key]];
            if (o.clear.includes(clearName[key])) return [key, []];
            return [key, base ? asInput(base[key]) : []];
          }),
        ) as Record<ListKey, ProjectIntentProposeRequest['constraints']>;
        let v = await propose(client, { objective, ...lists });
        const unchanged = base !== null && v.version === base.version;
        if (o.approve && v.status === 'proposed') {
          v = await client.post<ProjectIntentView>(client.projectPath(`/intent/versions/${v.version}/approve`), {});
        }
        out(g(), v, () =>
          [
            ...(unchanged ? ['Nothing changed: this is what the intent already says.'] : []),
            renderIntent(v),
            ...(v.status === 'proposed' ? ['', 'Approve it: friday intent approve'] : []),
          ].join('\n'),
        );
      },
    );

  for (const [verb, past] of [
    ['approve', 'approved'],
    ['reject', 'rejected'],
  ] as const) {
    intent
      .command(`${verb} [version]`)
      .description(
        verb === 'approve'
          ? 'approve the waiting proposal (or a version): from now on every agent sees it'
          : 'reject the waiting proposal (or a version); the approved intent stays as it is',
      )
      .option('--note <text>', 'why')
      .action(async (version: string | undefined, o: { note?: string }) => {
        const { client } = operator(g());
        const n = await versionOrProposed(client, version);
        const v = await client.post<ProjectIntentView>(
          client.projectPath(`/intent/versions/${n}/${verb}`),
          o.note ? { note: o.note } : {},
        );
        out(
          g(),
          v,
          () => `${past[0]?.toUpperCase()}${past.slice(1)} project intent v${v.version}.\n${renderIntent(v)}`,
        );
      });
  }
}
