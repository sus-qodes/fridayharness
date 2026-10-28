import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { stateDir, writePrivateFile } from './discovery.js';

/**
 * Provider keys and other credentials (ADR-0008, ADR-0013): one file per secret in the per-user
 * state directory, readable only by the user, outside every repository. Shared by all projects.
 * Nothing here is ever printed, logged or put into an event.
 */

const NAME = /^[a-z][a-z0-9-]{0,31}$/;

export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'credentials');
}

function fileFor(name: string, env: NodeJS.ProcessEnv): string {
  if (!NAME.test(name)) {
    throw new FridayError('invalid_request', `secret names are lowercase words such as "anthropic" (got "${name}")`);
  }
  return path.join(credentialsDir(env), `${name}.key`);
}

export function writeSecret(name: string, value: string, env: NodeJS.ProcessEnv = process.env): string {
  fileFor(name, env);
  const v = value.trim();
  if (!v) throw new FridayError('invalid_request', 'the secret is empty');
  if (/\s/.test(v)) throw new FridayError('invalid_request', 'the secret contains whitespace; paste only the key');
  return writePrivateFile(credentialsDir(env), `${name}.key`, `${v}\n`);
}

export function readSecret(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  try {
    return readFileSync(fileFor(name, env), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Returns whether a secret was stored. */
export function removeSecret(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const file = fileFor(name, env);
  const had = existsSync(file);
  rmSync(file, { force: true });
  return had;
}

/** Names only. */
export function listSecrets(env: NodeJS.ProcessEnv = process.env): string[] {
  try {
    return readdirSync(credentialsDir(env))
      .filter((f) => f.endsWith('.key'))
      .map((f) => f.slice(0, -'.key'.length))
      .filter((n) => NAME.test(n))
      .sort();
  } catch {
    return [];
  }
}
