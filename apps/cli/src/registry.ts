import {
  canonicalRole,
  loadGuide,
  type ModelRecord,
  type ModelRecordInput,
  mergeModels,
  type ProjectRoleCandidate,
  ROLE_REGISTRY_SOURCE,
  type RoleRegistry,
  type RoleRegistryCandidate,
  registryArtifactMatches,
  validateRoleRegistry,
  withProjectRoleCandidates,
} from '@friday/routing';
import type { ProjectRef } from '@friday/sdk';
import type { Command } from 'commander';
import { type GlobalOptions, out, project, UsageError } from './context.js';

/** The static role registry, including a project's `routing.role_candidates` extensions. */
export interface RegistryView {
  project: ProjectRef;
  registry: RoleRegistry;
  models: ModelRecord[];
  project_candidates: number;
}

export function registryViewForProject(ref: ProjectRef): RegistryView {
  const routing = ref.config.routing;
  const models = mergeModels(loadGuide().models, routing.models as ModelRecordInput[], ref.config.master_brain);
  return {
    project: ref,
    registry: withProjectRoleCandidates(
      ROLE_REGISTRY_SOURCE,
      routing.role_candidates as Readonly<Record<string, readonly ProjectRoleCandidate[]>>,
    ),
    models,
    project_candidates: Object.values(routing.role_candidates).reduce(
      (total, candidates) => total + candidates.length,
      0,
    ),
  };
}

function candidateState(candidate: RoleRegistryCandidate): string {
  return candidate.declared_dispatchable
    ? 'dispatchable'
    : `unavailable: ${candidate.reason_if_unavailable ?? 'no reason'}`;
}

function requirementText(candidate: RoleRegistryCandidate): string {
  const required = [
    candidate.requirements.mcp_required ? 'MCP' : null,
    candidate.requirements.auth_required ? 'auth' : null,
    candidate.requirements.host_verified ? 'host verification' : null,
    candidate.requirements.model_verified ? 'model verification' : null,
    candidate.requirements.mcp_verified ? 'MCP verification' : null,
  ].filter((value): value is string => value !== null);
  return required.length ? required.join(', ') : 'nothing beyond a known model and harness';
}

function provenanceText(candidate: RoleRegistryCandidate): string {
  const facts = [`checked ${candidate.last_checked ?? 'never'}`];
  if (candidate.cost) facts.push(`cost ${candidate.cost.source}@${candidate.cost.observed_at}`);
  if (candidate.benchmark) {
    facts.push(
      `benchmark ${candidate.benchmark.metric}=${candidate.benchmark.value} ${candidate.benchmark.source}@${candidate.benchmark.measured_at} (${candidate.benchmark.samples})`,
    );
  }
  return facts.join('; ');
}

function selectedRegistry(registry: RoleRegistry, onlyRole: string | undefined): RoleRegistry {
  if (!onlyRole) return registry;
  const canonical = canonicalRole(onlyRole, registry);
  if (!canonical)
    throw new UsageError(`unknown role "${onlyRole}"; run "friday registry show" for the roles Friday knows`);
  const definition = registry.roles[canonical];
  if (!definition) throw new UsageError(`unknown role "${onlyRole}"`);
  const aliases = Object.fromEntries(Object.entries(registry.aliases).filter(([, target]) => target === canonical));
  return { ...registry, roles: { [canonical]: definition }, aliases };
}

/** A readable view of the static contract: what each candidate declares, never what is live now. */
export function formatRoleRegistry(registry: RoleRegistry, onlyRole?: string): string {
  const selected = selectedRegistry(registry, onlyRole);
  const roleNames = Object.keys(selected.roles);
  const candidates = Object.values(selected.roles).reduce((total, role) => total + role.candidates.length, 0);
  const lines = [
    `Static role registry ${selected.version}: ${roleNames.length} role${roleNames.length === 1 ? '' : 's'}, ${candidates} candidate${candidates === 1 ? '' : 's'}`,
  ];
  if (!onlyRole && Object.keys(selected.aliases).length) {
    lines.push(
      `Aliases: ${Object.entries(selected.aliases)
        .map(([alias, target]) => `${alias} -> ${target}`)
        .join(', ')}`,
    );
  }
  lines.push(
    'Requirements are declarations checked at dispatch time; they do not claim a host, model or MCP server is available now.',
  );
  for (const [role, definition] of Object.entries(selected.roles)) {
    lines.push('', `${role} — ${definition.description}`);
    for (const candidate of definition.candidates) {
      lines.push(`  ${candidate.rank}. ${candidate.model} via ${candidate.harness} [${candidateState(candidate)}]`);
      lines.push(`     requires: ${requirementText(candidate)}`);
      lines.push(`     ${provenanceText(candidate)}`);
    }
    const aliases = Object.entries(selected.aliases)
      .filter(([, target]) => target === role)
      .map(([alias]) => alias);
    if (aliases.length) lines.push(`  aliases: ${aliases.join(', ')}`);
  }
  return lines.join('\n');
}

export interface RegistryValidation {
  ok: true;
  version: string;
  roles: number;
  candidates: number;
  project_candidates: number;
  artifact: 'matches';
}

export function validateRegistryView(view: RegistryView): RegistryValidation {
  validateRoleRegistry(view.registry, view.models);
  if (!registryArtifactMatches()) {
    throw new Error('friday_registry.json is missing or stale; run "pnpm --filter @friday/routing registry:generate"');
  }
  return {
    ok: true,
    version: view.registry.version,
    roles: Object.keys(view.registry.roles).length,
    candidates: Object.values(view.registry.roles).reduce((total, role) => total + role.candidates.length, 0),
    project_candidates: view.project_candidates,
    artifact: 'matches',
  };
}

export function registerRegistryCommands(program: Command, g: () => GlobalOptions): void {
  const registry = program
    .command('registry')
    .description('the static role/model contract: canonical roles, aliases, candidates and requirements');

  registry
    .command('show [role]')
    .description('show every role or one role/alias, with candidate requirements and provenance')
    .action((onlyRole?: string) => {
      const view = registryViewForProject(project(g()));
      const selected = selectedRegistry(view.registry, onlyRole);
      out(g(), { ...selected, project_candidates: view.project_candidates }, () =>
        formatRoleRegistry(view.registry, onlyRole),
      );
    });

  registry
    .command('validate')
    .description("validate Friday's registry, this project's candidates and the generated JSON")
    .action(() => {
      const view = registryViewForProject(project(g()));
      const result = validateRegistryView(view);
      out(
        g(),
        result,
        () =>
          `Registry ${result.version} is valid: ${result.roles} roles, ${result.candidates} candidates` +
          `${result.project_candidates ? ` (${result.project_candidates} from this project)` : ''}; ` +
          'friday_registry.json matches the typed source.',
      );
    });
}
