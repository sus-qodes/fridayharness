import { formatIssues, type ParseResult } from './model.js';
import { PlanDraft, ReplanDraft } from './schemas.js';
import { type ExistingTask, validatePlanDraft, validateReplanDraft } from './validate.js';

/** Schema plus semantic checks for a first plan. */
export function parsePlanDraft(output: unknown): ParseResult<PlanDraft> {
  const r = PlanDraft.safeParse(output);
  if (!r.success) return { ok: false, errors: formatIssues(r.error) };
  const v = validatePlanDraft(r.data);
  return v.ok ? { ok: true, value: r.data } : { ok: false, errors: v.errors };
}

/** Schema plus semantic checks for a revision of the active plan. */
export function parseReplanDraft(existing: ExistingTask[]): (output: unknown) => ParseResult<ReplanDraft> {
  return (output) => {
    const r = ReplanDraft.safeParse(output);
    if (!r.success) return { ok: false, errors: formatIssues(r.error) };
    const v = validateReplanDraft(r.data, existing);
    return v.ok ? { ok: true, value: r.data } : { ok: false, errors: v.errors };
  };
}
