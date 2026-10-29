import { readFileSync } from 'node:fs';
import type { GoalView, PlanTaskView, PlanVersionView } from '@friday/protocol';
import {
  approveProvider,
  credentialsDir,
  type DaemonClient,
  listSecrets,
  providerApproval,
  providerEndpoint,
  removeSecret,
  revokeProvider,
  secretProtection,
  setProviderEndpoint,
  storeSecret,
} from '@friday/sdk';
import { type Command, Option } from 'commander';
import { parse as parseYaml } from 'yaml';
import { type GlobalOptions, operator, out, project, UsageError } from './context.js';
import { clip, shortTime, table } from './output.js';

/** Goals, plans, the Master Brain and secrets (plan M2, ADR-0013). */

const collect = (v: string, prev: string[] = []) => [...prev, v];

type LiveTask = PlanTaskView & {
  status: string | null;
  waiting_reason: string | null;
  agent_key: string | null;
  reserved_for_agent_key: string | null;
};
type LiveVersion = Omit<PlanVersionView, 'tasks'> & { tasks: LiveTask[] };
type EscalationRow = {
  escalation_id: string;
  task_id: string | null;
  goal_id?: string | null;
  kind?: string | null;
  requested_by_kind?: string | null;
  question: string;
  options: string[] | null;
  details: Record<string, unknown> | null;
};
interface GoalDetail {
  goal: GoalView;
  versions: (Omit<PlanVersionView, 'tasks'> & { task_count: number })[];
  active: LiveVersion | null;
  proposed: LiveVersion | null;
  escalations: EscalationRow[];
  model_calls: { count: number; cost_usd: number };
}

const usd = (n: number) => `$${n.toFixed(n < 0.1 ? 4 : 2)}`;

export function renderPlan(v: LiveVersion): string {
  const keyOf = new Map(v.tasks.filter((t) => t.task_id).map((t) => [t.task_id as string, t.key]));
  const revision = v.version > 1;
  const header = `Plan ${v.plan_id} v${v.version}  ${v.status}  (${v.trigger}; by ${v.proposed_by.kind}${v.prompt_version ? `, prompt ${v.prompt_version}` : ''})`;
  const rows = v.tasks.map((t) => [
    t.key,
    ...(revision ? [t.change] : []),
    t.status ? `${t.status}${t.waiting_reason ? ` (${t.waiting_reason})` : ''}` : 'not created yet',
    t.role,
    t.agent_key ?? (t.reserved_for_agent_key ? `(${t.reserved_for_agent_key})` : ''),
    t.depends_on.map((d) => keyOf.get(d) ?? d).join(', '),
    t.summary,
  ]);
  const lines = [
    header,
    clip(v.summary, 200),
    table(['KEY', ...(revision ? ['CHANGE'] : []), 'STATUS', 'ROLE', 'AGENT', 'AFTER', 'SUMMARY'], rows, {
      maxWidth: 60,
    }),
  ];
  for (const t of v.tasks.filter((x) => x.note && (x.change === 'rework' || x.change === 'drop'))) {
    lines.push(`  ${t.change} ${t.key}: ${clip(t.note as string, 160)}`);
  }
  if (v.needs_human) lines.push(`  Question for a human: ${v.needs_human.question}`);
  return lines.join('\n');
}

export function renderEscalation(e: EscalationRow): string {
  const d = e.details as {
    blocked?: string;
    why?: string;
    capability?: string;
    proposed_action?: string;
    evidence?: string[];
  } | null;
  const lines = [
    `${e.escalation_id}  ${e.kind ?? 'question'}  from ${e.requested_by_kind ?? 'agent'}`,
    `  ${e.question}`,
  ];
  if (e.options?.length) lines.push(...e.options.map((o, i) => `    ${i + 1}. ${o}`));
  if (d) {
    if (d.blocked) lines.push(`  blocked: ${d.blocked}`);
    if (d.why) lines.push(`  why: ${clip(d.why, 200)}`);
    if (d.capability) lines.push(`  needs: ${d.capability}`);
    if (d.proposed_action) lines.push(`  proposed: ${d.proposed_action}`);
    for (const ev of d.evidence ?? []) lines.push(`  evidence: ${clip(ev, 160)}`);
  }
  lines.push(`  answer with: friday answer ${e.escalation_id} "<your answer>"`);
  return lines.join('\n');
}

function renderGoal(d: GoalDetail): string {
  const g = d.goal;
  const lines = [`Goal ${g.goal_id}  ${g.status}  priority ${g.priority}`, `  ${g.request}`];
  if (g.objective) lines.push(`  objective: ${g.objective}`);
  for (const c of g.constraints) lines.push(`  constraint: ${c}`);
  for (const o of g.outcomes) lines.push(`  outcome: ${o}`);
  if (d.versions.length) {
    lines.push(`  versions: ${d.versions.map((v) => `v${v.version} ${v.status}`).join(', ')}`);
  }
  if (d.model_calls.count) lines.push(`  model calls: ${d.model_calls.count}, ${usd(d.model_calls.cost_usd)}`);
  if (d.active) lines.push('', renderPlan(d.active));
  if (d.proposed)
    lines.push(
      '',
      'Waiting for your decision:',
      renderPlan(d.proposed),
      `  approve: friday plan approve --goal ${g.goal_id}   reject: friday plan reject --goal ${g.goal_id}`,
    );
  for (const e of d.escalations) lines.push('', renderEscalation(e));
  return lines.join('\n');
}

async function goalDetail(client: DaemonClient, goalId: string): Promise<GoalDetail> {
  return client.get<GoalDetail>(client.projectPath(`/goals/${goalId}`));
}

/** The goal named on the command line, else the newest open or active one. */
async function resolveGoal(client: DaemonClient, goalId: string | undefined): Promise<string> {
  if (goalId) return goalId;
  const { goals } = await client.get<{ goals: GoalView[] }>(client.projectPath('/goals'));
  const open = goals.filter((x) => x.status === 'OPEN' || x.status === 'ACTIVE');
  const last = open.at(-1);
  if (!last) throw new UsageError('no open goal; create one with "friday goal create <request>" or pass --goal');
  return last.goal_id;
}

async function versionOf(
  client: DaemonClient,
  goalId: string,
  version: number | undefined,
  want: 'proposed' | 'any',
): Promise<LiveVersion> {
  const d = await goalDetail(client, goalId);
  if (!d.goal.plan_id) throw new UsageError(`goal ${goalId} has no plan yet`);
  if (version !== undefined) {
    return client.get<LiveVersion>(client.projectPath(`/plans/${d.goal.plan_id}/versions/${version}`));
  }
  const v = want === 'proposed' ? d.proposed : (d.proposed ?? d.active);
  if (!v)
    throw new UsageError(
      want === 'proposed' ? `goal ${goalId} has no plan waiting for a decision` : `goal ${goalId} has no plan`,
    );
  return v;
}

function readPlanFile(file: string): unknown {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new UsageError(`cannot read ${file}: ${(e as Error).message}`);
  }
  try {
    return /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new UsageError(`${file} is not valid ${/\.json$/i.test(file) ? 'JSON' : 'YAML'}: ${(e as Error).message}`);
  }
}

/** Reads a secret without echoing it: from an environment variable, piped stdin, or a hidden prompt. */
async function readSecretInput(fromEnv: string | undefined, name: string): Promise<string> {
  if (fromEnv) {
    const v = process.env[fromEnv];
    if (!v) throw new UsageError(`environment variable ${fromEnv} is empty or not set`);
    return v;
  }
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let data = '';
    for await (const chunk of stdin) data += String(chunk);
    return data;
  }
  process.stderr.write(`Paste the ${name} key and press Enter (input is hidden): `);
  return new Promise((resolve, reject) => {
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new UsageError('cancelled'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

export function registerGoalCommands(program: Command, g: () => GlobalOptions): void {
  // ---- goals -----------------------------------------------------------------------------------
  const goal = program.command('goal').description('goals the Master Brain plans (M2)');
  goal
    .command('create <request...>')
    .description('create a goal; the Master Brain proposes a plan for you to approve')
    .option('--constraint <text>', 'a constraint the plan must respect (repeatable)', collect, [])
    .option('--outcome <text>', 'an outcome you expect (repeatable)', collect, [])
    .addOption(new Option('--priority <priority>').choices(['low', 'normal', 'high', 'urgent']).default('normal'))
    .option('--no-plan', 'do not ask the Master Brain; you will write the plan ("friday plan propose")')
    .option('--wait <seconds>', 'wait this long for the proposal', (v) => Number.parseInt(v, 10), 120)
    .option('--no-wait', 'return right away')
    .action(
      async (
        request: string[],
        o: { constraint: string[]; outcome: string[]; priority: string; plan: boolean; wait: number | false },
      ) => {
        const { client } = operator(g());
        const created = await client.post<GoalView>(client.projectPath('/goals'), {
          request: request.join(' '),
          constraints: o.constraint,
          outcomes: o.outcome,
          priority: o.priority,
          plan: o.plan,
        });
        let detail = await goalDetail(client, created.goal_id);
        const deadline = Date.now() + (o.plan && o.wait ? o.wait * 1000 : 0);
        while (Date.now() < deadline && !detail.proposed && !detail.active && detail.escalations.length === 0) {
          await new Promise((r) => setTimeout(r, 500));
          detail = await goalDetail(client, created.goal_id);
        }
        out(g(), detail, () => {
          const lines = [renderGoal(detail)];
          if (!o.plan) lines.push('', `Write the plan: friday plan propose --goal ${created.goal_id} --file plan.yaml`);
          else if (!detail.proposed && !detail.active && detail.escalations.length === 0) {
            lines.push('', `The Master Brain is still planning. Check with: friday goal show ${created.goal_id}`);
          }
          return lines.join('\n');
        });
      },
    );
  goal
    .command('show [goal]')
    .description('a goal with its plan, live task states and open questions')
    .action(async (goalId: string | undefined) => {
      const { client } = operator(g());
      const d = await goalDetail(client, await resolveGoal(client, goalId));
      out(g(), d, () => renderGoal(d));
    });
  goal
    .command('replan [goal]')
    .description('ask the Master Brain for a new proposal now')
    .option('--note <text>', 'guidance for the revision')
    .action(async (goalId: string | undefined, o: { note?: string }) => {
      const { client } = operator(g());
      const id = await resolveGoal(client, goalId);
      const res = await client.post<GoalDetail & { result: string }>(
        client.projectPath(`/goals/${id}/replan`),
        o.note ? { note: o.note } : {},
        {
          timeoutMs: 600_000,
        },
      );
      out(g(), res, () => `${res.result}\n\n${renderGoal(res)}`);
    });
  goal
    .command('cancel <goal>')
    .description('cancel a goal and its unfinished tasks')
    .option('--reason <text>')
    .action(async (goalId: string, o: { reason?: string }) => {
      const { client } = operator(g());
      const res = await client.post<GoalView>(
        client.projectPath(`/goals/${goalId}/cancel`),
        o.reason ? { reason: o.reason } : {},
      );
      out(g(), res, () => `${res.goal_id}  ${res.status}`);
    });
  program
    .command('goals')
    .description('list goals')
    .action(async () => {
      const { client } = operator(g());
      const { goals } = await client.get<{ goals: GoalView[] }>(client.projectPath('/goals'));
      out(g(), goals, () =>
        goals.length
          ? table(
              ['GOAL', 'STATUS', 'PRIORITY', 'CREATED', 'REQUEST'],
              goals.map((x) => [x.goal_id, x.status, x.priority, shortTime(x.created_at), x.request]),
              { maxWidth: 70 },
            )
          : 'No goals yet. Create one: friday goal create "<what you want>"',
      );
    });

  // ---- plans -----------------------------------------------------------------------------------
  const plan = program
    .command('plan')
    .description("show a goal's plan (default: the newest open goal)")
    .option('--goal <goal>')
    .option('--version <n>', 'a specific version', (v) => Number.parseInt(v, 10))
    .action(async (o: { goal?: string; version?: number }) => {
      const { client } = operator(g());
      const id = await resolveGoal(client, o.goal);
      if (o.version !== undefined) {
        const v = await versionOf(client, id, o.version, 'any');
        out(g(), v, () => renderPlan(v));
        return;
      }
      const d = await goalDetail(client, id);
      out(g(), d, () => renderGoal(d));
    });
  const decide = (verb: 'approve' | 'reject') =>
    plan
      .command(verb)
      .description(
        verb === 'approve'
          ? 'approve the proposed version: its tasks are created and delegated'
          : 'reject the proposed version',
      )
      .option('--goal <goal>')
      .option('--version <n>', 'the version (default: the one waiting for a decision)', (v) => Number.parseInt(v, 10))
      .option('--note <text>')
      .action(async (o: { goal?: string; version?: number; note?: string }) => {
        const { client } = operator(g());
        const id = await resolveGoal(client, o.goal);
        const v = await versionOf(client, id, o.version, 'proposed');
        const res = await client.post<{ plan: LiveVersion; created?: { task_id: string }[] }>(
          client.projectPath(`/plans/${v.plan_id}/versions/${v.version}/${verb}`),
          o.note ? { note: o.note } : {},
        );
        const plan = 'plan' in res && res.plan ? res.plan : (res as unknown as LiveVersion);
        out(g(), res, () =>
          [
            verb === 'approve'
              ? `Approved ${v.plan_id} v${v.version}; ${res.created?.length ?? 0} task(s) created.`
              : `Rejected ${v.plan_id} v${v.version}.`,
            '',
            renderPlan(plan),
          ].join('\n'),
        );
      });
  decide('approve');
  decide('reject');
  plan
    .command('diff <from> <to>')
    .description("what changed between two versions of a goal's plan")
    .option('--goal <goal>')
    .action(async (from: string, to: string, o: { goal?: string }) => {
      const { client } = operator(g());
      const d = await goalDetail(client, await resolveGoal(client, o.goal));
      if (!d.goal.plan_id) throw new UsageError('this goal has no plan');
      const res = await client.get<{
        diff: {
          added: { key: string; summary: string }[];
          dropped: { key: string; note: string | null }[];
          reworked: { key: string; note: string | null }[];
          changed: { task: { key: string }; fields: string[] }[];
          unchanged: number;
        };
      }>(client.projectPath(`/plans/${d.goal.plan_id}/diff`), {
        query: { from: from.replace(/^v/, ''), to: to.replace(/^v/, '') },
      });
      const x = res.diff;
      out(g(), res, () =>
        [
          ...x.added.map((t) => `+ ${t.key}: ${t.summary}`),
          ...x.reworked.map((t) => `~ ${t.key} (rework): ${t.note ?? ''}`),
          ...x.dropped.map((t) => `- ${t.key} (dropped): ${t.note ?? ''}`),
          ...x.changed.map((c) => `~ ${c.task.key}: ${c.fields.join(', ')} changed`),
          `${x.unchanged} task(s) unchanged`,
        ].join('\n'),
      );
    });
  plan
    .command('propose')
    .description("propose a plan you wrote (YAML or JSON); validated like a model's plan")
    .requiredOption('--goal <goal>')
    .requiredOption(
      '--file <path>',
      'a plan (objective, summary, tasks) or, for an active plan, a revision (rework, drop, new_tasks)',
    )
    .action(async (o: { goal: string; file: string }) => {
      const { client } = operator(g());
      const v = await client.post<LiveVersion>(client.projectPath(`/goals/${o.goal}/plans`), {
        draft: readPlanFile(o.file),
      });
      out(g(), v, () => `${renderPlan(v)}\n\nApprove with: friday plan approve --goal ${o.goal}`);
    });

  // ---- the Master Brain ------------------------------------------------------------------------
  const brain = program.command('brain').description('the Master Brain (M2)');
  brain
    .command('status')
    .description('provider, model, consent, key, budget and progress')
    .action(async () => {
      const { client } = operator(g());
      const s = await client.get<Record<string, unknown>>(client.projectPath('/brain'));
      out(g(), s, () =>
        [
          `Master Brain: ${s.provider} / ${s.model}  ${s.planner_available ? 'ready to plan' : `cannot plan: ${s.reason}`}`,
          `Remote calls: ${
            !s.remote
              ? 'not needed'
              : !s.allow_remote
                ? 'off for this project (set providers.anthropic.allow_remote: true)'
                : s.approved_here
                  ? 'allowed (the project asks for them and you allowed them here)'
                  : 'the project asks for them; allow them on this machine with "friday brain allow-remote"'
          }`,
          s.remote ? `Endpoint: ${s.endpoint}` : '',
          s.ignored_base_url ? `Ignored: providers.anthropic.base_url (${s.ignored_base_url}) in config.yaml` : '',
          `API key: ${s.key}`,
          `Plans need your approval: ${s.auto_approve ? 'no (auto_approve)' : 'yes'}`,
          `Escalates after ${s.escalate_after_failures} verification failures; at most ${s.max_replans} revisions per goal`,
          `Spent today: ${usd(Number(s.spent_today_usd))} of ${usd(Number(s.daily_budget_usd))}`,
          `Events read: ${s.cursor} of ${s.head}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    });
  brain
    .command('allow-remote')
    .description("let this clone use your provider key (the project's config must ask for it too)")
    .option('--provider <name>', 'provider', 'anthropic')
    .option('--budget <usd>', "a daily budget below the project's", Number.parseFloat)
    .action((o: { provider: string; budget?: number }) => {
      const ref = project(g());
      if (o.budget !== undefined && !(o.budget >= 0)) throw new UsageError('--budget must be a number of dollars');
      const a = approveProvider(ref, o.provider, { daily_budget_usd: o.budget ?? null });
      const asked = ref.config.providers[o.provider]?.allow_remote ?? false;
      out(g(), { provider: o.provider, project: ref.project_id, ...a, project_allows: asked }, () =>
        [
          `This clone of ${ref.name} may now use your ${o.provider} key${o.budget !== undefined ? ` (at most ${usd(o.budget)} a day)` : ''}.`,
          asked
            ? 'The project allows remote calls too, so the Master Brain can plan.'
            : `The project does not ask for remote calls yet: set providers.${o.provider}.allow_remote: true in .friday/config.yaml.`,
        ].join('\n'),
      );
    });
  brain
    .command('deny-remote')
    .description('stop this clone from using your provider key')
    .option('--provider <name>', 'provider', 'anthropic')
    .action((o: { provider: string }) => {
      const ref = project(g());
      const removed = revokeProvider(ref, o.provider);
      out(g(), { provider: o.provider, removed }, () =>
        removed ? `This clone no longer uses your ${o.provider} key.` : `This clone was not allowed to use it.`,
      );
    });
  brain
    .command('run-once')
    .description('process pending events now and show what the Master Brain did')
    .action(async () => {
      const { client } = operator(g());
      const r = await client.post<{
        processed: number;
        steps: { event?: string; sequence?: number; action: string; result: string }[];
      }>(client.projectPath('/brain/run-once'), {}, { timeoutMs: 600_000 });
      out(g(), r, () =>
        [
          `${r.processed} event(s) processed`,
          ...r.steps.map((s) => `  ${s.sequence ? `#${s.sequence} ${s.event} -> ` : ''}${s.action}: ${s.result}`),
        ].join('\n'),
      );
    });
  brain
    .command('calls')
    .description('model calls with tokens and cost')
    .option('--goal <goal>')
    .option('--limit <n>', 'how many', (v) => Number.parseInt(v, 10), 20)
    .action(async (o: { goal?: string; limit: number }) => {
      const { client } = operator(g());
      const r = await client.get<{
        calls: {
          call_id: string;
          created_at: string;
          purpose: string;
          model: string;
          status: string;
          input_tokens: number;
          output_tokens: number;
          cache_creation_input_tokens: number;
          cache_read_input_tokens: number;
          cost_usd: number | null;
          cost_estimate_usd: number | null;
        }[];
        cost_usd: number;
        unknown_cost_calls?: number;
        estimated_usd?: number;
      }>(client.projectPath('/model-calls'), {
        query: { limit: String(o.limit), ...(o.goal ? { goal: o.goal } : {}) },
      });
      out(g(), r, () =>
        r.calls.length
          ? [
              table(
                ['CALL', 'TIME', 'PURPOSE', 'MODEL', 'STATUS', 'IN', 'OUT', 'CACHE W/R', 'COST'],
                r.calls.map((c) => [
                  c.call_id,
                  shortTime(c.created_at),
                  c.purpose,
                  c.model,
                  c.status,
                  c.input_tokens,
                  c.output_tokens,
                  `${c.cache_creation_input_tokens}/${c.cache_read_input_tokens}`,
                  c.cost_usd === null
                    ? `unknown${c.cost_estimate_usd !== null ? ` (<= ${usd(c.cost_estimate_usd)})` : ''}`
                    : usd(c.cost_usd),
                ]),
              ),
              `Total: ${usd(r.cost_usd)}${r.unknown_cost_calls ? `, plus ${r.unknown_cost_calls} call(s) of unknown cost (counted at up to ${usd(r.estimated_usd ?? 0)})` : ''}`,
            ].join('\n')
          : 'No model calls yet.',
      );
    });

  // ---- secrets (per user, no daemon needed) ----------------------------------------------------
  const secrets = program
    .command('secrets')
    .description('provider keys, stored for this user outside every repository');
  secrets
    .command('set <name>')
    .description('store a key (hidden prompt, piped stdin, or --from-env); --base-url alone changes only the endpoint')
    .option('--from-env <variable>', 'read the key from this environment variable')
    .option(
      '--base-url <url>',
      "send this key to another endpoint (a proxy or gateway you trust) instead of the provider's",
    )
    .option('--default-endpoint', "send this key to the provider's own endpoint again")
    .option('--endpoint-only', 'change the endpoint without storing a new key')
    .action(
      async (
        name: string,
        o: { fromEnv?: string; baseUrl?: string; defaultEndpoint?: boolean; endpointOnly?: boolean },
      ) => {
        // The endpoint is a per-user choice: a tracked config file must not pick where the key goes (review F03).
        if (o.baseUrl && o.defaultEndpoint) throw new UsageError('use --base-url or --default-endpoint, not both');
        if (o.baseUrl) setProviderEndpoint(name, o.baseUrl);
        if (o.defaultEndpoint) setProviderEndpoint(name, null);
        const endpoint = providerEndpoint(name) ?? 'the provider default';
        if (o.endpointOnly) {
          out(g(), { name, endpoint }, () => `The ${name} key is sent to ${endpoint}.`);
          return;
        }
        const value = await readSecretInput(o.fromEnv, name);
        // DPAPI on Windows (ADR-0029 §2), else a file only this user can read.
        const stored = await storeSecret(name, value);
        const chars = value.trim().length;
        let approved = false;
        try {
          approved = Boolean(providerApproval(project(g()), name));
        } catch {
          // not inside a Friday project
        }
        const how =
          stored.protection === 'dpapi'
            ? 'encrypted for this Windows user (DPAPI)'
            : 'in a file only this user can read';
        out(g(), { name, stored: true, chars, dir: credentialsDir(), endpoint, protection: stored.protection }, () =>
          [
            `Stored the ${name} key (${chars} characters) ${how}, in ${credentialsDir()}; it is sent to ${endpoint}.`,
            stored.note ?? '',
            name === 'anthropic' && !approved
              ? 'To plan with it, the project needs providers.anthropic.allow_remote: true, and you allow each clone with "friday brain allow-remote".'
              : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      },
    );
  secrets
    .command('list')
    .description('names of stored keys (never their values)')
    .action(() => {
      const rows = listSecrets().map((name) => ({ name, protection: secretProtection(name) }));
      out(g(), rows, () =>
        rows.length
          ? rows.map((r) => `${r.name}  (${r.protection === 'dpapi' ? 'DPAPI' : 'user-only file'})`).join('\n')
          : 'No keys stored.',
      );
    });
  secrets
    .command('remove <name>')
    .description('delete a stored key')
    .action((name: string) => {
      const removed = removeSecret(name);
      out(g(), { name, removed }, () => (removed ? `Removed the ${name} key.` : `No ${name} key was stored.`));
    });
}
