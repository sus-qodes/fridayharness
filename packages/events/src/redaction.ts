/**
 * Secret redaction applied to every event payload before it is stored (plan E.4, spec Part 05 §13).
 * The event log must never hold a usable credential, even if an agent echoes one.
 */
interface Pattern {
  kind: string;
  re: RegExp;
  /** Replacement; `$1` keeps a prefix captured by the pattern. */
  replace: string;
}

const PATTERNS: Pattern[] = [
  {
    kind: 'private_key',
    re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:private_key]',
  },
  { kind: 'anthropic_key', re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:anthropic_key]' },
  { kind: 'openai_key', re: /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, replace: '[REDACTED:openai_key]' },
  { kind: 'aws_key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replace: '[REDACTED:aws_key]' },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, replace: '[REDACTED:github_token]' },
  { kind: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replace: '[REDACTED:github_token]' },
  { kind: 'slack_token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, replace: '[REDACTED:slack_token]' },
  {
    kind: 'jwt',
    re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: '[REDACTED:jwt]',
  },
  { kind: 'bearer', re: /(\bBearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, replace: '$1[REDACTED:bearer]' },
  {
    kind: 'assignment',
    re: /(\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|token)\b\s*[=:]\s*["']?)[^\s"'&,;]{4,}/gi,
    replace: '$1[REDACTED:assignment]',
  },
  { kind: 'url_credentials', re: /(:\/\/[^\s:@/]+:)[^\s@/]+@/g, replace: '$1[REDACTED]@' },
];

/** Object keys whose values are always secret. */
const SECRET_KEYS =
  /^(?:password|passwd|secret|token|api[_-]?key|authorization|cookie|private[_-]?key|client[_-]?secret|harness_token)$/i;

export class Redactor {
  readonly #exact = new Set<string>();

  /** Registers a literal secret (for example the daemon's own tokens) to always mask. */
  addSecret(secret: string): void {
    if (secret.length >= 8) this.#exact.add(secret);
  }

  removeSecret(secret: string): void {
    this.#exact.delete(secret);
  }

  redactString(input: string): { value: string; redacted: boolean } {
    let value = input;
    for (const secret of this.#exact) {
      if (value.includes(secret)) value = value.split(secret).join('[REDACTED:friday_token]');
    }
    for (const p of PATTERNS) value = value.replace(p.re, p.replace);
    return { value, redacted: value !== input };
  }

  /** Deep-copies `value`, masking secrets in strings and under secret-looking keys. */
  redact<T>(value: T): { value: T; redacted: boolean } {
    let redacted = false;
    const walk = (v: unknown, key?: string): unknown => {
      if (typeof v === 'string') {
        if (key && SECRET_KEYS.test(key) && v.length > 0) {
          redacted = true;
          return '[REDACTED:field]';
        }
        const r = this.redactString(v);
        if (r.redacted) redacted = true;
        return r.value;
      }
      if (Array.isArray(v)) return v.map((x) => walk(x));
      if (v && typeof v === 'object') {
        return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x, k)]));
      }
      return v;
    };
    return { value: walk(value) as T, redacted };
  }
}

/** Truncates text for non-authoritative event fields, leaving a visible marker. */
export function truncateText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const dropped = text.length - maxChars;
  return `${text.slice(0, maxChars)}…[truncated ${dropped} chars]`;
}
