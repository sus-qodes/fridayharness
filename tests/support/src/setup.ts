/**
 * Vitest setup file loaded by every Friday test project (see vitest.shared.ts).
 */
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 18)) {
  throw new Error(`Friday tests need Node >= 22.18; this is ${process.versions.node}`);
}

// Tests must never read or write the developer's real per-user private directory (ADR-0008).
if (!process.env.FRIDAY_STATE_DIR) {
  const dir = path.join(process.env.FRIDAY_TEST_TMP ?? os.tmpdir(), `fri-state-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  process.env.FRIDAY_STATE_DIR = dir;
}
