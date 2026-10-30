/**
 * How a spawn adapter's host ends a run attempt (ADR-0032 §9): a final message the adapter turns
 * into a completion claim, a blocked result or, when the host could not finish, an error. It asks
 * only for what Friday cannot read elsewhere (plan M13.4): the changed paths come from the
 * worktree, never from the model.
 */
const CHECK_PROPERTIES = {
  name: { type: 'string' },
  command: { type: 'string' },
  outcome: { type: 'string', enum: ['passed', 'failed', 'skipped'] },
} as const;

const FINAL_PROPERTIES = {
  status: { type: 'string', enum: ['completed', 'blocked'] },
  summary: { type: 'string' },
  blocked_reason: { type: 'string' },
  // What the session ran to check its work (a test, a build, the program on an input), each with
  // its outcome: verification's evidence that the work was run, bounded by what the hooks saw.
  checks: {
    type: 'array',
    items: { type: 'object', properties: CHECK_PROPERTIES, required: ['name', 'outcome'] },
  },
} as const;

const STRICT_FINAL_PROPERTIES = {
  ...FINAL_PROPERTIES,
  checks: {
    type: 'array',
    items: {
      type: 'object',
      properties: CHECK_PROPERTIES,
      required: ['name', 'command', 'outcome'],
      additionalProperties: false,
    },
  },
} as const;

/** The most checks a final answer carries; the rest are dropped. */
const MAX_CHECKS = 50;

/**
 * The schema a host enforces by refusing an answer that does not fit (Claude Code's `--json-schema`):
 * only `status` is required and extra fields are accepted, so no missing or added field makes the
 * host refuse an answer and the model try again (LESSONS CC-35).
 */
export const FINAL_SCHEMA = {
  type: 'object',
  properties: FINAL_PROPERTIES,
  required: ['status'],
} as const;

/**
 * The schema for a host whose structured output is strict (Codex's `outputSchema`): every field
 * required and nothing else, as strict output demands. The host cannot produce an answer that does
 * not fit, so nothing is ever refused.
 */
export const STRICT_FINAL_SCHEMA = {
  type: 'object',
  properties: STRICT_FINAL_PROPERTIES,
  required: ['status', 'summary', 'blocked_reason', 'checks'],
  additionalProperties: false,
} as const;

/** A check the session says it ran, as it reaches the claim (`CheckReport` without `kind`). */
export interface FinalCheck {
  name: string;
  command?: string;
  outcome: 'passed' | 'failed' | 'skipped';
}

export interface Final {
  status: 'completed' | 'blocked';
  summary: string;
  blocked_reason: string;
  checks: FinalCheck[];
}

/** The checks of a parsed answer: well-formed entries only, bounded in number and length. */
function parseChecks(v: unknown): FinalCheck[] {
  if (!Array.isArray(v)) return [];
  const out: FinalCheck[] = [];
  for (const c of v) {
    if (out.length >= MAX_CHECKS) break;
    const x = (c ?? {}) as Partial<FinalCheck>;
    const name = typeof x.name === 'string' ? x.name.trim().slice(0, 200) : '';
    if (!name || (x.outcome !== 'passed' && x.outcome !== 'failed' && x.outcome !== 'skipped')) continue;
    const command = typeof x.command === 'string' ? x.command.trim().slice(0, 1000) : '';
    out.push({ name, outcome: x.outcome, ...(command ? { command } : {}) });
  }
  return out;
}

/**
 * A summary as the model meant it: when a model writes the next parameter of its answer inside
 * the summary's text (`…</summary> <parameter name="…">…`), the text is cut there (CC-35).
 */
export function cleanSummary(s: string): string {
  const cut = s.search(/<\/summary>|<parameter name=/);
  return (cut >= 0 ? s.slice(0, cut) : s).trim();
}

/**
 * The final message, from its text or its parsed value; prose counts as a summary. `fallback` is
 * the session's last text, the summary when the answer gives none.
 */
export function parseFinal(message: unknown, fallback = ''): Final {
  let v: unknown = message;
  if (typeof message === 'string') {
    try {
      v = JSON.parse(message);
    } catch {
      // not JSON: the model answered in prose
      return { status: 'completed', summary: cleanSummary(message) || fallback.trim(), blocked_reason: '', checks: [] };
    }
  }
  const o = (v ?? {}) as Partial<Final>;
  if (o.status === 'completed' || o.status === 'blocked') {
    return {
      status: o.status,
      summary: (typeof o.summary === 'string' ? cleanSummary(o.summary) : '') || fallback.trim(),
      blocked_reason: typeof o.blocked_reason === 'string' ? o.blocked_reason.trim() : '',
      checks: parseChecks(o.checks),
    };
  }
  return {
    status: 'completed',
    summary: (typeof message === 'string' ? cleanSummary(message) : '') || fallback.trim(),
    blocked_reason: '',
    checks: [],
  };
}
