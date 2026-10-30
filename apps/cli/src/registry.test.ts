import { loadModelCatalog, ROLE_REGISTRY_SOURCE } from '@friday/routing';
import { describe, expect, it } from 'vitest';
import { formatRoleRegistry, type RegistryView, validateRegistryView } from './registry.js';

const view = {
  project: {},
  registry: ROLE_REGISTRY_SOURCE,
  models: loadModelCatalog().models,
  project_candidates: 0,
} as unknown as RegistryView;

describe('friday registry', () => {
  it('shows canonical roles, aliases and candidate requirements without claiming availability', () => {
    const text = formatRoleRegistry(ROLE_REGISTRY_SOURCE);
    expect(text).toContain('Static role registry 2026-10-21.3');
    expect(text).toContain('backend_engineer —');
    expect(text).toContain('aliases: backend, backend-engineer');
    expect(text).toContain('claude-opus-5-5 via claude-code [dispatchable]');
    expect(text).toContain('requires: MCP, auth, host verification, model verification, MCP verification');
    expect(text).toContain('checked 2026-10-21; cost model-guide.yaml@2026-10-20');
    expect(text).toContain('future-implementation-model via future-harness [unavailable: adapter_not_verified]');
    expect(text).toContain('Requirements are declarations checked at dispatch time');
  });

  it('filters by a canonical role or alias', () => {
    const text = formatRoleRegistry(ROLE_REGISTRY_SOURCE, 'backend');
    expect(text).toContain('backend_engineer —');
    expect(text).not.toContain('frontend_engineer —');
    expect(text).toContain('aliases: backend, backend-engineer');
    expect(() => formatRoleRegistry(ROLE_REGISTRY_SOURCE, 'designer')).toThrow(/unknown role/);
  });

  it('validates the typed registry, its project extension and the generated artifact', () => {
    expect(validateRegistryView(view)).toEqual({
      ok: true,
      version: '2026-10-21.3',
      roles: 11,
      candidates: 31,
      project_candidates: 0,
      artifact: 'matches',
    });
  });
});
