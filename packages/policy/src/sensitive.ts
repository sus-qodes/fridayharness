import { type CanonicalPath, canonicalize, isInside, matchesAny, type PathContext, realDirectory } from './paths.js';

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

/**
 * Text forms that point at Friday's private state from inside a command or glob. `Friday` must be
 * a whole path segment: `friday-worktrees`, where task worktrees live beside it, is not private (M5a).
 */
const PRIVATE_TEXT = [
  /appdata[\\/]+local[\\/]+friday(?=$|[\\/"'\s;&|)])/i,
  /%localappdata%[\\/]+friday(?=$|[\\/"'\s;&|)])/i,
  /\$env:localappdata[\\/"' +]+friday(?=$|[\\/"'\s;&|)])/i,
  /\.local[\\/]+state[\\/]+friday(?=$|[\\/"'\s;&|)])/i,
  /\bxdg_state_home\b[^\n]*?[\\/"' ]friday(?=$|[\\/"'\s;&|)])/i,
  /\b(?:operator|bootstrap)\.token\b/i,
  /\bfriday_state_dir\b/i,
];

export interface SensitiveHit {
  class: SensitiveClass;
  path: string;
}

/** One location (as given, or the real target behind links) against the protected classes. */
function classify(
  absolute: string,
  rel: string | null,
  op: 'read' | 'write',
  windows: boolean,
  stateDirs: string[],
): SensitiveHit | null {
  if (stateDirs.some((d) => isInside(absolute, d, windows))) return { class: 'friday.private', path: absolute };
  if (rel === null) {
    // Outside the project: only secrets are judged here; Claude Code itself prompts for outside reads.
    const base = absolute.replaceAll('\\', '/');
    return matchesAny(base, SECRETS, windows) ? { class: 'secrets', path: absolute } : null;
  }
  // A directory is protected when anything inside it is (`.friday/run` as well as `.friday/run/x`).
  const forms = rel === '.' ? [rel] : [rel, `${rel}/x`];
  const any = (globs: readonly string[]) => forms.some((f) => matchesAny(f, globs, windows));
  if (any(RUNTIME)) return { class: 'friday.runtime', path: rel };
  if (matchesAny(rel, SECRETS, windows)) return { class: 'secrets', path: rel };
  if (any(GIT_INTERNAL)) return { class: 'git.internal', path: rel };
  if (op === 'write' && any(HOST_CONFIG)) return { class: 'host.config', path: rel };
  return null;
}

/**
 * Classifies one path for a read (also search/list) or write. Both the path as given and its
 * real target are checked (plan B19), so a symlink or junction cannot reach protected files.
 */
export function sensitiveClassOf(p: string, ctx: PathContext, op: 'read' | 'write'): SensitiveHit | null {
  const windows = ctx.windows ?? process.platform === 'win32';
  if (PRIVATE_TEXT.some((re) => re.test(p))) return { class: 'friday.private', path: p };
  const c: CanonicalPath = canonicalize(p, ctx);
  const stateDirs = ctx.stateDir ? [...new Set([ctx.stateDir, realDirectory(ctx.stateDir, windows)])] : [];
  const given = classify(c.absolute, c.relative, op, windows, stateDirs);
  if (given) return given;
  if (c.linked) {
    const hit = classify(c.real, c.realRelative, op, windows, stateDirs);
    if (hit) return { class: hit.class, path: `${c.relative ?? c.absolute} (links to ${hit.path})` };
  }
  // A session in a task worktree: the main checkout's protected files stay protected (ADR-0023 §6).
  // The path was already resolved against the execution root; only its location is judged again.
  if (ctx.mainRoot && !isInside(ctx.mainRoot, ctx.projectRoot, windows)) {
    const m = canonicalize(c.absolute, { ...ctx, projectRoot: ctx.mainRoot });
    const inMain = classify(m.absolute, m.relative, op, windows, stateDirs);
    if (inMain) return { class: inMain.class, path: m.absolute };
    if (m.linked) {
      const real = classify(m.real, m.realRelative, op, windows, stateDirs);
      if (real) return { class: real.class, path: `${m.absolute} (links to ${real.path})` };
    }
  }
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
  if (ctx.stateDir) {
    // The state folder itself or anything inside it, not a sibling whose name starts the same way
    // (`…\Friday-notes`): the match must end where a path segment ends.
    const dir = ctx.stateDir.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    const lower = t.toLowerCase();
    for (let i = lower.indexOf(dir); i !== -1; i = lower.indexOf(dir, i + 1)) {
      const next = lower[i + dir.length];
      if (next === undefined || !/[\w.-]/.test(next)) return { class: 'friday.private', path: ctx.stateDir };
    }
  }
  return null;
}
