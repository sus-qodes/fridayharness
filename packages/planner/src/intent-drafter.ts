import { PROJECT_INTENT_MAX_CHARS, ProjectIntentProposeRequest } from '@friday/protocol';
import { type ParseResult, type PlannerOutcome, runPlanner } from './model.js';
import type { ModelRequest, PlannerModel } from './providers/types.js';

export const INTENT_DRAFTER_PROMPT_VERSION = 'intent-drafter-2';

/**
 * The one source a revised line may cite besides the documents: the human's feedback. A line
 * that came from it says so, so a reader can tell a document's claim from an instruction.
 */
export const FEEDBACK_SOURCE = 'your feedback';
export const INTENT_FEEDBACK_MAX_CHARS = 2000;

/** One repository document the draft may draw on, already bounded and redacted by the caller. */
export interface IntentSource {
  path: string;
  text: string;
}

/** What the Master Brain proposes; a human approves it before any agent sees it (ADR-0034 §2). */
export interface ProjectIntentDraft {
  objective: string;
  constraints: { text: string; from_paths: string[] }[];
  outcomes: { text: string; from_paths: string[] }[];
  non_goals: { text: string; from_paths: string[] }[];
  definition_of_done: { text: string; from_paths: string[] }[];
}

export interface IntentDrafterPolicy {
  allowRemote: boolean;
  remoteRefusal?: string;
  spentTodayUsd: number;
  dailyBudgetUsd: number;
  prices?: Parameters<typeof runPlanner>[3]['prices'];
}

const LISTS = ['constraints', 'outcomes', 'non_goals', 'definition_of_done'] as const;

const SYSTEM = [
  "You draft a software project's intent for Friday, an orchestrator of coding agents.",
  'A human reviews and approves the draft; until then no agent sees it.',
  'Use only what the provided documents say. Never invent goals, users or rules the documents do not support; leave a list empty instead.',
  'Every line must name, in from_paths, the document paths it came from.',
  'Return only the requested JSON shape.',
].join(' ');

const SHAPE = [
  '- objective: one or two sentences on what the project is for and for whom;',
  '- constraints: what must always hold or must never happen;',
  '- outcomes: what success looks like for the people using it;',
  '- non_goals: what the project deliberately does not do;',
  '- definition_of_done: the quality bar work must meet (for example builds, tests, lint).',
  `At most 12 short lines per list; the whole intent within ${PROJECT_INTENT_MAX_CHARS} characters.`,
];

const INSTRUCTIONS = ['Draft the intent of the whole project:', ...SHAPE].join('\n');

const REVISE_INSTRUCTIONS = [
  'Revise the current intent as the human asks:',
  ...SHAPE,
  'Apply the feedback exactly; keep every line the feedback does not touch; never drop a list the feedback does not mention.',
  `A line the feedback adds or changes cites "${FEEDBACK_SOURCE}" in from_paths; every other line keeps its documents.`,
].join('\n');

/** The intent a revision starts from: the lines of a version, without their provenance. */
export interface IntentRevision {
  current: {
    objective: string;
    constraints: { text: string; from_paths: string[] }[];
    outcomes: { text: string; from_paths: string[] }[];
    non_goals: { text: string; from_paths: string[] }[];
    definition_of_done: { text: string; from_paths: string[] }[];
  };
  /** What the human wants changed, at most `INTENT_FEEDBACK_MAX_CHARS` characters. */
  feedback: string;
}

/**
 * Checks a draft the way the state will (the same schema and size cap), and that every line cites
 * only documents it was given, so the one repair attempt can fix it instead of a refusal later.
 */
export function parseIntentDraft(output: unknown, sourcePaths: readonly string[]): ParseResult<ProjectIntentDraft> {
  const r = ProjectIntentProposeRequest.safeParse(output);
  if (!r.success) {
    return { ok: false, errors: r.error.issues.map((i) => `${i.path.join('.') || 'draft'}: ${i.message}`) };
  }
  const known = new Set(sourcePaths);
  const errors: string[] = [];
  const draft = { objective: r.data.objective } as ProjectIntentDraft;
  let chars = r.data.objective.length;
  for (const k of LISTS) {
    draft[k] = r.data[k].map((raw, i) => {
      const line = typeof raw === 'string' ? { text: raw, from_paths: [] } : raw;
      const unknown = line.from_paths.filter((p) => !known.has(p));
      if (unknown.length) errors.push(`${k}.${i}: cites documents it was not given: ${unknown.join(', ')}`);
      if (!line.from_paths.length) errors.push(`${k}.${i}: name the document it came from in from_paths`);
      chars += line.text.length;
      return line;
    });
  }
  if (chars > PROJECT_INTENT_MAX_CHARS) {
    errors.push(`the intent is ${chars} characters; shorten it to at most ${PROJECT_INTENT_MAX_CHARS}`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: draft };
}

const lineSchema = {
  type: 'object',
  required: ['text', 'from_paths'],
  properties: { text: { type: 'string' }, from_paths: { type: 'array', items: { type: 'string' } } },
};

/** One bounded call that drafts the project intent from the repository's own documents. */
export async function draftProjectIntent(
  model: PlannerModel,
  sources: readonly IntentSource[],
  policy: IntentDrafterPolicy,
  settings: { model: string; maxTokens: number },
  signal?: AbortSignal,
  opts: {
    onCall?: (request: ModelRequest) => void;
    outbound?: (request: ModelRequest) => ModelRequest;
    /** Revise an existing intent from the human's feedback instead of drafting one from nothing. */
    revise?: IntentRevision;
  } = {},
): Promise<PlannerOutcome<ProjectIntentDraft>> {
  const paths = sources.map((s) => s.path);
  const revise = opts.revise;
  const citable = revise ? [...paths, FEEDBACK_SOURCE] : paths;
  return runPlanner(
    model,
    {
      purpose: 'intent',
      model: settings.model,
      system: SYSTEM,
      context: sources.map((s) => `## ${s.path}\n${s.text}`).join('\n\n'),
      instructions: revise ? REVISE_INSTRUCTIONS : INSTRUCTIONS,
      prompt: revise
        ? [
            `Documents you may cite: ${paths.join(', ')}`,
            `The current intent:\n${JSON.stringify(revise.current, null, 2)}`,
            `The human's feedback:\n${revise.feedback}`,
          ].join('\n\n')
        : `Documents you may cite: ${paths.join(', ')}`,
      schema: {
        type: 'object',
        required: ['objective', ...LISTS],
        properties: {
          objective: { type: 'string' },
          ...Object.fromEntries(LISTS.map((k) => [k, { type: 'array', items: lineSchema }])),
        },
      },
      schemaName: 'friday_project_intent',
      maxTokens: settings.maxTokens,
    },
    (output) => parseIntentDraft(output, citable),
    policy,
    { promptVersion: INTENT_DRAFTER_PROMPT_VERSION, ...(signal ? { signal } : {}), ...opts },
  );
}
