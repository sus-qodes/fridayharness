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

/**
 * Credential formats that are almost never anything else, used to scan code (ADR-0024 §3). The
 * looser patterns (`token = …`, bearer headers, URL passwords, JWT samples) match ordinary code and
 * test fixtures, so they only redact.
 */
const CREDENTIAL_KINDS = new Set([
  'private_key',
  'anthropic_key',
  'openai_key',
  'aws_key',
  'github_token',
  'github_pat',
  'slack_token',
]);

/** Each credential in a well-known format in `text`: its kind and 1-based line, never its value. */
export function findCredentials(text: string): { kind: string; line: number }[] {
  const found = new Map<number, string>();
  for (const p of PATTERNS) {
    if (!CREDENTIAL_KINDS.has(p.kind)) continue;
    for (const m of text.matchAll(p.re)) {
      const line = text.slice(0, m.index).split('\n').length;
      // An Anthropic key also matches the OpenAI pattern: the first, more specific kind wins.
      if (!found.has(line)) found.set(line, p.kind);
    }
  }
  return [...found].sort((a, b) => a[0] - b[0]).map(([line, kind]) => ({ kind, line }));
}

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
