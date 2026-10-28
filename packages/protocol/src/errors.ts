/**
 * Error codes (spec Part 14 §3) plus Friday additions within the same families.
 * `code` is what clients see; `http` is the status the daemon answers with.
 */
export const ERROR_CODES = {
  invalid_request: { code: 'COS-1000', http: 400, retryable: false },
  schema_mismatch: { code: 'COS-1001', http: 400, retryable: false },
  unsupported_protocol_version: { code: 'COS-1002', http: 400, retryable: false },
  idempotency_key_conflict: { code: 'COS-1003', http: 409, retryable: false },
  payload_too_large: { code: 'COS-1004', http: 413, retryable: false },

  project_not_found: { code: 'COS-2000', http: 404, retryable: false },
  task_not_found: { code: 'COS-2001', http: 404, retryable: false },
  invalid_state_transition: { code: 'COS-2002', http: 409, retryable: false },
  agent_not_found: { code: 'COS-2003', http: 404, retryable: false },
  harness_not_found: { code: 'COS-2004', http: 404, retryable: false },
  agent_unavailable: { code: 'COS-2005', http: 409, retryable: true },
  goal_not_found: { code: 'COS-2006', http: 404, retryable: false },
  plan_not_found: { code: 'COS-2007', http: 404, retryable: false },

  permission_denied: { code: 'COS-3000', http: 403, retryable: false },
  capability_not_granted: { code: 'COS-3001', http: 403, retryable: false },
  approval_required: { code: 'COS-3002', http: 403, retryable: false },
  approval_expired: { code: 'COS-3003', http: 403, retryable: false },
  authentication_failed: { code: 'COS-3004', http: 401, retryable: false },
  token_revoked: { code: 'COS-3005', http: 401, retryable: false },
  token_scope_insufficient: { code: 'COS-3006', http: 403, retryable: false },

  harness_unavailable: { code: 'COS-4000', http: 503, retryable: true },
  harness_disconnected: { code: 'COS-4001', http: 409, retryable: true },
  capability_unsupported: { code: 'COS-4002', http: 501, retryable: false },
  run_not_found: { code: 'COS-4003', http: 404, retryable: false },
  lease_expired: { code: 'COS-4004', http: 409, retryable: true },
  message_not_found: { code: 'COS-4005', http: 404, retryable: false },
  harness_shadowed: { code: 'COS-4006', http: 409, retryable: true },

  context_unavailable: { code: 'COS-5000', http: 503, retryable: true },
  context_stale: { code: 'COS-5001', http: 409, retryable: true },
  context_budget_exceeded: { code: 'COS-5002', http: 413, retryable: false },

  verification_failed: { code: 'COS-6000', http: 422, retryable: false },
  verification_unavailable: { code: 'COS-6001', http: 503, retryable: true },

  routing_unavailable: { code: 'COS-7000', http: 503, retryable: true },
  model_unavailable: { code: 'COS-7001', http: 503, retryable: true },
  routing_confidence_low: { code: 'COS-7002', http: 409, retryable: false },

  git_conflict: { code: 'COS-8000', http: 409, retryable: false },
  worktree_dirty: { code: 'COS-8001', http: 409, retryable: false },
  reservation_conflict: { code: 'COS-8002', http: 409, retryable: false },

  internal_error: { code: 'COS-9000', http: 500, retryable: true },
  daemon_shutting_down: { code: 'COS-9001', http: 503, retryable: true },
} as const satisfies Record<string, { code: `COS-${number}`; http: number; retryable: boolean }>;

export type ErrorName = keyof typeof ERROR_CODES;
export type ErrorCode = (typeof ERROR_CODES)[ErrorName]['code'];

export interface ErrorBody {
  error: { code: ErrorCode; name: ErrorName; message: string; retryable: boolean; details?: unknown };
}

const BY_CODE = new Map<string, ErrorName>(
  Object.entries(ERROR_CODES).map(([name, def]) => [def.code, name as ErrorName]),
);

export class FridayError extends Error {
  readonly errorName: ErrorName;
  readonly code: ErrorCode;
  readonly http: number;
  readonly retryable: boolean;
  readonly details: unknown;

  constructor(name: ErrorName, message?: string, details?: unknown) {
    const def = ERROR_CODES[name];
    super(message ?? name.replaceAll('_', ' '));
    this.name = 'FridayError';
    this.errorName = name;
    this.code = def.code;
    this.http = def.http;
    this.retryable = def.retryable;
    this.details = details;
  }

  toBody(): ErrorBody {
    const body: ErrorBody = {
      error: { code: this.code, name: this.errorName, message: this.message, retryable: this.retryable },
    };
    if (this.details !== undefined) body.error.details = this.details;
    return body;
  }

  /** Rebuilds an error from a daemon response body; unknown codes become internal_error. */
  static fromBody(body: unknown): FridayError {
    const e = (body as Partial<ErrorBody> | undefined)?.error;
    const name = (e?.code && BY_CODE.get(e.code)) || 'internal_error';
    return new FridayError(name, e?.message ?? 'unknown error', e?.details);
  }
}

export function isFridayError(value: unknown, name?: ErrorName): value is FridayError {
  return value instanceof FridayError && (name === undefined || value.errorName === name);
}

export function errorNameForCode(code: string): ErrorName | undefined {
  return BY_CODE.get(code);
}
