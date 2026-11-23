import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { type ProjectPolicy, projectPolicy } from '@friday/policy';
import { POLICY_DIR, type ProjectRef, readPolicySources, readPolicyTrust, writePolicyTrust } from '@friday/sdk';

export { writePolicyTrust };

/** The project's effective policy (ADR-0028), with the policy files that could not be applied. */
export type EffectivePolicy = ProjectPolicy & { errors: { file: string; error: string }[] };

/** Reads config.yaml and `.friday/policies/`, and this clone's trust in what they loosen. It writes nothing. */
export function loadEffectivePolicy(project: ProjectRef, privateDir: string): EffectivePolicy {
  const { sources, errors } = readPolicySources(project.root, project.config);
  return { ...projectPolicy(sources, readPolicyTrust(privateDir)), errors };
}

/**
 * Brings the trust file in step with a policy that is in force (2026-11-18). Called for a policy
 * the daemon took, never for a read of files that may be half written:
 *  - a setting that is no longer in the files loses its trust, so that switched off and on again
 *    it is asked about again, as it was when one hash covered the whole list;
 *  - an old trust file that names only the whole list is given the ids of that list while it
 *    still matches, so that switching one setting off afterwards leaves the others trusted.
 * Returns whether the file was rewritten.
 */
export function settleTrust(privateDir: string, policy: Pick<ProjectPolicy, 'loosening' | 'loosening_hash'>): boolean {
  const trust = readPolicyTrust(privateDir);
  if (trust.hash === null && trust.items.length === 0) return false;
  const present = policy.loosening.map((l) => l.id);
  const whole = policy.loosening_hash !== null && policy.loosening_hash === trust.hash;
  const keep = whole ? present : trust.items.filter((i) => present.includes(i));
  const hash = whole ? trust.hash : null;
  const same = hash === trust.hash && keep.length === trust.items.length && keep.every((i) => trust.items.includes(i));
  if (same) return false;
  try {
    writePolicyTrust(privateDir, { hash, items: keep }, 'friday');
    return true;
  } catch {
    // What applies was decided from what the file held; it is brought in step at the next load.
    return false;
  }
}

/**
 * Trusts settings on this clone: the whole present list (`all`), or the ones named by id. Ids
 * that are not in the present list are refused by the caller; here they are simply not kept.
 */
export function trustSettings(
  project: ProjectRef,
  privateDir: string,
  what: { all: true } | { items: readonly string[] },
  trustedBy: string,
): void {
  const { sources } = readPolicySources(project.root, project.config);
  const trust = readPolicyTrust(privateDir);
  const policy = projectPolicy(sources, trust);
  const present = new Set(policy.loosening.map((l) => l.id));
  const already = policy.loosening.filter((l) => l.trusted).map((l) => l.id);
  const items = 'all' in what ? [...present] : [...already, ...what.items.filter((i) => present.has(i))];
  const all = items.length > 0 && [...present].every((i) => items.includes(i));
  writePolicyTrust(privateDir, { hash: all ? policy.loosening_hash : null, items }, trustedBy);
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
