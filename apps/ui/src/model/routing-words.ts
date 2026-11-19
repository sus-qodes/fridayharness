/**
 * Why a task has no agent to run it, in a person's words (2026-11-17), from the codes routing gives
 * with a block. The card showed the decision's own sentence ("no dispatchable candidate for role
 * "frontend_engineer" on this harness"), which names nothing a person can act on; that sentence
 * stays behind "Details".
 */

const TASK_KIND_WORDS: Record<string, string> = {
  implementation: 'coding',
  verification: 'testing',
  review: 'review',
  research: 'research',
  docs: 'documentation',
  chore: 'housekeeping',
};

/** A task's kind as a person says it ("coding", "review"); the kind itself when it is not one of Friday's. */
export function kindWord(kind: string | null | undefined): string {
  const k = (kind ?? '').trim();
  return TASK_KIND_WORDS[k] ?? (k ? k.replace(/[_-]+/g, ' ') : 'this kind of');
}

/** What a routing block means, most specific first. */
export function routingBlockWords(codes: readonly string[] | null | undefined): string {
  const list = (codes ?? []).filter((c): c is string => typeof c === 'string');
  const has = (code: string) => list.some((c) => c === code || c.startsWith(`${code}.`));
  if (has('constraint') || has('advisory.unverified')) {
    return 'This work must stay on a model on this computer, or is marked sensitive, and no connected agent can be shown to meet that.';
  }
  if (has('role.proposed_dag')) {
    return 'Friday thinks this task is more than one kind of work, and waits for you to decide before it starts.';
  }
  if (has('pin.unavailable')) {
    return 'A model was chosen for this work that the agent it reached cannot run.';
  }
  if (has('readiness')) {
    return 'The agents that could take this task are signed out, at a usage limit, or not connected.';
  }
  if (has('role.missing') || has('role.unsupported') || has('role.classification_required')) {
    return 'Friday could not tell what kind of work this task is, so it chose no agent for it.';
  }
  if (has('registry.none_eligible') || has('delegation.all_blocked')) {
    return 'None of your connected agents can take this task as things are.';
  }
  if (has('router.error')) return 'Friday could not decide where this task runs.';
  return 'Friday found no agent this task may start on.';
}
