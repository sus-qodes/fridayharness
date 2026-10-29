import { Redactor } from '@friday/events';

/**
 * Output of a run that used credentials (ADR-0029 §5): every value is removed, as written and in
 * the encodings code commonly prints (base64 at any alignment, base64url, hex, URL and JSON
 * escaping), then credentials in well-known formats. Code that wants to leak a value in some other
 * form still can: this keeps accidents and the obvious out of the agent's context, it is not a
 * guarantee against code written to exfiltrate.
 */

/** Shorter values cannot be removed without mangling ordinary output: the gateway refuses them. */
export const MIN_SECRET_LENGTH = 8;

/** The base64 characters of `bytes` that do not depend on what comes before or after them. */
function base64Cores(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const b = Buffer.concat([Buffer.alloc(k), bytes]);
    const enc = b.toString('base64').replace(/=+$/, '');
    const start = Math.ceil((k * 8) / 6);
    const end = Math.floor((b.length * 8) / 6);
    const core = enc.slice(start, end);
    if (core.length >= MIN_SECRET_LENGTH) out.push(core);
  }
  return out;
}

/** Every form of a value the sanitizer removes, longest first. */
export function secretVariants(value: string): string[] {
  const bytes = Buffer.from(value, 'utf8');
  const cores = base64Cores(bytes);
  const forms = new Set<string>([
    value,
    bytes.toString('base64'),
    bytes.toString('base64url'),
    ...cores,
    ...cores.map((c) => c.replaceAll('+', '-').replaceAll('/', '_')),
    encodeURIComponent(value),
    JSON.stringify(value).slice(1, -1),
  ]);
  return [...forms].filter((f) => f.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const formats = new Redactor();

export function sanitizeOutput(
  text: string,
  secrets: readonly { name: string; value: string }[],
): { text: string; redactions: number } {
  let out = text;
  let redactions = 0;
  for (const s of secrets) {
    const marker = `[REDACTED:${s.name}]`;
    for (const form of secretVariants(s.value)) {
      const parts = out.split(form);
      if (parts.length > 1) {
        redactions += parts.length - 1;
        out = parts.join(marker);
      }
    }
    // Hex in either case.
    const hex = new RegExp(escapeRegExp(Buffer.from(s.value, 'utf8').toString('hex')), 'gi');
    out = out.replace(hex, () => {
      redactions += 1;
      return marker;
    });
  }
  const known = formats.redactString(out);
  if (known.redacted) redactions += 1;
  return { text: known.value, redactions };
}
