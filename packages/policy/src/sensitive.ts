import { type CanonicalPath, canonicalize, isInside, matchesAny, type PathContext } from './paths.js';

/** Paths no agent tool may touch (plan M1.8, docs/security/model.md §6). */
export type SensitiveClass = 'friday.private' | 'friday.runtime' | 'host.config' | 'secrets' | 'git.internal';

const RUNTIME = [
  '.friday/run/**',
  '.friday/project.db',
  '.friday/project.db-*',
  '.friday/logs/**',
  '.friday/cache/**',
  '.friday/sessions/**',
];
/** Writable only by humans and `friday harness config`; reading is fine. */
const HOST_CONFIG = [
  '.claude/**',
  '.mcp.json',
  '.cursor/**',
  '.codex/**',
  '.friday/harness/**',
  '.friday/config.yaml',
  '.friday/policies/**',
  '.friday/.gitignore',
];
const SECRETS = ['**/.env', '**/.env.*', '**/*.pem', '**/id_rsa', '**/id_rsa.*', '**/id_ed25519', '**/id_ed25519.*'];
const GIT_INTERNAL = ['.git/**'];

/** Text forms that point at Friday's private state from inside a command or glob. */
const PRIVATE_TEXT = [
  /appdata[\\/]+local[\\/]+friday\b/i,
  /%localappdata%[\\/]+friday\b/i,
  /\$env:localappdata[\\/"' +]+friday\b/i,
  /\.local[\\/]+state[\\/]+friday\b/i,
  /\bxdg_state_home\b.*friday/i,
  /\b(?:operator|bootstrap)\.token\b/i,
  /\bfriday_state_dir\b/i,
];

export interface SensitiveHit {
  class: SensitiveClass;
  path: string;
}

/** Classifies one path for a read (also search/list) or write. */
export function sensitiveClassOf(p: string, ctx: PathContext, op: 'read' | 'write'): SensitiveHit | null {
  const windows = ctx.windows ?? process.platform === 'win32';
  if (PRIVATE_TEXT.some((re) => re.test(p))) return { class: 'friday.private', path: p };
  const c: CanonicalPath = canonicalize(p, ctx);
  if (ctx.stateDir && isInside(c.absolute, ctx.stateDir, windows)) return { class: 'friday.private', path: c.absolute };
  const rel = c.relative;
  if (rel === null) {
    // Outside the project: only secrets are judged here; Claude Code itself prompts for outside reads.
    const base = c.absolute.replaceAll('\\', '/');
    return matchesAny(base, SECRETS, windows) ? { class: 'secrets', path: c.absolute } : null;
  }
  if (matchesAny(rel, RUNTIME, windows)) return { class: 'friday.runtime', path: rel };
  if (matchesAny(rel, SECRETS, windows)) return { class: 'secrets', path: rel };
  if (matchesAny(rel, GIT_INTERNAL, windows)) return { class: 'git.internal', path: rel };
  if (op === 'write' && matchesAny(rel, HOST_CONFIG, windows)) return { class: 'host.config', path: rel };
  return null;
}

/** Glob and Grep: a pattern is sensitive when it explicitly names a protected area. */
export function sensitivePattern(pattern: string, ctx: PathContext): SensitiveHit | null {
  if (PRIVATE_TEXT.some((re) => re.test(pattern))) return { class: 'friday.private', path: pattern };
  const norm = pattern.replaceAll('\\', '/').replace(/^\.\//, '');
  const head = norm.split(/[*?[{]/)[0] ?? '';
  for (const [cls, globs] of [
    ['friday.runtime', RUNTIME],
    ['secrets', SECRETS],
    ['git.internal', GIT_INTERNAL],
  ] as const) {
    if (head && matchesAny(head.replace(/\/$/, '/x'), globs, ctx.windows ?? process.platform === 'win32')) {
      return { class: cls, path: pattern };
    }
  }
  if (
    /(^|\/)\.env(\.|$|\*)/.test(norm) ||
    /\.pem$/.test(norm) ||
    /(^|\/)\.friday\/(run|logs|cache|sessions)\b/.test(norm)
  ) {
    return { class: norm.includes('.friday') ? 'friday.runtime' : 'secrets', path: pattern };
  }
  if (/(^|\/)project\.db/.test(norm)) return { class: 'friday.runtime', path: pattern };
  return null;
}

/** Scans free text (shell commands) for references to protected paths. */
export function sensitiveInText(text: string, ctx: PathContext): SensitiveHit | null {
  if (PRIVATE_TEXT.some((re) => re.test(text))) return { class: 'friday.private', path: '(private state)' };
  const t = text.replaceAll('\\', '/');
  if (/\.friday\/(run|logs|cache|sessions)\b/i.test(t) || /\bproject\.db\b/i.test(t)) {
    return { class: 'friday.runtime', path: '.friday runtime files' };
  }
  if (/(^|[\s"'=/(])\.env(\.[\w.-]+)?($|[\s"');|&])/i.test(t) || /\bid_(rsa|ed25519)\b/.test(t) || /\.pem\b/i.test(t)) {
    return { class: 'secrets', path: 'secret file' };
  }
  if (ctx.stateDir && t.toLowerCase().includes(ctx.stateDir.replaceAll('\\', '/').toLowerCase())) {
    return { class: 'friday.private', path: ctx.stateDir };
  }
  return null;
}
