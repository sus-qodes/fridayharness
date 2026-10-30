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
    expect(text).toContain('Static role registry 2026-10-21.4');
    expect(text).toContain('backend_engineer —');
    expect(text).toContain('aliases: backend, backend-engineer');
    expect(text).toContain('claude-sonnet-5-5 via claude-code [dispatchable]');
    expect(text).toContain('claude-opus-5-5 via cursor [dispatchable]');
    expect(text).toContain('requires: MCP, auth, host verification, model verification, MCP verification');
    expect(text).toContain('checked 2026-10-21; cost Friday registry cost table (2026-10-21)@2026-10-21');
    expect(text).toContain('deepseek-flash via deepseek [unavailable: adapter_not_implemented]');
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
      version: '2026-10-21.4',
      roles: 7,
      candidates: 28,
      project_candidates: 0,
      artifact: 'matches',
    });
  });
});
