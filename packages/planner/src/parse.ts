import { formatIssues, type ParseResult } from './model.js';
import { PlanDraft, ReplanDraft } from './schemas.js';
import { type ExistingTask, type PlanTaskBounder, validatePlanDraft, validateReplanDraft } from './validate.js';

/**
 * Schema plus semantic checks for a first plan. With a bounder (`FridayState.boundPlanTask`), a
 * task beyond the ceiling of its role (plan M12.2) is an error the model repairs in its one repair
 * attempt, instead of a refusal from the state after the call.
 */
export function parsePlanDraft(output: unknown, bound?: PlanTaskBounder): ParseResult<PlanDraft> {
  const r = PlanDraft.safeParse(output);
  if (!r.success) return { ok: false, errors: formatIssues(r.error) };
  const v = validatePlanDraft(r.data, bound);
  return v.ok ? { ok: true, value: r.data } : { ok: false, errors: v.errors };
}

/** Schema plus semantic checks for a revision of the active plan; the bounder as above. */
export function parseReplanDraft(
  existing: ExistingTask[],
  bound?: PlanTaskBounder,
): (output: unknown) => ParseResult<ReplanDraft> {
  return (output) => {
    const r = ReplanDraft.safeParse(output);
    if (!r.success) return { ok: false, errors: formatIssues(r.error) };
    const v = validateReplanDraft(r.data, existing, bound);
    return v.ok ? { ok: true, value: r.data } : { ok: false, errors: v.errors };
  };
}
