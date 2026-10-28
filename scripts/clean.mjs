#!/usr/bin/env node
/** Removes build output and caches from every workspace package (cross-platform `rm -rf`). */
import { existsSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const parents = ['apps', 'packages', 'packages/adapters', 'tests'];
const targets = ['dist', '.turbo', 'coverage'];

const dirs = [root, path.join(root, 'tests', 'support')];
for (const parent of parents) {
  const abs = path.join(root, parent);
  if (!existsSync(abs)) continue;
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.isDirectory()) dirs.push(path.join(abs, entry.name));
  }
}

let removed = 0;
for (const dir of dirs) {
  for (const t of targets) {
    const p = path.join(dir, t);
    if (existsSync(p)) {
      await rm(p, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
      removed += 1;
    }
  }
}
for (const p of [path.join(root, 'tests', '.artifacts'), path.join(root, 'tests', '.reports')]) {
  if (existsSync(p)) {
    await rm(p, { recursive: true, force: true });
    removed += 1;
  }
}
console.log(`clean: removed ${removed} director${removed === 1 ? 'y' : 'ies'}`);
