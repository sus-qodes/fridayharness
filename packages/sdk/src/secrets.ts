import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { stateDir, writePrivateFile } from './discovery.js';
import { dpapiAvailable, dpapiProtect, dpapiUnprotect } from './dpapi.js';

/**
 * Provider keys and the secrets operations use (ADR-0008, ADR-0013, ADR-0029 §2): one file per
 * secret in the per-user state directory, readable only by the user, outside every repository.
 * On Windows the value is encrypted with DPAPI for the current user; elsewhere, or when DPAPI is
 * unavailable, the user-only file holds it as is. Nothing here is ever printed, logged or put into
 * an event.
 */

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const DPAPI_PREFIX = 'friday-dpapi:1:';

export type SecretProtection = 'dpapi' | 'file';

export function credentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(stateDir(env), 'credentials');
}

function fileFor(name: string, env: NodeJS.ProcessEnv): string {
  if (!NAME.test(name)) {
    throw new FridayError('invalid_request', `secret names are lowercase words such as "anthropic" (got "${name}")`);
  }
  return path.join(credentialsDir(env), `${name}.key`);
}

function readStored(name: string, env: NodeJS.ProcessEnv): string | undefined {
  try {
    return readFileSync(fileFor(name, env), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Stores a secret for this user. `FRIDAY_SECRET_STORE=file` keeps the plain user-only file even on
 * Windows. Returns how it is protected, and why DPAPI was not used when it was wanted.
 */
export async function storeSecret(
  name: string,
  value: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ path: string; protection: SecretProtection; note?: string }> {
  fileFor(name, env);
  const v = value.trim();
  if (!v) throw new FridayError('invalid_request', 'the secret is empty');
  if (/\s/.test(v)) throw new FridayError('invalid_request', 'the secret contains whitespace; paste only the key');
  let note: string | undefined;
  if (dpapiAvailable() && env.FRIDAY_SECRET_STORE !== 'file') {
    try {
      const blob = await dpapiProtect(name, Buffer.from(v, 'utf8'), env);
      const file = writePrivateFile(credentialsDir(env), `${name}.key`, `${DPAPI_PREFIX}${blob.toString('base64')}\n`);
      return { path: file, protection: 'dpapi' };
    } catch (e) {
      note = `DPAPI was unavailable (${(e as Error).message}), so the key is kept in a file only this user can read`;
    }
  }
  const file = writePrivateFile(credentialsDir(env), `${name}.key`, `${v}\n`);
  return { path: file, protection: 'file', ...(note ? { note } : {}) };
}

/** The value of a stored secret, decrypted; undefined when none is stored or it cannot be read. */
export async function resolveSecret(name: string, env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const stored = readStored(name, env);
  if (!stored) return undefined;
  if (!stored.startsWith(DPAPI_PREFIX)) return stored;
  try {
    const plain = await dpapiUnprotect(name, Buffer.from(stored.slice(DPAPI_PREFIX.length), 'base64'), env);
    return plain.toString('utf8') || undefined;
  } catch {
    return undefined;
  }
}

/** Whether a secret is stored (its value is not read). */
export function hasSecret(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return readStored(name, env) !== undefined;
}

/** How a stored secret is protected; null when none is stored. */
export function secretProtection(name: string, env: NodeJS.ProcessEnv = process.env): SecretProtection | null {
  const stored = readStored(name, env);
  if (!stored) return null;
  return stored.startsWith(DPAPI_PREFIX) ? 'dpapi' : 'file';
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
