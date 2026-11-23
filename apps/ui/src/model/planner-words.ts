/**
 * Why the planner could not plan, in a person's words (2026-11-17), from the kind of the question
 * and what the planner's provider said. The card showed the question as the daemon wrote it
 * ("Friday cannot plan goal goal_01… (…): <the provider's message>. How should it continue?") with
 * the same two buttons whatever had happened; a person who only had to sign in again, or to wait
 * for a usage limit, was offered "Write a revision".
 */
import { cleanText, truncate } from '../ui/format.js';
import { modelName } from './models.js';

/** The kinds of question that mean planning itself failed (packages/planner `EscalationReason`). */
export const PLANNER_FAILURES: readonly string[] = [
  'planner_unavailable',
  'invalid_plan',
  'budget_exceeded',
  'action_failed',
];

export type PlannerTrouble = 'sign_in' | 'limit' | 'not_set_up' | 'budget' | 'unreadable' | 'other';

const SIGN_IN =
  /not (signed|logged) in|sign[- ]?in|log ?in|oauth|authenticat|unauthori[sz]ed|\b401\b|invalid (api )?key|rejected the key|expired/i;
const LIMIT = /usage limit|rate limit|limit reached|hit your limit|too many requests|\b429\b|overloaded|resets?\b/i;
const NOT_SET_UP =
  /no planner|not configured|no (api )?key|no [\w ]{0,30}key is stored|key is (missing|not stored)|not approved|not allowed|allow_remote|was not found|not installed|no model/i;

/** What went wrong, from the question's kind and the provider's own words. */
export function plannerTrouble(kind: string | null, why: string | null | undefined): PlannerTrouble {
  const said = why ?? '';
  if (kind === 'budget_exceeded') return 'budget';
  if (kind === 'invalid_plan') return 'unreadable';
  // A limit names "resets"; a sign-in problem may say "expired": the limit is asked first.
  if (LIMIT.test(said)) return 'limit';
  if (SIGN_IN.test(said)) return 'sign_in';
  if (NOT_SET_UP.test(said)) return 'not_set_up';
  return 'other';
}

/** The sentence under "Friday could not plan this goal". */
export function plannerTroubleWords(trouble: PlannerTrouble, why: string | null | undefined): string {
  switch (trouble) {
    case 'sign_in':
      return 'The planner is not signed in, or its key was refused. Sign in to it (for Claude Code or Codex: open it once and sign in; for a key: store it again in Settings → Planner), then try again.';
    case 'limit':
      return 'The planner reached a usage limit. It can be asked again once the limit resets.';
    case 'not_set_up':
      return 'No planner is ready on this computer. Set one up in Settings → Planner, or write the plan yourself.';
    case 'budget':
      // A planner without a known price is held to requests a day: said as that, not as spending.
      return /requests to the planner/.test(why ?? '')
        ? 'Today’s limit of requests to the planner is reached. Raise it in Settings → Planner, wait until tomorrow, or write the plan yourself.'
        : 'Today’s spending limit for planning is used up. Raise it in Settings → Planner, wait until tomorrow, or write the plan yourself.';
    case 'unreadable':
      return 'The planner answered, but not with a plan Friday could use. Ask again, with a note on what you want if that helps, or write the plan yourself.';
    default: {
      const said = truncate(cleanText(why ?? '').trim(), 300);
      return said ? `The planner could not finish: ${said}` : 'The planner could not finish.';
    }
  }
}

/** Whether "Planner settings" is where this trouble is fixed. */
export function fixedInSettings(trouble: PlannerTrouble): boolean {
  return trouble === 'not_set_up' || trouble === 'budget' || trouble === 'sign_in';
}

/**
 * Who writes the plans, in a person's words (2026-11-17): the model by its name and how it is
 * reached. Settings showed the planner as the daemon names it ("anthropic · claude-opus-5-5
 * (remote)").
 */
export function plannerWords(brain: { provider: string; model: string }): string {
  const model = modelName(truncate(cleanText(brain.model), 80));
  switch (brain.provider) {
    case 'anthropic':
      return `${model}, with your Anthropic API key`;
    case 'claude-code':
      return `${model}, through your Claude Code sign-in`;
    case 'codex':
      // No model named: the one the person's account uses by default, which Codex does not say.
      return brain.model === 'auto' ? 'Codex, through your Codex sign-in' : `${model}, through your Codex sign-in`;
    case 'openai':
      return `${model}, with your OpenAI API key`;
    case 'gemini':
      return `${model}, with your Google Gemini API key`;
    case 'deepseek':
      return `${model}, with your DeepSeek API key`;
    case 'openrouter':
      return `${model}, with your OpenRouter key`;
    case 'local':
      return `${model}, a model on this computer`;
    case 'none':
      return 'You: no planner is chosen';
    case 'fake':
      return 'A test planner (no model)';
    default:
      return `${truncate(cleanText(brain.provider), 40)} · ${model}`;
  }
}

/** Where the planner's key stands, in words; the key itself is never shown. */
export function keyWords(key: string): string {
  switch (key) {
    case 'stored':
      return 'Stored on this computer';
    case 'environment':
      return 'Taken from this computer’s environment';
    case 'missing':
      return 'Not stored yet';
    case 'not needed':
      return 'Not needed';
    default:
      return truncate(cleanText(key), 40);
  }
}
