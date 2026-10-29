import { type ProjectPolicy, projectPolicy } from '@friday/policy';
import { type ProjectRef, readPolicySources, readPolicyTrust, writePolicyTrust } from '@friday/sdk';

export { writePolicyTrust };

/** The project's effective policy (ADR-0028), with the policy files that could not be applied. */
export type EffectivePolicy = ProjectPolicy & { errors: { file: string; error: string }[] };

/** Reads config.yaml and `.friday/policies/`, and this clone's trust in what they loosen. */
export function loadEffectivePolicy(project: ProjectRef, privateDir: string): EffectivePolicy {
  const { sources, errors } = readPolicySources(project.root, project.config);
  return { ...projectPolicy(sources, readPolicyTrust(privateDir)), errors };
}
