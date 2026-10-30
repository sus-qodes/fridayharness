import { randomBytes } from 'node:crypto';
import { z } from 'zod';

/**
 * Opaque identifier prefixes (spec Part 14 §1, ADR-0002). Events use `evt_` (ERRATA G10).
 * Never expose database row ids; these strings are the public identity of every object.
 */
export const ID_PREFIXES = [
  'org',
  'proj',
  'team',
  'agent',
  'harness',
  'model',
  'goal',
  'plan',
  'task',
  'run',
  'evt',
  'msg',
  'out',
  'ctx',
  'mem',
  'graph',
  'res',
  'cap',
  'apr',
  'esc',
  'dec',
  'ver',
  'chk',
  'artifact',
  'route',
  'cred',
  'inst',
  'aud',
  // M2: model calls and delegation decisions.
  'call',
  'asg',
  // Stabilization: durable Master Brain jobs (operational).
  'job',
  // M3: one delivery of a message to one recipient; correlation ids.
  'dlv',
  'corr',
  // M3c: snapshots of the domain tables.
  'snap',
  // M5: task worktrees, integrations.
  'wt',
  'int',
  // M6c: runs of operations by the gateway.
  'op',
  // M7: routing pins and model outcomes (decisions use `route`).
  'pin',
  'oc',
  // R2: persisted task role-resolution decisions.
  'rdec',
] as const;
export type IdPrefix = (typeof ID_PREFIXES)[number];
export type Id<P extends IdPrefix = IdPrefix> = `${P}_${string}`;

/** Crockford base32, lower case (no i, l, o, u). */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
export const ID_SUFFIX_LENGTH = 26;
const SUFFIX = `[${ALPHABET}]{${ID_SUFFIX_LENGTH}}`;

/** Encodes 16 bytes (128 bits) as 26 Crockford base32 characters. */
export function encodeBase32(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('encodeBase32 expects 16 bytes');
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  const out: string[] = new Array(ID_SUFFIX_LENGTH);
  for (let i = ID_SUFFIX_LENGTH - 1; i >= 0; i -= 1) {
    out[i] = ALPHABET[Number(n & 31n)] as string;
    n >>= 5n;
  }
  return out.join('');
}

/** New random id with 128 bits of entropy. */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  return `${prefix}_${encodeBase32(randomBytes(16))}`;
}

export function isId<P extends IdPrefix>(value: unknown, prefix: P): value is Id<P> {
  return typeof value === 'string' && new RegExp(`^${prefix}_${SUFFIX}$`).test(value);
}

/** Zod schema for an id with a given prefix. */
export function idSchema<P extends IdPrefix>(prefix: P) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${SUFFIX}$`), `expected a ${prefix}_ id`)
    .transform((v) => v as Id<P>);
}

export type ProjectId = Id<'proj'>;
export type TaskId = Id<'task'>;
export type RunId = Id<'run'>;
export type EventId = Id<'evt'>;
export type HarnessId = Id<'harness'>;
export type AgentId = Id<'agent'>;
