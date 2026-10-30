/**
 * Regenerate (or check) the committed view of the typed role registry. The TypeScript source is the
 * authority; `friday_registry.json` is a build artifact for hosts and people who do not run TS.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REGISTRY_ARTIFACT_URL } from '../src/registry-artifact.js';
import { generatedRegistryView } from '../src/role-registry.js';

const target = fileURLToPath(REGISTRY_ARTIFACT_URL);
const generated = generatedRegistryView();
const check = process.argv.includes('--check');

if (check) {
  let current: string;
  try {
    current = readFileSync(target, 'utf8');
  } catch {
    console.error('friday_registry.json is missing; run "pnpm --filter @friday/routing registry:generate"');
    process.exitCode = 1;
    process.exit();
  }
  if (current !== generated) {
    console.error('friday_registry.json is stale; run "pnpm --filter @friday/routing registry:generate"');
    process.exitCode = 1;
  } else {
    console.log('friday_registry.json matches the typed role registry');
  }
} else {
  writeFileSync(target, generated);
  console.log(`wrote ${target}`);
}
