import type { ReadinessEvidenceView, ReadinessRecordRequest, ReadinessReport } from '@friday/protocol';
import { DaemonUnreachableError } from '@friday/sdk';
import type { Command } from 'commander';
import { type GlobalOptions, operator, out } from './context.js';
import type { CheckResult } from './doctor.js';
import { shortTime, table } from './output.js';

/**
 * Runtime readiness (ADR-0035): what this machine has seen of each host and model, the loose-rule
 * verdict routing filters on, and the evidence behind it.
 */

type DoctorStage = 'detected' | 'configured' | 'handshake' | 'authenticated';

/**
 * Which doctor checks speak for which stage, per host. Only hosts whose doctor returns its checks
 * to the CLI are listed; the others show their readiness when a session of theirs connects.
 */
const DOCTOR_STAGE_CHECKS: Record<string, Partial<Record<DoctorStage, string[]>>> = {
  'claude-code': {
    detected: ['cc.binary'],
    configured: ['cc.mcp-json', 'cc.hook', 'cc.launcher'],
    handshake: ['cc.mcp'],
  },
  codex: {
    detected: ['codex'],
    configured: ['codex.policy', 'codex.sandbox'],
    handshake: ['codex.server'],
  },
};

/** The stages a doctor's checks decide: failed on any failing check, passed otherwise; skipped checks decide nothing. */
export function doctorEvidence(
  host: string,
  checks: readonly CheckResult[],
  version: string | null,
): ReadinessRecordRequest | null {
  const map = DOCTOR_STAGE_CHECKS[host];
  if (!map) return null;
  const stages: NonNullable<ReadinessRecordRequest['stages']> = [];
  for (const [stage, ids] of Object.entries(map) as [DoctorStage, string[]][]) {
    const found = checks.filter((c) => ids.includes(c.id));
    const failed = found.find(
      (c) => c.status === 'fail' || (stage === 'detected' && c.status === 'warn' && /not found/i.test(c.message)),
    );
    if (failed) {
      stages.push({ stage, status: 'failed', detail: failed.message.slice(0, 300) });
      continue;
    }
    const seen = found.filter((c) => c.status === 'ok' || c.status === 'warn');
    if (!seen.length) continue;
    stages.push({
      stage,
      status: 'passed',
      detail: seen
        .map((c) => c.message)
        .join('; ')
        .slice(0, 300),
    });
  }
  if (!stages.length) return null;
  return { host, version, source: 'harness doctor', stages };
}

/** Records a doctor's findings through the daemon; without a daemon they are shown, not recorded. */
export async function recordDoctorEvidence(
  g: () => GlobalOptions,
  host: string,
  checks: readonly CheckResult[],
  version: string | null,
): Promise<void> {
  const body = doctorEvidence(host, checks, version);
  if (!body || g().json) return;
  try {
    const { client } = operator(g());
    await client.post(client.projectPath('/readiness/evidence'), body);
    const summary = body.stages.map((s) => `${s.stage} ${s.status}`).join(', ');
    process.stdout.write(`\nRecorded for routing, for a day: ${summary}\n`);
  } catch (e) {
    if (e instanceof DaemonUnreachableError) {
      process.stdout.write('\nNot recorded for routing: the daemon is not running ("friday start").\n');
      return;
    }
    throw e;
  }
}

type Assessment = ReadinessReport['hosts'][number]['assessments'][number];
const stage = (a: Assessment, name: string) => a.stages.find((s) => s.stage === name);

function renderReport(r: ReadinessReport, onlyHost?: string): string {
  const hosts = r.hosts.filter((h) => !onlyHost || h.host === onlyHost);
  if (!hosts.length) return onlyHost ? `Nothing known about ${onlyHost}.` : 'No hosts known yet.';
  const rows: string[][] = [];
  for (const h of hosts) {
    for (const a of h.assessments) {
      const signedIn = stage(a, 'authenticated');
      const bench = stage(a, 'benched');
      rows.push([
        h.host,
        a.model ?? '(host)',
        a.dispatchable ? 'yes' : 'no',
        h.live ? `${h.sessions}` : '-',
        signedIn?.status === 'passed' ? 'yes' : signedIn?.status === 'failed' ? 'NO' : (signedIn?.status ?? '-'),
        bench?.status === 'failed' ? (a.bench_until ? `until ${shortTime(a.bench_until)}` : 'until cleared') : '-',
        a.roles.map((x) => `${x.role}#${x.rank}`).join(' ') || (h.ranked ? '' : 'not ranked'),
        a.dispatchable ? '' : a.reason,
      ]);
    }
  }
  return [
    table(['HOST', 'MODEL', 'READY', 'SESSIONS', 'SIGNED IN', 'BENCHED', 'RANKED FOR', 'WHY NOT'], rows, {
      maxWidth: 70,
    }),
    'Ready: installed, configured and connected (a live session, or a doctor check within a day), not seen failing to sign in, not benched. A sign-in never seen is tried.',
    `As of ${shortTime(r.checked_at)}. Evidence: friday readiness --evidence [--host <host>]`,
  ].join('\n');
}

function renderEvidence(evidence: ReadinessEvidenceView[]): string {
  if (!evidence.length) return 'No readiness evidence recorded.';
  return table(
    ['WHEN', 'HOST', 'MODEL', 'STAGE', 'STATUS', 'UNTIL', 'SOURCE', 'DETAIL'],
    evidence.map((e) => [
      shortTime(e.checked_at),
      e.host,
      e.model ?? '-',
      e.stage,
      e.ended_at ? `${e.status} (ended: ${e.ended_reason})` : e.status,
      e.expires_at ? shortTime(e.expires_at) : e.harness_id ? 'session ends' : '-',
      e.source,
      e.detail ?? '',
    ]),
    { maxWidth: 60 },
  );
}

export function registerReadinessCommands(program: Command, g: () => GlobalOptions): void {
  const readiness = program
    .command('readiness')
    .description('which hosts and models can take work now, and why not (what this machine has seen of each)')
    .option('--host <host>', 'one host: claude-code, codex, gemini, opencode, cursor, …')
    .option('--evidence', 'the observations behind the verdicts')
    .option('--all', 'with --evidence: also observations that ended')
    .action(async (o: { host?: string; evidence?: boolean; all?: boolean }) => {
      const { client } = operator(g());
      if (o.evidence) {
        const r = await client.get<{ evidence: ReadinessEvidenceView[] }>(client.projectPath('/readiness/evidence'), {
          query: { host: o.host, all: o.all ? 'true' : undefined },
        });
        out(g(), r, () => renderEvidence(r.evidence));
        return;
      }
      const r = await client.get<ReadinessReport>(client.projectPath('/readiness'));
      out(g(), r, () => renderReport(r, o.host));
    });

  readiness
    .command('clear <host>')
    .description('lift a bench or a failed sign-in for a host (or one of its models): the next route tries it again')
    .option('--model <model>', 'only this model of the host')
    .action(async (host: string, o: { model?: string }) => {
      const { client } = operator(g());
      const r = await client.post<{ ended: ReadinessEvidenceView[] }>(client.projectPath('/readiness/clear'), {
        host,
        model: o.model ?? null,
      });
      out(g(), r, () =>
        r.ended.length
          ? `Cleared ${r.ended.length} record(s) for ${host}${o.model ? `/${o.model}` : ''}:\n${renderEvidence(r.ended)}`
          : `Nothing kept ${host}${o.model ? `/${o.model}` : ''} out.`,
      );
    });
}
