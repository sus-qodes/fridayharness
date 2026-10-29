/**
 * The routing decision (plan M7a, ADR-0031 §1–§5; spec Part 08 §7, §11–§13, Part 12 §9–§11).
 */
import { describe, expect, it } from 'vitest';
import {
  applicablePins,
  DEFAULT_ROUTING,
  decideRoute,
  type Evidence,
  loadGuide,
  mergeModels,
  type RouteInput,
  type RoutingPin,
} from './index.js';

const guide = loadGuide();
const base = (extra: Partial<RouteInput> = {}): RouteInput => ({
  task: { task_id: 'task_1', kind: 'implementation', role: 'backend' },
  vendor: 'claude-code',
  harness_models: null,
  model_control: 'none',
  models: guide.models,
  guide: guide.classes,
  guide_version: guide.version,
  settings: DEFAULT_ROUTING,
  pins: [],
  evidence: [],
  laya: null,
  ...extra,
});
const pin = (p: Partial<RoutingPin>): RoutingPin => ({
  pin_id: 'pin_1',
  scope: 'project',
  target: null,
  model: null,
  mode: null,
  sensitive: false,
  needs_vision: false,
  until: null,
  source: 'human:local-user',
  note: null,
  ...p,
});

describe('the registry and the guide', () => {
  it('ships priors for the models this machine runs, and a guide that names only known models', () => {
    const ids = guide.models.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-5.6-luna']),
    );
    expect(guide.models.every((m) => m.source === 'seed')).toBe(true);
    for (const [cls, g] of Object.entries(guide.classes)) {
      for (const id of [...g.preferred, ...g.fallback, ...g.avoid]) expect(ids, `${cls}: ${id}`).toContain(id);
    }
    const merged = mergeModels(guide.models, [{ id: 'local-coder', vendors: ['october'], local: true }]);
    expect(merged.find((m) => m.id === 'local-coder')).toMatchObject({ local: true, source: 'project' });
  });
});

describe('decideRoute', () => {
  it('routes by the requirement-weighted fit among the models the harness can run, as advice for an attached host', () => {
    const d = decideRoute(base());
    expect(d.mode).toBe('hybrid');
    expect(d.model).toMatch(/^claude-/);
    expect(d.source).toBe('score');
    expect(d.binding).toBe(false);
    expect(d.reason).toContain('advisory');
    expect(d.reason_codes).toEqual(['laya.none', 'score.best']);
    expect(d.excluded).toContainEqual({ model: 'gpt-5.6-luna', reason: 'harness.cannot_run' });
    expect(d.fallback_chain.at(-1)).toEqual({ model: null, reason: 'human' });
    // A harness that applies the model it is given is bound by the decision.
    expect(decideRoute(base({ model_control: 'set' })).binding).toBe(true);
    // A dry run (no harness yet) considers every model.
    expect(decideRoute(base({ vendor: null })).candidates.map((c) => c.model)).toContain('gpt-5.6-luna');
  });

  it("follows a human's pin over everything else, and never silently replaces it (Part 12 §11)", () => {
    const pinned = decideRoute(
      base({
        pins: [pin({ scope: 'role', target: 'backend', model: 'claude-haiku-5-5', until: '2026-10-21T00:00:00.000Z' })],
      }),
    );
    expect(pinned).toMatchObject({ model: 'claude-haiku-5-5', source: 'pin', pin_id: 'pin_1' });
    expect(pinned.reason).toContain('until 2026-10-21');
    // The most specific pin wins.
    const both = [
      pin({ pin_id: 'p_kind', scope: 'kind', target: 'implementation', model: 'claude-sonnet-5-5' }),
      pin({ pin_id: 'p_task', scope: 'task', target: 'task_1', model: 'claude-opus-5-5' }),
    ];
    expect(applicablePins(both, base().task).map((p) => p.pin_id)).toEqual(['p_task', 'p_kind']);
    expect(decideRoute(base({ pins: both })).model).toBe('claude-opus-5-5');
    // A pinned model this harness cannot run: nobody else's model is used instead.
    const elsewhere = decideRoute(base({ pins: [pin({ model: 'gpt-5.6-luna' })] }));
    expect(elsewhere).toMatchObject({ model: null, source: 'none' });
    expect(elsewhere.reason).toContain('harness.cannot_run');
  });

  it('applies hard constraints before anything else: local only, sensitive work, vision (Part 08 §11)', () => {
    const local = decideRoute(base({ settings: { ...DEFAULT_ROUTING, must_use_local: true } }));
    expect(local).toMatchObject({ model: null, source: 'none', constraints: ['must_use_local'] });
    const withLocal = mergeModels(guide.models, [
      { id: 'local-coder', vendors: ['claude-code'], local: true, capabilities: { code_editing: 0.6 } },
    ]);
    expect(decideRoute(base({ models: withLocal, settings: { ...DEFAULT_ROUTING, must_use_local: true } })).model).toBe(
      'local-coder',
    );
    const sensitive = { ...DEFAULT_ROUTING, sensitive: { kinds: ['implementation'], roles: [] } };
    expect(decideRoute(base({ settings: sensitive }))).toMatchObject({
      model: null,
      reason_codes: ['constraint.sensitive'],
    });
    expect(decideRoute(base({ settings: sensitive, pins: [pin({ model: 'claude-opus-5-5' })] })).model).toBe(
      'claude-opus-5-5',
    );
    const blind = mergeModels(guide.models, [{ id: 'blind', vendors: ['claude-code'], vision: false }]);
    const vision = decideRoute(base({ models: blind, pins: [pin({ needs_vision: true })] }));
    expect(vision.excluded).toContainEqual({ model: 'blind', reason: 'constraint.vision' });
  });

  it('lets measured outcomes count once there are enough of them', () => {
    const top = decideRoute(base()).model as string;
    const poor: Evidence[] = [{ model: top, task_class: 'implementation', samples: 10, passed: 1 }];
    const after = decideRoute(base({ evidence: poor }));
    expect(after.model).not.toBe(top);
    expect(after.candidates.find((c) => c.model === top)).toMatchObject({ pass_rate: 0.1, samples: 10 });
    // Four outcomes are shown but do not decide.
    const few = decideRoute(base({ evidence: [{ ...poor[0], samples: 4 } as Evidence] }));
    expect(few.model).toBe(top);
    expect(few.candidates.find((c) => c.model === top)?.reasons).toContain('evidence.too_few(4/5)');
  });

  it('weighs cost by the optimization, and prefers the cheaper of two close models', () => {
    const cost = decideRoute(base({ settings: { ...DEFAULT_ROUTING, optimize: 'cost' } }));
    const quality = decideRoute(base({ settings: { ...DEFAULT_ROUTING, optimize: 'quality' } }));
    const price = (id: string | null) => guide.models.find((m) => m.id === id)?.price?.input ?? 0;
    expect(price(cost.model)).toBeLessThanOrEqual(price(quality.model));
    const wide = decideRoute(base({ settings: { ...DEFAULT_ROUTING, prefer_cheaper_if_score_delta_below: 0.5 } }));
    expect(wide.model).toBe('claude-haiku-5-5');
    expect(wide.reason_codes).toContain('cheaper.within_delta');
  });

  it("uses the guide in policy mode, its avoid list in every mode, and manual mode's default", () => {
    expect(decideRoute(base({ settings: { ...DEFAULT_ROUTING, mode: 'policy' } }))).toMatchObject({
      model: 'claude-opus-5-5',
      source: 'guide',
    });
    const review = decideRoute(base({ task: { task_id: 'task_2', kind: 'review', role: null } }));
    expect(review.excluded).toContainEqual({ model: 'claude-haiku-5-5', reason: 'guide.avoid' });
    const manual = { ...DEFAULT_ROUTING, mode: 'manual' as const };
    expect(decideRoute(base({ settings: manual }))).toMatchObject({ model: null, reason_codes: ['manual.none'] });
    expect(decideRoute(base({ settings: { ...manual, default_model: 'claude-sonnet-5-5' } }))).toMatchObject({
      model: 'claude-sonnet-5-5',
      source: 'manual',
    });
    // A pin can switch the mode for its scope.
    expect(decideRoute(base({ pins: [pin({ mode: 'manual' })] })).mode).toBe('manual');
  });

  it("takes Laya's choice only when it is calibrated and confident, else falls back as configured (Part 12 §10)", () => {
    const laya = { question_id: 'q', checkpoint: 'typed-decisions', choice: 'claude-sonnet-5-5', confidence: 0.91 };
    expect(decideRoute(base({ laya: { ...laya, threshold: 0.85 } }))).toMatchObject({
      model: 'claude-sonnet-5-5',
      source: 'laya',
      confidence: 0.91,
    });
    const uncalibrated = decideRoute(base({ laya: { ...laya, threshold: null } }));
    expect(uncalibrated.source).toBe('score');
    expect(uncalibrated.reason_codes).toContain('laya.uncalibrated');
    const weak = { ...laya, threshold: 0.95 };
    expect(decideRoute(base({ laya: weak })).reason_codes).toContain('laya.low_confidence');
    expect(decideRoute(base({ laya: weak, settings: { ...DEFAULT_ROUTING, low_confidence: 'human' } }))).toMatchObject({
      model: null,
      source: 'none',
    });
    const strongest = decideRoute(base({ laya: weak, settings: { ...DEFAULT_ROUTING, low_confidence: 'strongest' } }));
    expect(strongest.source).toBe('fallback');
    // A hard constraint beats Laya: its choice must be eligible.
    const outside = decideRoute(base({ laya: { ...laya, choice: 'gpt-5.6-luna', threshold: 0.5 } }));
    expect(outside.model).not.toBe('gpt-5.6-luna');
    expect(outside.reason_codes).toContain('laya.ineligible_choice');
  });
});
