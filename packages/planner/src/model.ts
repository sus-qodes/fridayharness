import type { z } from 'zod';
import { costOf, type PriceTable, worstCaseCost } from './pricing.js';
import { ModelError, type ModelRequest, type ModelUsage, type PlannerModel, ZERO_USAGE } from './providers/types.js';

/** One model request as Friday records it (`model.called`, plan B28). Never the prompt or the answer. */
export interface PlannerCall {
  purpose: 'plan' | 'replan' | 'role';
  prompt_version: string;
  provider: string;
  model: string;
  remote: boolean;
  status: 'ok' | 'invalid' | 'error' | 'refused' | 'interrupted';
  error_code: string | null;
  error: string | null;
  attempt: number;
  usage: ModelUsage;
  /** Null when unknown: no price for the model, or a request whose outcome is uncertain (review F04). */
  cost_usd: number | null;
  /** The worst-case estimate the budget counts while `cost_usd` is null. */
  cost_estimate_usd: number | null;
  latency_ms: number;
  request_id: string | null;
}

export interface PlannerPolicy {
  /**
   * The project allows remote calls (`providers.<name>.allow_remote`) and the user approved this
   * clone on this machine (review F03). A remote provider is never called without both.
   */
  allowRemote: boolean;
  /** Why remote calls are off, shown to the human. */
  remoteRefusal?: string;
  spentTodayUsd: number;
  dailyBudgetUsd: number;
  prices?: PriceTable;
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: string[] };

export type PlannerOutcome<T> =
  | { ok: true; draft: T; calls: PlannerCall[] }
  | {
      ok: false;
      reason: 'refused' | 'budget' | 'provider' | 'invalid';
      message: string;
      errors: string[];
      calls: PlannerCall[];
    };

/** Zod issues as short lines a model (or a human) can act on. */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.slice(0, 20).map((i) => `${i.path.length ? i.path.join('.') : '(root)'}: ${i.message}`);
}

/** Every character of a request that is sent, for the worst-case estimate. */
function requestChars(r: ModelRequest): number {
  return (
    r.system.length +
    r.context.length +
    r.instructions.length +
    r.prompt.length +
    (r.repair ? r.repair.previous.length + r.repair.errors.join('\n').length + 200 : 0) +
    // The structured-output schema and the context wrapper are sent too.
    JSON.stringify(r.schema).length +
    600
  );
}

/** What a recorded call counts against the budget: its cost, or its estimate while that is unknown. */
export function budgetedCost(c: Pick<PlannerCall, 'cost_usd' | 'cost_estimate_usd'>): number {
  return c.cost_usd ?? c.cost_estimate_usd ?? 0;
}

/**
 * Runs one planning request (plan M2 design, review F04): consent first, then for each attempt
 * a budget check that adds the attempt's worst-case cost to what was already spent today, the
 * call, and validation, with a single repair attempt. Nothing is sent when a check fails.
 *
 * The daily budget is a cap on estimates: a call starts only if recorded spend plus its
 * worst-case cost fits. Calls whose cost is unknown count at their estimate. Provider errors are
 * not retried here; the SDK already retries transient failures, and the Master Brain escalates.
 */
export async function runPlanner<T>(
  model: PlannerModel,
  request: ModelRequest,
  parse: (output: unknown) => ParseResult<T>,
  policy: PlannerPolicy,
  opts: {
    promptVersion: string;
    now?: () => number;
    signal?: AbortSignal;
    /** Called right before each request is sent (the Master Brain marks its job as in flight). */
    onCall?: (request: ModelRequest) => void;
    /** The outbound boundary (review F03): every request passes it right before it is sent. */
    outbound?: (request: ModelRequest) => ModelRequest;
  },
): Promise<PlannerOutcome<T>> {
  const now = opts.now ?? Date.now;
  const calls: PlannerCall[] = [];
  const base = {
    purpose: request.purpose,
    prompt_version: opts.promptVersion,
    provider: model.provider,
    model: request.model,
    remote: model.remote,
  };
  const refusal = (attempt: number, reason: 'refused' | 'budget', message: string): PlannerCall => ({
    ...base,
    status: 'refused',
    error_code: reason,
    error: message,
    attempt,
    usage: ZERO_USAGE,
    cost_usd: 0,
    cost_estimate_usd: null,
    latency_ms: 0,
    request_id: null,
  });
  if (model.remote && !policy.allowRemote) {
    const message =
      policy.remoteRefusal ??
      `remote calls to ${model.provider} are off; set providers.${model.provider}.allow_remote: true in .friday/config.yaml and run "friday brain allow-remote"`;
    calls.push(refusal(0, 'refused', message));
    return { ok: false, reason: 'refused', message, errors: [], calls };
  }

  let current: ModelRequest = request;
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let estimate: number | null = null;
    if (model.remote) {
      estimate = worstCaseCost(current.model, requestChars(current), current.maxTokens, policy.prices);
      if (estimate === null) {
        const message = `no price is known for model ${current.model}, so the daily budget cannot be kept; add it under providers.${model.provider}.prices in .friday/config.yaml`;
        calls.push(refusal(attempt, 'budget', message));
        return { ok: false, reason: 'budget', message, errors: lastErrors, calls };
      }
      const spent = policy.spentTodayUsd + calls.reduce((sum, c) => sum + budgetedCost(c), 0);
      if (spent + estimate > policy.dailyBudgetUsd) {
        const message =
          attempt === 1
            ? `today's model budget of $${policy.dailyBudgetUsd.toFixed(2)} does not cover this call ($${spent.toFixed(2)} spent, up to $${estimate.toFixed(2)} needed)`
            : `the first answer was invalid, and a second attempt (up to $${estimate.toFixed(2)}) would exceed today's budget of $${policy.dailyBudgetUsd.toFixed(2)}`;
        calls.push(refusal(attempt, 'budget', message));
        return { ok: false, reason: 'budget', message, errors: lastErrors, calls };
      }
    }
    const sent = opts.outbound ? opts.outbound(current) : current;
    opts.onCall?.(sent);
    const started = now();
    // A model on this machine is paid for by nobody, whatever its id (plan M12.1): its cost is 0,
    // never unknown. A remote model without a price stays unknown (review F04).
    const unpriced = model.remote ? null : 0;
    try {
      const res = await model.complete(sent, opts.signal);
      const parsed = parse(res.output);
      // Price by the model that answered; a snapshot id Friday does not know falls back to the requested one.
      const cost =
        costOf(res.model, res.usage, policy.prices) ?? costOf(current.model, res.usage, policy.prices) ?? unpriced;
      calls.push({
        ...base,
        model: res.model,
        status: parsed.ok ? 'ok' : 'invalid',
        error_code: parsed.ok ? null : 'invalid_output',
        error: parsed.ok ? null : parsed.errors.slice(0, 3).join('; '),
        attempt,
        usage: res.usage,
        cost_usd: cost,
        cost_estimate_usd: cost === null ? estimate : null,
        latency_ms: now() - started,
        request_id: res.request_id,
      });
      if (parsed.ok) return { ok: true, draft: parsed.value, calls };
      lastErrors = parsed.errors;
      current = {
        ...request,
        repair: { previous: JSON.stringify(res.output ?? null).slice(0, 20_000), errors: parsed.errors },
      };
    } catch (e) {
      const err =
        e instanceof ModelError
          ? e
          : new ModelError('unavailable', (e as Error).message, false, undefined, { billed: 'unknown' });
      const usage = err.usage ?? ZERO_USAGE;
      // Billed answers keep their usage; rejected requests cost nothing; uncertain ones are unknown
      // (a local model's uncertain outcome still cost nothing).
      const cost =
        err.billed === 'no'
          ? 0
          : err.billed === 'yes'
            ? (costOf(err.model ?? current.model, usage, policy.prices) ??
              costOf(current.model, usage, policy.prices) ??
              unpriced)
            : unpriced;
      calls.push({
        ...base,
        ...(err.model ? { model: err.model } : {}),
        status: 'error',
        error_code: err.code,
        error: err.message.slice(0, 500),
        attempt,
        usage,
        cost_usd: cost,
        cost_estimate_usd: cost === null ? estimate : null,
        latency_ms: now() - started,
        request_id: err.requestId ?? null,
      });
      return {
        ok: false,
        reason: 'provider',
        message: `${model.provider} ${err.code}: ${err.message}`,
        errors: [],
        calls,
      };
    }
  }
  return {
    ok: false,
    reason: 'invalid',
    message: 'the planner returned an invalid plan twice',
    errors: lastErrors,
    calls,
  };
}

/** The worst-case cost of a request before it is sent (the Master Brain records it while the call is in flight). */
export function requestEstimate(model: PlannerModel, request: ModelRequest, prices?: PriceTable): number | null {
  return model.remote ? worstCaseCost(request.model, requestChars(request), request.maxTokens, prices) : null;
}
