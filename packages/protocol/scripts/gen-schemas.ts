/**
 * Writes the JSON Schemas generated from @friday/protocol into <repo>/schemas/.
 * Run: pnpm --filter @friday/protocol gen:schemas
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSchemas, serializeSchema } from '../src/json-schema.js';

const outDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../schemas');
const schemas = buildSchemas();

// Remove stale files so renamed schemas do not linger.
for (const sub of ['protocol', 'events', 'context', 'api'])
  rmSync(path.join(outDir, sub), { recursive: true, force: true });

for (const [rel, schema] of Object.entries(schemas)) {
  const file = path.join(outDir, rel);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeSchema(schema));
}
const count = readdirSync(outDir, { recursive: true }).filter((f) => String(f).endsWith('.json')).length;
console.log(`wrote ${Object.keys(schemas).length} schemas (${count} files) to ${outDir}`);
