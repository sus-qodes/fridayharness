/** ASCII-only output helpers (plan E.3: PowerShell code pages garble box drawing). */

export function table(
  headers: string[],
  rows: (string | number | null | undefined)[][],
  opts: { maxWidth?: number } = {},
): string {
  const max = opts.maxWidth ?? 60;
  const cells = rows.map((r) => r.map((c) => clip(String(c ?? ''), max)));
  const widths = headers.map((h, i) => Math.max(h.length, ...cells.map((r) => (r[i] ?? '').length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => v.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...cells.map(line)].join('\n');
}

export function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, ' ');
  return one.length > max ? `${one.slice(0, max - 3)}...` : one;
}

export function shortTime(iso: string | null | undefined): string {
  if (!iso) return '';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

export function kv(pairs: [string, unknown][]): string {
  const w = Math.max(...pairs.map(([k]) => k.length));
  return pairs.map(([k, v]) => `${k.padEnd(w)}  ${v ?? ''}`).join('\n');
}

/** One-line description of an event for `friday events tail` and `task inspect`. */
export function describeEvent(e: { type: string; payload: Record<string, unknown> }): string {
  const p = e.payload;
  const tr = p.transition as { from?: string; to?: string; reason?: string } | undefined;
  if (tr?.from && tr.to) return `${tr.from} -> ${tr.to}${tr.reason ? ` (${tr.reason})` : ''}`;
  switch (e.type) {
    case 'task.created':
      return String((p.task as { summary?: string } | undefined)?.summary ?? '');
    case 'policy.evaluated':
      return `${p.decision ?? ''} ${p.tool ?? ''} ${p.target ?? ''} ${p.reason ? `- ${p.reason}` : ''}`.trim();
    case 'agent.event':
      return `${p.event_type ?? ''} ${p.note ?? p.summary ?? ''}`.trim();
    case 'run.paths_observed':
      return ((p.paths as string[]) ?? []).join(', ');
    case 'run.workspace_ready': {
      const s = p.setup as {
        status?: string;
        command?: string | null;
        args?: string[];
        reason?: string;
        cache?: { from?: string } | null;
      } | null;
      if (!s) return `worktree ready at ${p.execution_root ?? ''}`;
      const cmd = s.command ? ` (${[s.command, ...(s.args ?? [])].join(' ')})` : '';
      const from = s.cache?.from === 'cache' ? ' from the cache' : '';
      return `worktree ready; dependencies ${s.status}${from}${cmd}${s.reason && s.reason !== 'ok' ? `: ${s.reason}` : ''}`;
    }
    case 'command.rejected':
      return `${p.command} ${(p.error as { code?: string })?.code ?? ''} ${(p.error as { message?: string })?.message ?? ''}`;
    case 'verification.finished':
      return `${p.status} ${p.summary ?? ''}`;
    case 'verification.check_completed': {
      const c = p.check as { name?: string; status?: string; summary?: string };
      return `${c?.name} ${c?.status} ${c?.summary ?? ''}`;
    }
    case 'approval.requested': {
      const a = p.approval as { approval_id?: string; capability?: string; target?: string };
      return `${a?.approval_id} ${a?.capability} ${a?.target ?? ''}`;
    }
    default:
      return '';
  }
}

/** A verification as lines (ADR-0024): what was verified, each check, and what Friday's checks found. */
export function verificationLines(v: {
  status: string;
  summary: string | null;
  execution_root: string | null;
  commit_sha: string | null;
  source_version: string | null;
  checks: {
    name: string;
    status: string;
    exit_code: number | null;
    summary: string | null;
    required: boolean;
    details: { findings?: { severity: string; rule: string; message: string }[] } | null;
  }[];
}): string[] {
  const lines: string[] = [];
  if (v.execution_root) {
    const plus = v.source_version?.indexOf('+') ?? -1;
    const head = v.commit_sha ? v.commit_sha.slice(0, 12) : '(no commits)';
    const dirty =
      plus >= 0 && v.source_version ? ` with uncommitted changes (${v.source_version.slice(plus + 1)})` : '';
    lines.push(`  code: ${head}${dirty} in ${v.execution_root}`);
  }
  for (const c of v.checks) {
    const flags = [c.exit_code !== null ? `exit ${c.exit_code}` : '', c.required ? '' : 'advisory'].filter(Boolean);
    lines.push(`  ${c.name}: ${c.status}${flags.length ? ` (${flags.join(', ')})` : ''} ${c.summary ?? ''}`.trimEnd());
    for (const f of c.details?.findings ?? []) lines.push(`    ${f.severity} ${f.rule}: ${f.message}`);
  }
  if (v.status === 'CANCELLED' && v.summary) lines.push(`  ${v.summary}`);
  return lines;
}
