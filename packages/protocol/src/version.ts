import { FridayError } from './errors.js';

/** Harness protocol versions this build speaks, `major.minor` (spec Part 14 §13). */
export const PROTOCOL_VERSIONS = ['1.0'] as const;
export const CURRENT_PROTOCOL_VERSION = '1.0';
/** Version of the domain event envelope. */
export const EVENT_SCHEMA_VERSION = 1;
/** Version of the local REST API. */
export const API_VERSION = 'v1';

function parse(v: string): [number, number] {
  const m = /^(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new FridayError('unsupported_protocol_version', `invalid protocol version "${v}"`);
  return [Number(m[1]), Number(m[2])];
}

/**
 * Picks the version both sides speak. The major version must match; the result is the highest
 * supported minor not above the client's, or the lowest supported minor if the client is older.
 */
export function negotiateProtocolVersion(client: string, supported: readonly string[] = PROTOCOL_VERSIONS): string {
  const [cMajor, cMinor] = parse(client);
  const sameMajor = supported.map(parse).filter(([major]) => major === cMajor);
  if (sameMajor.length === 0) {
    throw new FridayError(
      'unsupported_protocol_version',
      `protocol ${client} is not supported; this daemon speaks ${supported.join(', ')}`,
      { supported },
    );
  }
  sameMajor.sort((a, b) => a[1] - b[1]);
  const notAbove = sameMajor.filter(([, minor]) => minor <= cMinor);
  const [major, minor] =
    notAbove.length > 0 ? (notAbove.at(-1) as [number, number]) : (sameMajor[0] as [number, number]);
  return `${major}.${minor}`;
}
