/**
 * How a spawn adapter's host ends a run attempt (ADR-0032 §9): a final message the adapter turns
 * into a completion claim, a blocked result or, when the host could not finish, an error. It asks
 * only for what Friday cannot read elsewhere (plan M13.4): the changed paths come from the
 * worktree, never from the model.
 */
const FINAL_PROPERTIES = {
  status: { type: 'string', enum: ['completed', 'blocked'] },
  summary: { type: 'string' },
  blocked_reason: { type: 'string' },
} as const;

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
  properties: FINAL_PROPERTIES,
  required: ['status', 'summary', 'blocked_reason'],
  additionalProperties: false,
} as const;

export interface Final {
  status: 'completed' | 'blocked';
  summary: string;
  blocked_reason: string;
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
      return { status: 'completed', summary: cleanSummary(message) || fallback.trim(), blocked_reason: '' };
    }
  }
  const o = (v ?? {}) as Partial<Final>;
  if (o.status === 'completed' || o.status === 'blocked') {
    return {
      status: o.status,
      summary: (typeof o.summary === 'string' ? cleanSummary(o.summary) : '') || fallback.trim(),
      blocked_reason: typeof o.blocked_reason === 'string' ? o.blocked_reason.trim() : '',
    };
  }
  return {
    status: 'completed',
    summary: (typeof message === 'string' ? cleanSummary(message) : '') || fallback.trim(),
    blocked_reason: '',
  };
}
