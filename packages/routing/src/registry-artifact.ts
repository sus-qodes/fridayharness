import { readFileSync } from 'node:fs';
import { generatedRegistryView } from './role-registry.js';

/** The committed, generated view shipped beside the typed source (see `registry:generate`). */
export const REGISTRY_ARTIFACT_URL = new URL('../friday_registry.json', import.meta.url);

export function committedRegistryView(): string {
  return readFileSync(REGISTRY_ARTIFACT_URL, 'utf8');
}

/** True when the committed view matches the typed source. A missing or hand-edited artifact is drift. */
export function registryArtifactMatches(): boolean {
  try {
    return committedRegistryView() === generatedRegistryView();
  } catch {
    return false;
  }
}
