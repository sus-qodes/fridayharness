/**
 * The recipient's read permission, one rule for every projection of code (ADR-0022 §3, review F02;
 * review 2026-10-22 R1): the packet compiler and the graph answers of ADR-0038 judge a path the
 * same way. Permission first: never gather what the recipient may not read.
 */
import { canonicalize, matchesAny, type PathContext, readKeptFromAgents, sensitiveClassOf } from '@friday/policy';
import type { TaskView } from '@friday/protocol';
import type { ContextPolicy } from './compile.js';

export interface ReadGrant {
  approval_id: string;
  target: string;
}

export interface ReadFilterInput {
  /** The checkout the paths are relative to, and the project's main checkout. */
  root: string;
  mainRoot: string;
  stateDir?: string | undefined;
  policy: ContextPolicy | null;
  task: TaskView | undefined;
  /** The recipient agent's role: its team scopes narrow reads (ADR-0028). */
  role: string | null | undefined;
  /** An agent, not a human: `deny.read` applies. */
  forAgents: boolean;
  /** Paths a human let this recipient read, for this attempt (review M7.1 R01); none for a graph answer. */
  grants: readonly ReadGrant[];
}

export interface ReadFilter {
  /** Whether the recipient may read this project-relative path (a link judged by its real target too). */
  readable: (p: string) => boolean;
  /** Paths readable only because a human granted them, with the grant: showing one spends it. */
  relied: Map<string, ReadGrant>;
  /** The case-folding the platform's paths need. */
  fold: (p: string) => string;
}

export function createReadFilter(i: ReadFilterInput): ReadFilter {
  const pathCtx: PathContext = {
    projectRoot: i.root,
    mainRoot: i.mainRoot,
    ...(i.stateDir ? { stateDir: i.stateDir } : {}),
  };
  const declaredRead = i.task?.scope?.read?.length ? [...i.task.scope.read, ...i.task.scope.write] : null;
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  const grantFor = new Map(i.grants.map((g) => [fold(g.target), g]));
  // The team scopes of the agent's role that name reads narrow what is gathered, as the task's own
  // read scope does (ADR-0028); `deny.read` is a permission, the same rule the hooks apply.
  const teamLayers = (i.role && i.policy?.teams[i.role]) || [];
  const allowedAs = (p: string, useGrants = true) => {
    const approved = (x: string) => useGrants && grantFor.has(fold(x));
    if (sensitiveClassOf(p, pathCtx, 'read')) return false;
    if (i.forAgents && i.policy && readKeptFromAgents(p, i.policy.deny.read, approved)) return false;
    if (approved(p)) return true;
    if (declaredRead && !matchesAny(p, declaredRead)) return false;
    for (const layer of teamLayers) {
      if (layer.read.length && !matchesAny(p, [...layer.read, ...layer.write])) return false;
    }
    return true;
  };
  const judged = new Map<string, boolean>();
  const relied = new Map<string, ReadGrant>();
  const readable = (p: string) => {
    let ok = judged.get(p);
    if (ok === undefined) {
      ok = allowedAs(p);
      const c = ok ? canonicalize(p, pathCtx) : null;
      const target = c?.linked ? c.realRelative : p;
      if (c?.linked) ok = target !== null && allowedAs(target);
      judged.set(p, ok);
      if (ok && grantFor.size && !(allowedAs(p, false) && (target === null || allowedAs(target, false)))) {
        const g = grantFor.get(fold(p)) ?? (target ? grantFor.get(fold(target)) : undefined);
        if (g) relied.set(fold(p), g);
      }
    }
    return ok;
  };
  return { readable, relied, fold };
}
