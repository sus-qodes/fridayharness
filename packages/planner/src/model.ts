import type { z } from 'zod';
import { costOf, type PriceTable } from './pricing.js';
import { ModelError, type ModelRequest, type ModelUsage, type PlannerModel, ZERO_USAGE } from './providers/types.js';

/** One model request as Friday records it (`model.called`, plan B28). Never the prompt or the answer. */
export interface PlannerCall {
  purpose: 'plan' | 'replan';
  prompt_version: string;
  provider: string;
  model: string;
  remote: boolean;
  status: 'ok' | 'invalid' | 'error' | 'refused';
  error_code: string | null;
  error: string | null;
  attempt: number;
  usage: ModelUsage;
  cost_usd: number;
  latency_ms: number;
  request_id: string | null;
}

export interface PlannerPolicy {
  /** `providers.<name>.allow_remote`: a remote provider is never called without it. */
  allowRemote: boolean;
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

/**
 * Runs one planning request: consent and budget first (no network otherwise), then the call,
 * then validation with a single repair attempt (plan M2 design). Provider errors are not retried
 * here; the SDK already retries transient failures, and the Master Brain escalates the rest.
 */
export async function runPlanner<T>(
  model: PlannerModel,
  request: ModelRequest,
  parse: (output: unknown) => ParseResult<T>,
  policy: PlannerPolicy,
  opts: { promptVersion: string; now?: () => number; signal?: AbortSignal },
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
  const refused = (reason: 'refused' | 'budget', message: string): PlannerOutcome<T> => {
    calls.push({
      ...base,
      status: 'refused',
      error_code: reason,
      error: message,
      attempt: 0,
      usage: ZERO_USAGE,
      cost_usd: 0,
      latency_ms: 0,
      request_id: null,
    });
    return { ok: false, reason, message, errors: [], calls };
  };
  if (model.remote && !policy.allowRemote) {
    return refused(
      'refused',
      `remote calls to ${model.provider} are off; set providers.${model.provider}.allow_remote: true in .friday/config.yaml to allow them`,
    );
  }
  if (policy.spentTodayUsd >= policy.dailyBudgetUsd) {
    return refused(
      'budget',
      `today's model budget of $${policy.dailyBudgetUsd.toFixed(2)} is used up ($${policy.spentTodayUsd.toFixed(2)} spent)`,
    );
  }

  let current: ModelRequest = request;
  let lastErrors: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const started = now();
    try {
      const res = await model.complete(current, opts.signal);
      const parsed = parse(res.output);
      calls.push({
        ...base,
        model: res.model,
        status: parsed.ok ? 'ok' : 'invalid',
        error_code: parsed.ok ? null : 'invalid_output',
        error: parsed.ok ? null : parsed.errors.slice(0, 3).join('; '),
        attempt,
        usage: res.usage,
        cost_usd: costOf(res.model, res.usage, policy.prices),
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
      const err = e instanceof ModelError ? e : new ModelError('unavailable', (e as Error).message);
      calls.push({
        ...base,
        status: 'error',
        error_code: err.code,
        error: err.message.slice(0, 500),
        attempt,
        usage: ZERO_USAGE,
        cost_usd: 0,
        latency_ms: now() - started,
        request_id: null,
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
