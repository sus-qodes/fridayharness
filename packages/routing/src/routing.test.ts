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
  ROLE_REGISTRY_SOURCE,
  type RouteInput,
  type RoutingPin,
  withProjectRoleCandidates,
} from './index.js';

const guide = loadGuide();
const base = (extra: Partial<RouteInput> = {}): RouteInput => ({
  task: {
    task_id: 'task_1',
    kind: 'implementation',
    role: 'backend',
    summary: 'Fix the checkout calculation',
    risk_level: 'low',
    scope: { write: ['src/checkout.ts'], read: [] },
  },
  vendor: 'claude-code',
  harness_models: null,
  model_control: 'none',
  models: guide.models,
  guide: guide.classes,
  profiles: guide.profiles,
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
  it('uses static role rank for production dispatch and ignores score/Laya selection', () => {
    const d = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        laya: {
          question_id: 'q',
          checkpoint: 'test',
          choice: 'claude-haiku-5-5',
          confidence: 1,
          threshold: 0,
        },
      }),
    );
    expect(d).toMatchObject({
      model: 'claude-opus-5-5',
      source: 'registry',
      role: 'backend_engineer',
      role_source: 'task',
      selected_rank: 1,
      failover_policy: 'host_failure',
    });
    expect(d.reason_codes).toContain('registry.rank');
    expect(d.fallback_chain).toEqual([
      { model: 'claude-sonnet-5-5', reason: 'registry.rank.next' },
      { model: null, reason: 'human' },
    ]);
  });

  it('resolves an unroled task deterministically, but blocks an unsupported or undeterminable role', () => {
    expect(
      decideRoute(base({ role_registry: ROLE_REGISTRY_SOURCE, task: { ...base().task, role: null } })),
    ).toMatchObject({
      blocked: false,
      role: 'implementation',
      role_source: 'kind_fallback',
      model: 'claude-opus-5-5',
    });
    expect(
      decideRoute(base({ role_registry: ROLE_REGISTRY_SOURCE, task: { ...base().task, role: 'designer' } })),
    ).toMatchObject({ blocked: true, reason_codes: ['role.unsupported'] });
    expect(
      decideRoute(
        base({
          role_registry: ROLE_REGISTRY_SOURCE,
          task: { ...base().task, kind: 'analysis', role: null, scope: { write: [], read: [] } },
        }),
      ),
    ).toMatchObject({ blocked: true, reason_codes: ['role.missing'] });
  });

  it('uses scope paths for an unknown kind whose paths point at one role', () => {
    const d = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: {
          ...base().task,
          kind: 'analysis',
          role: null,
          scope: { write: ['docs/routing-guide.md'], read: [] },
        },
      }),
    );
    expect(d).toMatchObject({
      blocked: false,
      role: 'docs',
      role_source: 'path_fallback',
      model: 'claude-sonnet-5-5',
    });
    expect(d.reason_codes).toContain('role.path_fallback');
    const source = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: { ...base().task, kind: 'analysis', role: null, scope: { write: ['src/**'], read: [] } },
      }),
    );
    expect(source).toMatchObject({ role: 'implementation', role_source: 'path_fallback', model: 'claude-opus-5-5' });
    const web = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: { ...base().task, kind: 'analysis', role: null, scope: { write: ['apps/web/src/App.tsx'], read: [] } },
      }),
    );
    expect(web).toMatchObject({ role: 'frontend_engineer', role_source: 'path_fallback', model: 'claude-opus-5-5' });
    const api = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: { ...base().task, kind: 'analysis', role: null, scope: { write: ['server/src/api.ts'], read: [] } },
      }),
    );
    expect(api).toMatchObject({ role: 'backend_engineer', role_source: 'path_fallback', model: 'claude-opus-5-5' });
    const ci = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: {
          ...base().task,
          kind: 'analysis',
          role: null,
          scope: { write: ['.github/workflows/ci.yml'], read: [] },
        },
      }),
    );
    expect(ci).toMatchObject({
      role: 'devops_and_terminal',
      role_source: 'path_fallback',
      model: 'claude-sonnet-5-5',
    });
    const verification = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: { ...base().task, kind: 'verification', role: null, scope: { write: [], read: ['src/a.ts'] } },
      }),
    );
    expect(verification).toMatchObject({
      role: 'qa_and_debugging',
      role_source: 'kind_fallback',
      model: 'claude-sonnet-5-5',
    });
    const review = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: { ...base().task, kind: 'review', role: null, scope: { write: [], read: ['src/a.ts'] } },
      }),
    );
    expect(review).toMatchObject({
      role: 'code_reviewer_and_security',
      role_source: 'kind_fallback',
      model: 'claude-opus-5-5',
    });
  });

  it('applies a role pin to the resolved fallback role', () => {
    const d = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        task: { ...base().task, role: null },
        pins: [pin({ scope: 'role', target: 'implementation', model: 'claude-haiku-5-5' })],
      }),
    );
    expect(d).toMatchObject({ model: 'claude-haiku-5-5', source: 'pin', role: 'implementation' });
  });

  it('lets a project supply the only local candidate for a role without displacing Friday’s ranks', () => {
    const models = mergeModels(guide.models, [{ id: 'local-coder', local: true, vendors: ['generic'] }], null);
    const roleRegistry = withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, {
      implementation: [{ model: 'local-coder', harness: 'generic' }],
    });
    const d = decideRoute(
      base({
        role_registry: roleRegistry,
        models,
        settings: { ...DEFAULT_ROUTING, must_use_local: true },
        vendor: 'generic',
        harness_models: ['local-coder'],
        model_control: 'set',
        task: { ...base().task, role: null },
      }),
    );
    expect(d).toMatchObject({
      model: 'local-coder',
      source: 'registry',
      role: 'implementation',
      role_source: 'kind_fallback',
      selected_rank: 4,
      selected_harness: 'generic',
      binding: true,
    });
  });

  it('accepts a validated decision-model role without mutating the task role', () => {
    const d = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        resolved_role: 'review',
        task: { ...base().task, role: null },
      }),
    );
    expect(d).toMatchObject({
      role: 'code_reviewer_and_security',
      role_source: 'decision_model',
      model: 'claude-opus-5-5',
    });
  });

  it('keeps pins ahead of the static registry and excludes candidates for another harness', () => {
    const d = decideRoute(
      base({
        role_registry: ROLE_REGISTRY_SOURCE,
        model_control: 'set',
        pins: [pin({ model: 'claude-haiku-5-5' })],
      }),
    );
    expect(d).toMatchObject({ model: 'claude-haiku-5-5', source: 'pin', binding: true });
    const codex = decideRoute(base({ role_registry: ROLE_REGISTRY_SOURCE, vendor: 'codex', model_control: 'set' }));
    expect(codex).toMatchObject({ model: 'gpt-5.6-luna', selected_rank: 2, source: 'registry' });
    expect(codex.excluded).toContainEqual({ model: 'claude-opus-5-5', reason: 'registry.harness.claude-code' });
  });
  it('routes by the requirement-weighted fit among the models the harness can run, as advice for an attached host', () => {
    const d = decideRoute(base());
    expect(d.mode).toBe('hybrid');
    expect(d.profile).toBe('short');
    expect(d.model).toMatch(/^claude-/);
    expect(d.source).toBe('guide');
    expect(d.binding).toBe(false);
    expect(d.reason).toContain('advisory');
    expect(d.reason_codes).toEqual(['laya.none', 'profile.cheapest_capable']);
    expect(d.excluded).toContainEqual({ model: 'gpt-5.6-luna', reason: 'harness.cannot_run' });
    expect(d.fallback_chain.at(-1)).toEqual({ model: null, reason: 'human' });
    // A harness that applies the model it is given is bound by the decision.
    expect(decideRoute(base({ model_control: 'set' })).binding).toBe(true);
    // A dry run (no harness yet) considers every model.
    expect(decideRoute(base({ vendor: null })).candidates.map((c) => c.model)).toContain('gpt-5.6-luna');
  });

  it.each([
    ['trivial', { kind: 'chore', summary: 'Rename a local variable', scope: { write: ['src/a.ts'], read: [] } }],
    ['short', { kind: 'implementation', summary: 'Fix one file', scope: { write: ['src/a.ts'], read: [] } }],
    [
      'medium',
      {
        kind: 'implementation',
        summary: 'Update several related files',
        scope: { write: ['a.ts', 'b.ts', 'c.ts'], read: [] },
      },
    ],
    ['large', { kind: 'implementation', summary: 'Refactor the source tree', scope: { write: ['src/**'], read: [] } }],
    [
      'high-risk',
      {
        kind: 'implementation',
        summary: 'Update payment authorization',
        risk_level: 'high',
        scope: { write: ['src/payments.ts'], read: [] },
      },
    ],
    [
      'high-risk',
      { kind: 'implementation', summary: 'Update authentication flow', scope: { write: ['src/auth.ts'], read: [] } },
    ],
    ['medium', { kind: 'review', summary: 'Review one module', scope: { write: [], read: ['src/a.ts'] } }],
    ['ambiguous', { kind: 'implementation', summary: 'Read only', scope: { write: [], read: ['src/a.ts'] } }],
    ['ambiguous', { kind: 'unknown', summary: 'Do a thing', scope: { write: ['src/a.ts'], read: [] } }],
    ['ambiguous', { kind: 'implementation', summary: '', scope: null }],
  ] as const)('classifies %s tasks and exposes the reasons', (profile, facts) => {
    const d = decideRoute(base({ task: { ...base().task, ...facts } }));
    expect(d.profile).toBe(profile);
    expect(d.profile_reasons.length).toBeGreaterThan(0);
    if (profile === 'ambiguous') expect(d.blocked).toBe(true);
    if (profile === 'high-risk') {
      expect(d.excluded).toContainEqual({ model: 'claude-haiku-5-5', reason: 'profile.high-risk.avoid' });
    }
  });

  it('uses profile defaults for ordinary work while a human pin still wins', () => {
    const ordinary = decideRoute(base({ model_control: 'set' }));
    expect(ordinary.model).toBe('claude-haiku-5-5');
    const projectOverride = decideRoute(
      base({
        model_control: 'set',
        settings: {
          ...DEFAULT_ROUTING,
          profile_preferences: {
            short: {
              preferred: ['claude-haiku-5-5'],
              fallback: ['claude-sonnet-5-5'],
              avoid: [],
              notes: 'project override',
              strategy: 'score',
              min_fit: null,
            },
          },
        },
      }),
    );
    expect(projectOverride.model).toBe('claude-haiku-5-5');
    const pinned = decideRoute(
      base({
        model_control: 'set',
        pins: [pin({ scope: 'task', target: 'task_1', model: 'claude-opus-5-5' })],
      }),
    );
    expect(pinned).toMatchObject({ model: 'claude-opus-5-5', source: 'pin', profile: 'short' });
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
    expect(local).toMatchObject({ model: null, source: 'none', constraints: ['must_use_local'], blocked: true });
    const withLocal = mergeModels(guide.models, [
      { id: 'local-coder', vendors: ['claude-code'], local: true, capabilities: { code_editing: 0.6 } },
    ]);
    const onlyLocal = { ...DEFAULT_ROUTING, must_use_local: true };
    // A host that applies the model it is given runs the local one.
    expect(decideRoute(base({ models: withLocal, settings: onlyLocal, model_control: 'set' }))).toMatchObject({
      model: 'local-coder',
      binding: true,
      blocked: false,
    });
    // One that chooses its own model meets the constraint only when it is seen running a local model
    // (review F01): advice alone would not keep the work local.
    expect(decideRoute(base({ models: withLocal, settings: onlyLocal }))).toMatchObject({
      model: null,
      blocked: true,
      reason_codes: expect.arrayContaining(['advisory.unverified']),
    });
    expect(
      decideRoute(base({ models: withLocal, settings: onlyLocal, observed_model: 'claude-opus-5-5' })).blocked,
    ).toBe(true);
    expect(decideRoute(base({ models: withLocal, settings: onlyLocal, observed_model: 'local-coder' }))).toMatchObject({
      model: 'local-coder',
      binding: false,
      blocked: false,
    });
    const sensitive = { ...DEFAULT_ROUTING, sensitive: { kinds: ['implementation'], roles: [] } };
    expect(decideRoute(base({ settings: sensitive }))).toMatchObject({
      model: null,
      blocked: true,
      reason_codes: ['constraint.sensitive'],
    });
    // Sensitive work runs only on an approved local model (Part 08 §11). A general pin is no consent
    // for it, and a pin made for sensitive work cannot approve a remote model (M7 review §6; this
    // test accepted a general pin of a remote model until M7.1).
    const pinnedOpus = [pin({ model: 'claude-opus-5-5' })];
    expect(decideRoute(base({ settings: sensitive, pins: pinnedOpus, model_control: 'set' }))).toMatchObject({
      model: null,
      blocked: true,
      reason_codes: ['constraint.sensitive'],
    });
    const sensitiveOpus = decideRoute(
      base({ settings: sensitive, pins: [pin({ model: 'claude-opus-5-5', sensitive: true })], model_control: 'set' }),
    );
    expect(sensitiveOpus).toMatchObject({ model: null, blocked: true });
    expect(sensitiveOpus.excluded).toContainEqual({ model: 'claude-opus-5-5', reason: 'constraint.sensitive_local' });
    const sensitiveLocal = [pin({ model: 'local-coder', sensitive: true })];
    expect(
      decideRoute(base({ models: withLocal, settings: sensitive, pins: sensitiveLocal, model_control: 'set' })),
    ).toMatchObject({ model: 'local-coder', binding: true, blocked: false });
    expect(decideRoute(base({ models: withLocal, settings: sensitive, pins: sensitiveLocal })).blocked).toBe(true);
    expect(
      decideRoute(base({ models: withLocal, settings: sensitive, pins: sensitiveLocal, observed_model: 'local-coder' }))
        .model,
    ).toBe('local-coder');
    const blind = mergeModels(guide.models, [{ id: 'blind', vendors: ['claude-code'], vision: false }]);
    const vision = decideRoute(base({ models: blind, pins: [pin({ needs_vision: true })] }));
    expect(vision.excluded).toContainEqual({ model: 'blind', reason: 'constraint.vision' });
  });

  it('blocks work it cannot route, and has no opinion on a host whose models it does not know (review F01)', () => {
    // A pin that cannot run here, manual mode without a model, and Laya configured to stop: blocked.
    expect(decideRoute(base({ pins: [pin({ model: 'gpt-5.6-luna' })] })).blocked).toBe(true);
    expect(decideRoute(base({ settings: { ...DEFAULT_ROUTING, mode: 'manual' } })).blocked).toBe(true);
    const laya = { question_id: 'q', checkpoint: 'c', choice: 'claude-opus-5-5', confidence: 0.2, threshold: 0.8 };
    expect(decideRoute(base({ laya, settings: { ...DEFAULT_ROUTING, low_confidence: 'block' } })).blocked).toBe(true);
    expect(decideRoute(base({ laya, settings: { ...DEFAULT_ROUTING, low_confidence: 'score' } })).blocked).toBe(false);
    // A host that runs none of the models Friday knows and declares none: no opinion, not a block.
    const generic = decideRoute(base({ vendor: 'generic' }));
    expect(generic).toMatchObject({ model: null, blocked: false, reason_codes: ['harness.models_unknown'] });
    // ... unless a hard constraint must hold, which nothing then shows it meets.
    expect(
      decideRoute(base({ vendor: 'generic', settings: { ...DEFAULT_ROUTING, must_use_local: true } })).blocked,
    ).toBe(true);
    // Every model the harness can run is on the guide's avoid list: blocked as well.
    const avoidAll = {
      ...guide.classes,
      implementation: {
        preferred: [],
        fallback: [],
        avoid: ['claude-haiku-5-5'],
        notes: null,
        strategy: 'score' as const,
        min_fit: null,
      },
    };
    expect(
      decideRoute(base({ harness_models: ['claude-haiku-5-5'], guide: avoidAll, model_control: 'set' })).blocked,
    ).toBe(true);
  });

  it('lets measured outcomes count once there are enough of them', () => {
    const scoreSettings = {
      ...DEFAULT_ROUTING,
      profile_preferences: {
        short: {
          preferred: [],
          fallback: [],
          avoid: [],
          notes: 'score regression',
          strategy: 'score' as const,
          min_fit: null,
        },
      },
    };
    const top = decideRoute(base({ settings: scoreSettings })).model as string;
    const poor: Evidence[] = [{ model: top, task_class: 'implementation', samples: 10, passed: 1 }];
    const after = decideRoute(base({ settings: scoreSettings, evidence: poor }));
    expect(after.model).not.toBe(top);
    expect(after.candidates.find((c) => c.model === top)).toMatchObject({ pass_rate: 0.1, samples: 10 });
    // Four outcomes are shown but do not decide.
    const few = decideRoute(base({ settings: scoreSettings, evidence: [{ ...poor[0], samples: 4 } as Evidence] }));
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
      model: 'claude-sonnet-5-5',
      source: 'guide',
    });
    const review = decideRoute(
      base({
        task: {
          ...base().task,
          task_id: 'task_2',
          kind: 'review',
          role: null,
          summary: 'Review the change',
        },
      }),
    );
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
    expect(uncalibrated.source).toBe('guide');
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
