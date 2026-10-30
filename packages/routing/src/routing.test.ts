/**
 * Static role-registry dispatch (ADR-0031's 2026-10-21 amendment): pins and hard constraints come
 * first, registry rank is the only dispatch authority, and unresolved or proposed roles never guess.
 */
import { describe, expect, it } from 'vitest';
import {
  applicablePins,
  assessReadiness,
  DEFAULT_ROUTING,
  decideRoute,
  loadModelCatalog,
  mergeModels,
  type ReadinessEvidence,
  ROLE_REGISTRY_SOURCE,
  type RouteInput,
  type RoutingPin,
  withProjectRoleCandidates,
} from './index.js';

const catalog = loadModelCatalog();
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
  models: catalog.models,
  settings: DEFAULT_ROUTING,
  pins: [],
  role_registry: ROLE_REGISTRY_SOURCE,
  ...extra,
});
const pin = (p: Partial<RoutingPin>): RoutingPin => ({
  pin_id: 'pin_1',
  scope: 'project',
  target: null,
  model: null,
  sensitive: false,
  needs_vision: false,
  until: null,
  source: 'human:local-user',
  note: null,
  ...p,
});

describe('the model catalog', () => {
  it('ships Friday priors and merges a project model without losing provenance', () => {
    const ids = catalog.models.map((m) => m.id);
    expect(ids).toEqual(
      expect.arrayContaining(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'gpt-5.6-luna']),
    );
    expect(catalog.models.every((m) => m.source === 'seed')).toBe(true);
    const merged = mergeModels(catalog.models, [{ id: 'local-coder', vendors: ['october'], local: true }]);
    expect(merged.find((m) => m.id === 'local-coder')).toMatchObject({ local: true, source: 'project' });
  });
});

describe('decideRoute', () => {
  it('uses static role rank for production dispatch and records the host-failure fallback', () => {
    const d = decideRoute(base());
    expect(d).toMatchObject({
      mode: 'registry',
      model: 'claude-sonnet-5-5',
      source: 'registry',
      task_class: 'backend_engineer',
      role: 'backend_engineer',
      role_source: 'task',
      selected_rank: 1,
      selected_harness: 'claude-code',
      failover_policy: 'host_failure',
      binding: false,
    });
    expect(d.reason_codes).toContain('registry.rank');
    expect(d.candidates[0]).toMatchObject({ model: 'claude-sonnet-5-5', score: 1, fit: 1, samples: 0 });
    // Claude Code holds no other backend rank: after it, only a human.
    expect(d.fallback_chain).toEqual([{ model: null, reason: 'human' }]);
    // A host that can run more of the role's models falls back to the next rank it can run.
    const generic = decideRoute(base({ vendor: 'generic', harness_models: ['claude-opus-5-5', 'claude-sonnet-5-5'] }));
    expect(generic.fallback_chain).toEqual([
      { model: 'claude-opus-5-5', reason: 'registry.rank.next' },
      { model: null, reason: 'human' },
    ]);
  });

  it('resolves an unroled task deterministically, but blocks an unsupported or undeterminable role', () => {
    expect(decideRoute(base({ task: { ...base().task, role: null } }))).toMatchObject({
      blocked: false,
      role: 'implementation',
      role_source: 'kind_fallback',
      model: 'claude-sonnet-5-5',
    });
    expect(decideRoute(base({ task: { ...base().task, role: 'designer' } }))).toMatchObject({
      blocked: true,
      reason_codes: ['role.unsupported'],
    });
    expect(
      decideRoute(
        base({
          task: { ...base().task, kind: 'analysis', role: null, scope: { write: [], read: [] } },
        }),
      ),
    ).toMatchObject({ blocked: true, reason_codes: ['role.missing'] });
  });

  it('uses scope paths for an unknown kind whose paths point at one role', () => {
    const docs = decideRoute(
      base({
        task: {
          ...base().task,
          kind: 'analysis',
          role: null,
          scope: { write: ['docs/routing-guide.md'], read: [] },
        },
      }),
    );
    expect(docs).toMatchObject({
      blocked: false,
      role: 'docs',
      role_source: 'path_fallback',
      model: 'claude-sonnet-5-5',
    });
    expect(docs.reason_codes).toContain('role.path_fallback');
    const source = decideRoute(
      base({
        task: { ...base().task, kind: 'analysis', role: null, scope: { write: ['src/**'], read: [] } },
      }),
    );
    expect(source).toMatchObject({ role: 'implementation', role_source: 'path_fallback', model: 'claude-sonnet-5-5' });
  });

  it('blocks a persisted proposed DAG or a blocked role resolution instead of guessing', () => {
    const proposed = decideRoute(
      base({
        task: {
          ...base().task,
          role: null,
          role_source: 'decision_model',
          role_confidence: 0.85,
          role_decision_id: 'rdec_00000000000000000000000001',
          role_intent_version: 'ri1_0000000000000000',
          role_registry_version: ROLE_REGISTRY_SOURCE.version,
        },
      }),
    );
    expect(proposed).toMatchObject({
      blocked: true,
      role: null,
      role_source: 'decision_model',
      role_proposed: true,
      role_confidence: 0.85,
      role_decision_id: 'rdec_00000000000000000000000001',
      role_intent_version: 'ri1_0000000000000000',
      model: null,
      failover_policy: 'none',
    });
    expect(proposed.reason_codes).toContain('role.proposed_dag');
    const blocked = decideRoute(
      base({
        task: {
          ...base().task,
          role: null,
          role_source: 'missing',
          role_decision_id: 'rdec_00000000000000000000000002',
        },
      }),
    );
    expect(blocked).toMatchObject({ blocked: true, role: null, role_source: 'missing', model: null });
    expect(blocked.reason_codes).toContain('role.classification_required');
    // A pinned model is no approval of a split or a substitute for a role (review 2026-10-22 R3).
    for (const [role_source, code] of [
      ['decision_model', 'role.proposed_dag'],
      ['missing', 'role.classification_required'],
    ] as const) {
      const pinnedToo = decideRoute(
        base({
          pins: [pin({ model: 'claude-sonnet-5-5' })],
          task: {
            ...base().task,
            role: null,
            role_source,
            role_decision_id: 'rdec_00000000000000000000000003',
          },
        }),
      );
      expect(pinnedToo).toMatchObject({ blocked: true, role: null, model: null, source: 'none' });
      expect(pinnedToo.reason_codes).toContain(code);
      expect(pinnedToo.reason_codes).not.toContain('pin');
    }
  });

  it('applies a role pin to the resolved fallback role', () => {
    const d = decideRoute(
      base({
        task: { ...base().task, role: null },
        pins: [pin({ scope: 'role', target: 'implementation', model: 'claude-haiku-5-5' })],
      }),
    );
    expect(d).toMatchObject({ model: 'claude-haiku-5-5', source: 'pin', role: 'implementation' });
  });

  it('lets a project append the only local candidate for a role without displacing Friday ranks', () => {
    const models = mergeModels(catalog.models, [{ id: 'local-coder', local: true, vendors: ['generic'] }], null);
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
      selected_harness: 'generic',
      binding: true,
    });
    expect(d.selected_rank).toBeGreaterThan(1);
  });

  it('applies a validated decision-model role only after the deterministic fallback', () => {
    const deterministic = decideRoute(
      base({
        resolved_role: 'review',
        task: { ...base().task, role: null },
      }),
    );
    expect(deterministic).toMatchObject({ role: 'implementation', role_source: 'kind_fallback' });
    const d = decideRoute(
      base({
        resolved_role: 'review',
        task: { ...base().task, kind: 'analysis', role: null, scope: { write: [], read: [] } },
      }),
    );
    expect(d).toMatchObject({
      role: 'code_reviewer_and_security',
      role_source: 'decision_model',
      model: 'claude-opus-5-5',
    });
  });

  it('keeps pins ahead of the static registry and excludes candidates for another harness', () => {
    const d = decideRoute(base({ model_control: 'set', pins: [pin({ model: 'claude-haiku-5-5' })] }));
    expect(d).toMatchObject({ model: 'claude-haiku-5-5', source: 'pin', binding: true, pin_id: 'pin_1' });
    const codex = decideRoute(base({ vendor: 'codex', model_control: 'set' }));
    expect(codex).toMatchObject({ model: 'openai/gpt-6.1-sol', selected_rank: 4, source: 'registry' });
    expect(codex.excluded).toContainEqual({ model: 'claude-sonnet-5-5', reason: 'registry.harness.claude-code' });
    // A host the owner's ranking does not list for a role gets none of its work; its place in other
    // roles is unchanged (Gemini CLI is first for DevOps).
    const gemini = decideRoute(base({ vendor: 'gemini' }));
    expect(gemini).toMatchObject({ blocked: true, reason_codes: ['registry.none_eligible'] });
    const devops = decideRoute(base({ vendor: 'gemini', task: { ...base().task, role: 'devops' } }));
    expect(devops).toMatchObject({ model: 'gemini-3.8-flash', selected_rank: 1, selected_harness: 'gemini' });
  });

  it("follows a human's pin over everything else, and never silently replaces it", () => {
    const pinned = decideRoute(
      base({
        pins: [pin({ scope: 'role', target: 'backend', model: 'claude-haiku-5-5', until: '2026-10-21T00:00:00.000Z' })],
      }),
    );
    expect(pinned).toMatchObject({ model: 'claude-haiku-5-5', source: 'pin', pin_id: 'pin_1' });
    expect(pinned.reason).toContain('until 2026-10-21');
    const both = [
      pin({ pin_id: 'p_kind', scope: 'kind', target: 'implementation', model: 'claude-sonnet-5-5' }),
      pin({ pin_id: 'p_task', scope: 'task', target: 'task_1', model: 'claude-opus-5-5' }),
    ];
    expect(applicablePins(both, base().task).map((p) => p.pin_id)).toEqual(['p_task', 'p_kind']);
    expect(decideRoute(base({ pins: both })).model).toBe('claude-opus-5-5');
    const elsewhere = decideRoute(base({ pins: [pin({ model: 'gpt-5.6-luna' })] }));
    expect(elsewhere).toMatchObject({ model: null, source: 'none', blocked: true });
    expect(elsewhere.reason).toContain('harness.cannot_run');
  });

  it('applies hard constraints before registry rank: local only, sensitive work, vision', () => {
    const local = decideRoute(base({ settings: { ...DEFAULT_ROUTING, must_use_local: true } }));
    expect(local).toMatchObject({ model: null, source: 'none', constraints: ['must_use_local'], blocked: true });
    const withLocal = mergeModels(catalog.models, [
      { id: 'local-coder', vendors: ['claude-code'], local: true, capabilities: { code_editing: 0.6 } },
    ]);
    const localRegistry = withProjectRoleCandidates(ROLE_REGISTRY_SOURCE, {
      backend_engineer: [{ model: 'local-coder', harness: 'claude-code' }],
    });
    const onlyLocal = { ...DEFAULT_ROUTING, must_use_local: true };
    expect(
      decideRoute(base({ models: withLocal, role_registry: localRegistry, settings: onlyLocal, model_control: 'set' })),
    ).toMatchObject({
      model: 'local-coder',
      binding: true,
      blocked: false,
    });
    expect(decideRoute(base({ models: withLocal, role_registry: localRegistry, settings: onlyLocal }))).toMatchObject({
      model: null,
      blocked: true,
      reason_codes: expect.arrayContaining(['advisory.unverified']),
    });
    expect(
      decideRoute(
        base({
          models: withLocal,
          role_registry: localRegistry,
          settings: onlyLocal,
          observed_model: 'claude-opus-5-5',
        }),
      ).blocked,
    ).toBe(true);
    expect(
      decideRoute(
        base({
          models: withLocal,
          role_registry: localRegistry,
          settings: onlyLocal,
          observed_model: 'local-coder',
        }),
      ),
    ).toMatchObject({
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
    expect(
      decideRoute(
        base({
          models: withLocal,
          settings: sensitive,
          pins: [pin({ model: 'local-coder', sensitive: true })],
          model_control: 'set',
        }),
      ),
    ).toMatchObject({ model: 'local-coder', binding: true, blocked: false });

    const blind = mergeModels(catalog.models, [{ id: 'blind', vendors: ['claude-code'], vision: false }]);
    const vision = decideRoute(base({ models: blind, pins: [pin({ model: 'blind', needs_vision: true })] }));
    expect(vision.blocked).toBe(true);
    expect(vision.excluded).toContainEqual({ model: 'blind', reason: 'constraint.vision' });
  });

  it('blocks a role with no eligible candidate instead of falling back to another model', () => {
    const d = decideRoute(base({ harness_models: ['claude-haiku-5-5'], model_control: 'set' }));
    expect(d).toMatchObject({ model: null, blocked: true, source: 'none' });
    expect(d.reason_codes).toContain('registry.none_eligible');
  });

  it('binds a host that applies models and advises one that does not', () => {
    const advisory = decideRoute(base());
    expect(advisory.binding).toBe(false);
    expect(advisory.reason).toContain('advisory');
    const bound = decideRoute(base({ model_control: 'set' }));
    expect(bound.binding).toBe(true);
    expect(bound.reason).not.toContain('advisory');
  });
});

describe('readiness filters candidates and never reorders (ADR-0035 §2)', () => {
  const NOW = '2026-10-22T12:00:00.000Z';
  const bench = (host: string, model: string | null, until: string, detail = 'rate limited'): ReadinessEvidence => ({
    host,
    model,
    stage: 'benched',
    status: 'failed',
    checked_at: NOW,
    expires_at: until,
    source: 'test',
    version: null,
    detail,
  });
  /** Every host connected now, with the given evidence. */
  const readiness =
    (evidence: ReadinessEvidence[], live = true) =>
    (host: string, model: string) =>
      assessReadiness(evidence, { host, model, live, now: NOW });
  const architect = (extra: Partial<RouteInput> = {}) =>
    base({ task: { ...base().task, kind: 'research', role: 'architect' }, ...extra });

  it('without a readiness source the decision is pure, and records no checks', () => {
    const d = decideRoute(architect());
    expect(d).toMatchObject({ model: 'claude-opus-5-5', selected_rank: 1, readiness: [] });
  });

  it('skips a benched rank 1 for the next rank the harness can run, and records every check made', () => {
    const until = '2026-10-22T12:30:00.000Z';
    const d = decideRoute(architect({ readiness: readiness([bench('claude-code', 'claude-opus-5-5', until)]) }));
    expect(d).toMatchObject({ model: 'claude-fable-5-1', source: 'registry', selected_rank: 2, blocked: false });
    expect(d.excluded).toContainEqual({ model: 'claude-opus-5-5', reason: 'readiness.benched' });
    expect(d.readiness).toEqual([
      {
        host: 'claude-code',
        model: 'claude-opus-5-5',
        dispatchable: false,
        reason: `claude-code/claude-opus-5-5 is benched until ${until}: rate limited`,
        bench_until: until,
      },
      { host: 'claude-code', model: 'claude-fable-5-1', dispatchable: true, reason: 'ready', bench_until: null },
    ]);
    // Rank is untouched: the chain still names what readiness skipped nowhere, and what is next.
    expect(d.fallback_chain).toEqual([{ model: null, reason: 'human' }]);
  });

  it('blocks with the readiness reasons when every candidate is out, never falling back to an unready one', () => {
    const d = decideRoute(
      architect({
        readiness: readiness([bench('claude-code', null, '2026-10-22T12:10:00.000Z', 'crashed')]),
      }),
    );
    expect(d.blocked).toBe(true);
    expect(d.reason_codes).toEqual(expect.arrayContaining(['registry.none_eligible', 'readiness.none_ready']));
    expect(d.reason).toContain(
      'not ready: claude-code/claude-opus-5-5 is benched until 2026-10-22T12:10:00.000Z: crashed',
    );
    expect(d.excluded.map((e) => e.reason).filter((r) => r === 'readiness.benched')).toHaveLength(2);
  });

  it('a host nobody has seen is out on a dry run, so the next host that was seen takes the rank', () => {
    // A dry run (no harness): each candidate is judged on its own host; nothing is connected, and
    // only Codex was seen by a doctor check within the day.
    const doctor = (['detected', 'configured', 'handshake'] as const).map(
      (stage): ReadinessEvidence => ({
        host: 'codex',
        model: null,
        stage,
        status: 'passed',
        checked_at: NOW,
        expires_at: '2026-10-23T12:00:00.000Z',
        source: 'harness doctor',
        version: null,
        detail: null,
      }),
    );
    const d = decideRoute(base({ vendor: null, readiness: readiness(doctor, false) }));
    expect(d).toMatchObject({ model: 'openai/gpt-6.1-sol', selected_rank: 4, selected_harness: 'codex' });
    expect(d.excluded).toContainEqual({ model: 'claude-sonnet-5-5', reason: 'readiness.detected.missing' });
  });

  it('a pinned model still needs a ready host: a human decides, nothing else is used', () => {
    const d = decideRoute(
      base({
        pins: [pin({ model: 'claude-sonnet-5-5' })],
        readiness: readiness([
          {
            host: 'claude-code',
            model: null,
            stage: 'authenticated',
            status: 'failed',
            checked_at: NOW,
            expires_at: null,
            source: 'test',
            version: null,
            detail: 'not logged in',
          },
        ]),
      }),
    );
    expect(d).toMatchObject({ blocked: true, model: null, pin_id: 'pin_1' });
    expect(d.reason_codes).toEqual(expect.arrayContaining(['pin.unavailable', 'readiness.authenticated.failed']));
    expect(d.reason).toContain(
      'claude-sonnet-5-5 is pinned, but claude-code/claude-sonnet-5-5 is not signed in: not logged in',
    );
  });

  it('a failed verification or a work error is never readiness: only host evidence excludes', () => {
    // Nothing about outcomes reaches the readiness source; a host seen signed in stays in.
    const seen: ReadinessEvidence = {
      host: 'claude-code',
      model: 'claude-opus-5-5',
      stage: 'authenticated',
      status: 'passed',
      checked_at: NOW,
      expires_at: '2026-10-29T12:00:00.000Z',
      source: 'run:run_1',
      version: null,
      detail: null,
    };
    const d = decideRoute(architect({ readiness: readiness([seen]) }));
    expect(d).toMatchObject({ model: 'claude-opus-5-5', selected_rank: 1 });
    expect(d.readiness[0]).toMatchObject({ dispatchable: true, reason: 'ready' });
  });
});
