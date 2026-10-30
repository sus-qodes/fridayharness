import type { ModelEvidenceView, RoutingDecisionView, RoutingPinView, TaskRoleDecisionView } from '@friday/protocol';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out, UsageError } from './context.js';
import { shortTime, table } from './output.js';

/** Model routing (plan M7, ADR-0031): the registry, decisions, and a human's pins. */

interface ModelRow {
  id: string;
  provider: string;
  vendors: string[];
  local: boolean;
  vision: boolean;
  price: { input: number; output: number } | null;
  source: string;
  notes: string | null;
}

/** "7d", "12h", "90m" from now, or an ISO date. */
function untilFrom(text: string): string {
  const m = text.trim().match(/^(\d+)\s*([mhd])$/i);
  if (m) {
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'h').toLowerCase() as 'm' | 'h' | 'd'];
    return new Date(Date.now() + Number(m[1]) * unit).toISOString();
  }
  const t = Date.parse(text);
  if (Number.isNaN(t)) throw new UsageError(`not a duration or a date: ${text} (use 7d, 12h or 2026-10-21)`);
  return new Date(t).toISOString();
}

function decisionLines(
  d: Omit<RoutingDecisionView, 'decision_id' | 'task_id' | 'run_id' | 'harness_id' | 'created_at'>,
): string[] {
  const lines = [
    `${d.model ?? 'no model'} (${d.source}, class ${d.task_class}${d.binding ? ', binding' : ''})`,
    `  role: ${d.role ?? (d.role_proposed ? 'proposed DAG' : 'missing')} (${d.role_source})${
      d.role_confidence !== null ? `, confidence ${d.role_confidence}` : ''
    }${d.role_registry_version ? `, role registry ${d.role_registry_version}` : ''}${
      d.registry_version && d.registry_version !== d.role_registry_version
        ? `, dispatch registry ${d.registry_version}`
        : ''
    }${d.selected_rank !== null ? `, rank ${d.selected_rank}${d.selected_harness ? ` on ${d.selected_harness}` : ''}` : ''}${
      d.role_decision_id ? `, decision ${d.role_decision_id}` : ''
    }`,
    ...(d.role_intent_version ? [`  role intent: ${d.role_intent_version}`] : []),
    `  ${d.reason}`,
  ];
  if (d.constraints.length) lines.push(`  constraints: ${d.constraints.join(', ')}`);
  if (d.candidates.length) {
    lines.push(
      ...d.candidates
        .slice(0, 6)
        .map(
          (c) =>
            `  ${c.model === d.model ? '*' : ' '} ${c.model}: rank ${c.reasons[0]?.replace(/^registry\.rank\(|\)$/g, '') ?? '-'}${c.reasons[1] ? `, ${c.reasons[1]}` : ''}`,
        ),
    );
  }
  for (const e of d.excluded.slice(0, 8)) lines.push(`    excluded ${e.model}: ${e.reason}`);
  // What this machine had seen of each candidate's host and model (ADR-0035 §2).
  for (const r of (d.readiness ?? []).slice(0, 8)) {
    lines.push(`    readiness ${r.host}/${r.model}: ${r.dispatchable ? 'ready' : `not ready, ${r.reason}`}`);
  }
  if (d.fallback_chain.length) {
    lines.push(`  fallback: ${d.fallback_chain.map((f) => f.model ?? 'a human').join(' -> ')}`);
  }
  lines.push(`  codes: ${d.reason_codes.join(', ')} (registry ${d.registry_version ?? '-'})`);
  return lines;
}

export function registerRoutingCommands(program: Command, g: () => GlobalOptions): void {
  program
    .command('models')
    .description("the model registry: Friday's priors, the project's models, and measured outcomes per task class")
    .action(async () => {
      const { client } = operator(g());
      const r = await client.get<{
        models: ModelRow[];
        evidence: ModelEvidenceView[];
      }>(client.projectPath('/models'));
      out(g(), r, () => {
        const lines = [
          table(
            ['MODEL', 'PROVIDER', 'RUNS ON', 'LOCAL', 'VISION', 'PRICE IN/OUT', 'SOURCE'],
            r.models.map((m) => [
              m.id,
              m.provider,
              m.vendors.join(',') || '-',
              m.local ? 'yes' : 'no',
              m.vision ? 'yes' : 'no',
              m.price ? `${m.price.input}/${m.price.output}` : 'unknown',
              m.source,
            ]),
          ),
          'Dispatch order is the static role registry; measured outcomes are reported, not scored.',
        ];
        if (r.evidence.length) {
          lines.push(
            '',
            table(
              ['MODEL', 'CLASS', 'MEASURED', 'VERIFIED', 'MEDIAN TIME', 'ASSUMED', 'OTHER COHORTS'],
              r.evidence.map((e) => [
                e.model,
                e.task_class,
                String(e.samples),
                e.samples ? `${Math.round((e.passed / e.samples) * 100)}%` : '-',
                e.median_duration_ms !== null ? `${Math.round(e.median_duration_ms / 1000)} s` : '-',
                String(e.assumed ?? 0),
                String(e.other_cohorts ?? 0),
              ]),
            ),
            'Measured: the model was seen running, judged by the current checks. Assumed: it was only requested, so it counts for nothing. Other cohorts: other checks, another host version, or past the window.',
          );
        }
        return lines.join('\n');
      });
    });

  const routing = program.command('routing').description('model routing: decisions, explanations and pins');

  routing
    .command('explain <task>')
    .description('why a task was (or would be) routed to a model: candidates, constraints, evidence, fallbacks')
    .action(async (taskId: string) => {
      const { client } = operator(g());
      const r = await client.get<{
        dry_run: Omit<RoutingDecisionView, 'decision_id' | 'task_id' | 'run_id' | 'harness_id' | 'created_at'>;
        decisions: RoutingDecisionView[];
        role_decision: TaskRoleDecisionView | null;
      }>(client.projectPath(`/routing/explain/${taskId}`));
      out(g(), r, () => {
        const lines: string[] = [];
        const role = r.role_decision;
        if (role) {
          lines.push(
            `Role decision ${role.decision_id}: ${role.role ?? role.status} (${role.source}, ${role.status})${
              role.confidence !== null ? `, confidence ${role.confidence}` : ''
            }`,
            `  intent ${role.intent_version}${role.registry_version ? `, registry ${role.registry_version}` : ''}`,
            `  ${role.reason}`,
          );
          if (role.roles.length > 1) {
            lines.push(
              '  proposed DAG (stored, not dispatched):',
              ...role.roles.map(
                (entry) =>
                  `    ${entry.role}${entry.depends_on.length ? ` after ${entry.depends_on.join(', ')}` : ''}: ${entry.task_summary} (${entry.confidence})`,
              ),
            );
          }
          if (role.questions.length) lines.push(`  question: ${role.questions.join('; ')}`);
          lines.push('');
        }
        for (const d of r.decisions) {
          lines.push(`Decided ${shortTime(d.created_at)} for run ${d.run_id ?? '-'}:`, ...decisionLines(d), '');
        }
        lines.push('Now, on any harness (dry run, not recorded):', ...decisionLines(r.dry_run));
        return lines.join('\n');
      });
    });

  routing
    .command('pin')
    .description('pin a model for a task, role, kind or the whole project (it beats registry rank)')
    .option('--task <task>', 'one task')
    .option('--role <role>', 'every task of agents with this role')
    .option('--kind <kind>', 'every task of this kind (implementation, review, …)')
    .option('--model <model>', 'the model to use')
    .option('--sensitive', 'secret-sensitive work: only a model a human pinned may run it')
    .option('--needs-vision', 'only models that see images')
    .option('--until <when>', 'when it expires: 7d, 12h, or a date')
    .option('--note <text>', 'why')
    .action(
      async (o: {
        task?: string;
        role?: string;
        kind?: string;
        model?: string;
        sensitive?: boolean;
        needsVision?: boolean;
        until?: string;
        note?: string;
      }) => {
        const scopes = [o.task && 'task', o.role && 'role', o.kind && 'kind'].filter(Boolean);
        if (scopes.length > 1)
          throw new UsageError('pin one scope: --task, --role or --kind (or none for the project)');
        const scope = (scopes[0] as 'task' | 'role' | 'kind' | undefined) ?? 'project';
        const { client } = operator(g());
        const r = await client.post<{ pin: RoutingPinView }>(client.projectPath('/routing/pins'), {
          scope,
          target: o.task ?? o.role ?? o.kind ?? null,
          model: o.model ?? null,
          sensitive: Boolean(o.sensitive),
          needs_vision: Boolean(o.needsVision),
          until: o.until ? untilFrom(o.until) : null,
          note: o.note ?? null,
        });
        out(g(), r, () => `Pinned ${r.pin.pin_id}: ${pinText(r.pin)}`);
      },
    );

  routing
    .command('pins')
    .description('the pins in force (--all: also expired and removed ones)')
    .option('--all', 'include expired and removed pins')
    .action(async (o: { all?: boolean }) => {
      const { client } = operator(g());
      const r = await client.get<{ pins: RoutingPinView[] }>(client.projectPath('/routing/pins'), {
        query: { all: o.all ? 'true' : undefined },
      });
      out(g(), r, () =>
        r.pins.length ? r.pins.map((p) => `${p.pin_id}  ${pinText(p)}`).join('\n') : 'No routing pins.',
      );
    });

  routing
    .command('unpin <pin>')
    .description('remove a pin')
    .action(async (pinId: string) => {
      const { client } = operator(g());
      const r = await client.post<{ pin: RoutingPinView }>(client.projectPath(`/routing/pins/${pinId}/revoke`), {});
      out(g(), r, () => `Removed ${r.pin.pin_id}.`);
    });
}

function pinText(p: RoutingPinView): string {
  const what = [p.model && `model ${p.model}`, p.sensitive && 'sensitive', p.needs_vision && 'needs vision']
    .filter(Boolean)
    .join(', ');
  const scope = p.scope === 'project' ? 'the project' : `${p.scope} ${p.target}`;
  return `${what} for ${scope}, by ${p.source}${p.until ? ` until ${p.until}` : ''}${p.revoked_at ? ' (removed)' : ''}${p.note ? ` — ${p.note}` : ''}`;
}
