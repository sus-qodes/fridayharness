/**
 * The Master Brain's project-intent draft (ADR-0034 §2; plan Phase 3.2).
 */
import { sequentialIds } from '@friday/core';
import { openDatabase } from '@friday/db';
import { type Actor, PROJECT_INTENT_MAX_CHARS } from '@friday/protocol';
import { FridayState } from '@friday/state';
import { FakeClock } from '@friday/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { type BrainSettings, MasterBrain } from './brain.js';
import { INTENT_DRAFTER_PROMPT_VERSION, type IntentSource, parseIntentDraft } from './intent-drafter.js';
import { FakePlannerModel, type FakeResponse } from './providers/fake.js';

const PROJECT = 'proj_00000000000000000000000001';
const human: Actor = { kind: 'human', id: 'local-operator' };
const SOURCES: IntentSource[] = [
  { path: 'README.md', text: '# Edutube\nA distraction-free study platform for students. No ads, ever.' },
  { path: 'docs/ROADMAP.md', text: '# Roadmap\nPlaylists first. Social features are out of scope.' },
];
const DRAFT = {
  objective: 'A distraction-free study platform for students.',
  constraints: [{ text: 'Never show ads.', from_paths: ['README.md'] }],
  outcomes: [{ text: 'Students finish their playlists.', from_paths: ['docs/ROADMAP.md'] }],
  non_goals: [{ text: 'Social features.', from_paths: ['docs/ROADMAP.md'] }],
  definition_of_done: [],
};

const SETTINGS: BrainSettings = {
  model: 'claude-opus-5-5',
  maxTokens: 4000,
  autoApprove: false,
  escalateAfterFailures: 2,
  maxReplans: 3,
  allowRemote: false,
  dailyBudgetUsd: 5,
};

let state: FridayState;

beforeEach(() => {
  state = new FridayState({
    db: openDatabase(':memory:'),
    clock: new FakeClock('2026-10-21T10:00:00.000Z'),
    ids: sequentialIds(),
  });
  state.ensureProject({ project_id: PROJECT, name: 'edutube', root_path: 'C:/demo/edutube' });
});

function brain(responses: FakeResponse[] | null, sources: IntentSource[] = SOURCES) {
  const model = responses ? new FakePlannerModel(responses) : null;
  return {
    model,
    brain: new MasterBrain({
      state,
      projectId: PROJECT,
      model,
      ...(model ? {} : { plannerUnavailable: 'no provider configured' }),
      settings: SETTINGS,
      projectContext: () => 'edutube',
      intentSources: () => sources,
      retryDelaysMs: [],
    }),
  };
}

describe('parseIntentDraft', () => {
  const paths = SOURCES.map((s) => s.path);

  it('accepts a draft that cites only the documents it was given', () => {
    const r = parseIntentDraft(DRAFT, paths);
    expect(r.ok).toBe(true);
  });

  it('refuses invented sources, uncited lines and an intent too long for every packet', () => {
    const r = parseIntentDraft(
      {
        ...DRAFT,
        constraints: [
          { text: 'Never show ads.', from_paths: ['docs/SECRET.md'] },
          { text: 'Keep it fast.', from_paths: [] },
        ],
        outcomes: Array.from({ length: 12 }, (_, i) => ({
          text: `${i} ${'x'.repeat(250)}`,
          from_paths: ['README.md'],
        })),
      },
      paths,
    );
    expect(r.ok).toBe(false);
    const errors = r.ok ? [] : r.errors;
    expect(errors.some((e) => e.includes('docs/SECRET.md'))).toBe(true);
    expect(errors.some((e) => e.includes('constraints.1') && e.includes('from_paths'))).toBe(true);
    expect(errors.some((e) => e.includes(String(PROJECT_INTENT_MAX_CHARS)))).toBe(true);
  });

  it('refuses a draft without an objective', () => {
    expect(parseIntentDraft({ ...DRAFT, objective: '' }, paths).ok).toBe(false);
  });
});

describe('Master Brain intent draft (ADR-0034 §2)', () => {
  it('records the draft as a planner proposal that counts only once a human approves it', async () => {
    const { brain: b, model } = brain([{ purpose: 'intent', output: DRAFT }]);
    const result = await b.requestIntentDraft();
    expect(result).toBe('proposed project intent v1');
    const v = state.q.proposedProjectIntent(PROJECT);
    expect(v).toMatchObject({ version: 1, status: 'proposed', proposed_by: { kind: 'master_brain' } });
    expect(v?.constraints).toEqual([{ text: 'Never show ads.', source: 'planner', from_paths: ['README.md'] }]);
    expect(state.q.approvedProjectIntent(PROJECT)).toBeUndefined();
    // The model saw only the documents, and the call is accounted like planning.
    expect(model?.requests[0]?.context).toContain('## README.md');
    const calls = state.q.modelCalls(PROJECT, { limit: 10 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ purpose: 'intent', prompt_version: INTENT_DRAFTER_PROMPT_VERSION });

    state.intent.approve(PROJECT, human, 1);
    expect(state.q.approvedProjectIntent(PROJECT)?.version).toBe(1);
  });

  it('does not draft over a proposal waiting for a human, unless forced', async () => {
    state.intent.propose(PROJECT, human, { objective: 'Mine.' });
    const { brain: b } = brain([{ purpose: 'intent', output: DRAFT }]);
    expect(await b.requestIntentDraft()).toBe('skipped: project intent v1 is waiting for a decision');
    expect(await b.requestIntentDraft({ force: true })).toBe('proposed project intent v2');
    expect(state.q.projectIntent(PROJECT, 1).status).toBe('superseded');
  });

  it('says why when there is no planner or nothing to draft from', async () => {
    expect(await brain(null).brain.requestIntentDraft()).toContain('skipped: no planner is configured');
    expect(await brain([{ purpose: 'intent', output: DRAFT }], []).brain.requestIntentDraft()).toBe(
      'skipped: the repository has no README or docs to draft from',
    );
    expect(state.q.projectIntents(PROJECT)).toEqual([]);
  });

  it('ends with the reason when the model twice drafts something unusable', async () => {
    const bad = { ...DRAFT, constraints: [{ text: 'Invented.', from_paths: ['nowhere.md'] }] };
    const { brain: b } = brain([
      { purpose: 'intent', output: bad },
      { purpose: 'intent', output: bad },
    ]);
    const result = await b.requestIntentDraft();
    expect(result).toMatch(/^failed: /);
    expect(result).toContain('nowhere.md');
    expect(state.q.projectIntents(PROJECT)).toEqual([]);
  });

  it('ends with the reason when the provider refuses the request', async () => {
    const { brain: b } = brain([
      { purpose: 'intent', error: { code: 'auth', message: 'invalid key', retryable: false } },
    ]);
    const result = await b.requestIntentDraft();
    expect(result).toMatch(/^failed: /);
    expect(state.q.projectIntents(PROJECT)).toEqual([]);
  });
});

describe("revising the intent from the human's feedback", () => {
  const REVISED = {
    ...DRAFT,
    objective: 'A distraction-free study platform for students and their teachers.',
    outcomes: [...DRAFT.outcomes, { text: 'Teachers see what their classes studied.', from_paths: ['your feedback'] }],
  };

  it('shows the model the current proposal and the feedback, and the new version replaces it', async () => {
    const { brain: b, model } = brain([
      { purpose: 'intent', output: DRAFT },
      { purpose: 'intent', output: REVISED },
    ]);
    expect(await b.requestIntentDraft()).toBe('proposed project intent v1');
    const result = await b.requestIntentDraft({
      feedback: 'It is for teachers too: they see what their classes studied.',
    });
    expect(result).toBe('proposed project intent v2 (revised from v1 with your feedback)');
    const req = model?.requests[1];
    expect(req?.instructions).toContain('Revise the current intent as the human asks');
    expect(req?.prompt).toContain('The current intent:');
    expect(req?.prompt).toContain('"objective": "A distraction-free study platform for students."');
    expect(req?.prompt).toContain("The human's feedback:\nIt is for teachers too");
    expect(req?.context).toContain('## README.md');
    const v2 = state.q.proposedProjectIntent(PROJECT);
    expect(v2?.version).toBe(2);
    expect(v2?.outcomes[1]).toMatchObject({
      text: 'Teachers see what their classes studied.',
      from_paths: ['your feedback'],
    });
    expect(state.q.projectIntent(PROJECT, 1).status).toBe('superseded');
    expect(state.q.modelCalls(PROJECT, { limit: 10 })).toHaveLength(2);
  });

  it('revises the approved intent when no proposal waits, or the version named', async () => {
    state.intent.propose(PROJECT, human, { objective: 'Mine.' });
    state.intent.approve(PROJECT, human, 1);
    // The second revision differs from the first: a proposal with the same content is not a new version.
    const { brain: b } = brain([
      { purpose: 'intent', output: REVISED },
      { purpose: 'intent', output: { ...REVISED, objective: 'For students, teachers and parents.' } },
    ]);
    expect(await b.requestIntentDraft({ feedback: 'Add the teachers.' })).toBe(
      'proposed project intent v2 (revised from v1 with your feedback)',
    );
    expect(state.q.approvedProjectIntent(PROJECT)?.version).toBe(1);
    expect(state.q.proposedProjectIntent(PROJECT)?.version).toBe(2);
    expect(await b.requestIntentDraft({ feedback: 'From the first one.', from: 1 })).toBe(
      'proposed project intent v3 (revised from v1 with your feedback)',
    );
    expect(await b.requestIntentDraft({ feedback: 'x', from: 9 })).toBe(
      'skipped: there is no project intent v9 to revise',
    );
  });

  it('says so when there is nothing to revise, and refuses a line citing an unknown source', async () => {
    const { brain: b } = brain([{ purpose: 'intent', output: REVISED }]);
    expect(await b.requestIntentDraft({ feedback: 'Add the teachers.' })).toBe(
      'skipped: nothing to revise: no project intent exists yet (ask for a draft first)',
    );
    // Without a revision, "your feedback" is not a document the draft may cite.
    expect(parseIntentDraft(REVISED, ['README.md', 'docs/ROADMAP.md']).ok).toBe(false);
    expect(parseIntentDraft(REVISED, ['README.md', 'docs/ROADMAP.md', 'your feedback']).ok).toBe(true);
  });
});
