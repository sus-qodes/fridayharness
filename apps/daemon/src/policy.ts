import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { type ProjectPolicy, projectPolicy } from '@friday/policy';
import { POLICY_DIR, type ProjectRef, readPolicySources, readPolicyTrust, writePolicyTrust } from '@friday/sdk';

export { writePolicyTrust };

/** The project's effective policy (ADR-0028), with the policy files that could not be applied. */
export type EffectivePolicy = ProjectPolicy & { errors: { file: string; error: string }[] };

/** Reads config.yaml and `.friday/policies/`, and this clone's trust in what they loosen. */
export function loadEffectivePolicy(project: ProjectRef, privateDir: string): EffectivePolicy {
  const { sources, errors } = readPolicySources(project.root, project.config);
  return { ...projectPolicy(sources, readPolicyTrust(privateDir)), errors };
}

/** The policy files as they are now (names, sizes, modification times): a change calls for a reload. */
export function policyFilesState(projectRoot: string): string {
  const dir = path.join(projectRoot, POLICY_DIR);
  try {
    return readdirSync(dir)
      .filter((n) => /\.ya?ml$/i.test(n))
      .sort()
      .map((n) => {
        const s = statSync(path.join(dir, n));
        return `${n}:${s.size}:${s.mtimeMs}`;
      })
      .join('|');
  } catch {
    return '';
  }
}

/**
 * The project's policy, read again whenever its policy files change (LESSONS D-43): what a file
 * tightens applies at the next judgment, as ADR-0028 §2 promises, without a restart or a reload.
 * `config.yaml` is read at start only.
 *
 * A file caught half written must not drop its rules for a moment: a load that cannot read more
 * files than the policy in force waits until the files have stood still for `settleMs`, then
 * applies, with the files it could not read reported as for any load.
 */
export function reloadingPolicy(o: {
  projectRoot: string;
  initial: EffectivePolicy;
  load: () => EffectivePolicy;
  onLoad: (p: EffectivePolicy, why: 'files changed' | 'requested') => void;
  now?: () => number;
  settleMs?: number;
}): { current: () => EffectivePolicy; reload: () => EffectivePolicy } {
  const now = o.now ?? Date.now;
  const settleMs = o.settleMs ?? 1000;
  let policy = o.initial;
  let seen = policyFilesState(o.projectRoot);
  let changed: { files: string; since: number } | null = null;
  const take = (next: EffectivePolicy, files: string, why: 'files changed' | 'requested') => {
    policy = next;
    seen = files;
    changed = null;
    o.onLoad(next, why);
    return next;
  };
  return {
    current: () => {
      const files = policyFilesState(o.projectRoot);
      if (files === seen) return policy;
      if (changed?.files !== files) changed = { files, since: now() };
      const next = o.load();
      if (next.errors.length > policy.errors.length && now() - changed.since < settleMs) return policy;
      return take(next, files, 'files changed');
    },
    reload: () => take(o.load(), policyFilesState(o.projectRoot), 'requested'),
  };
}
