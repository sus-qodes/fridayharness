/**
 * How a spawn adapter's host ends a run attempt (ADR-0032 §9): a final message in this schema,
 * which the host enforces (Codex's `outputSchema`, Claude Code's `--json-schema`). The adapter
 * turns it into a completion claim, a blocked result or, when the host could not finish, an error.
 */
export const FINAL_SCHEMA = {
  type: 'object',
  properties: {
    status: { type: 'string', enum: ['completed', 'blocked'] },
    summary: { type: 'string' },
    changed_paths: { type: 'array', items: { type: 'string' } },
    blocked_reason: { type: 'string' },
  },
  required: ['status', 'summary', 'changed_paths', 'blocked_reason'],
  additionalProperties: false,
} as const;

export interface Final {
  status: 'completed' | 'blocked';
  summary: string;
  changed_paths: string[];
  blocked_reason: string;
}

/** The final message, as the schema asks, from its text or its parsed value; prose counts as a summary. */
export function parseFinal(message: unknown): Final {
  let v: unknown = message;
  if (typeof message === 'string') {
    try {
      v = JSON.parse(message);
    } catch {
      // not JSON: the model answered in prose
      return { status: 'completed', summary: message.trim(), changed_paths: [], blocked_reason: '' };
    }
  }
  const o = (v ?? {}) as Partial<Final>;
  if (o.status === 'completed' || o.status === 'blocked') {
    return {
      status: o.status,
      summary: typeof o.summary === 'string' ? o.summary : '',
      changed_paths: Array.isArray(o.changed_paths) ? o.changed_paths.filter((x) => typeof x === 'string') : [],
      blocked_reason: typeof o.blocked_reason === 'string' ? o.blocked_reason : '',
    };
  }
  return {
    status: 'completed',
    summary: typeof message === 'string' ? message.trim() : '',
    changed_paths: [],
    blocked_reason: '',
  };
}
