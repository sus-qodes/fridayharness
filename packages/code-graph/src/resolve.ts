import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Resolution of module specifiers to files of the execution root (ADR-0020 §4). Every answer
 * says how sure it is; nothing is guessed.
 */

export type Certainty = 'exact' | 'inferred' | 'unsupported';

export type Resolution =
  | { type: 'file'; to: string; certainty: 'exact' | 'inferred'; reason?: string }
  | { type: 'unsupported'; reason: string }
  | { type: 'external'; module: string };

export interface WorkspacePackage {
  name: string;
  /** Root-relative folder of the package (`.` for the root). */
  dir: string;
  /** Root-relative entry file, when its declared entry is one of the root's files. */
  entry: string | null;
  /** Why there is no entry. */
  missing?: string;
}

const TS_MAPPING: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const ADDED = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const BUILTINS = new Set(builtinModules);
const CONDITIONS = ['development', 'import', 'types', 'default', 'require', 'node'];

const posix = path.posix;

export class Resolver {
  constructor(
    private readonly files: Set<string>,
    private readonly packages: WorkspacePackage[],
    private readonly aliases: string[],
  ) {}

  resolve(from: string, specifier: string | null): Resolution {
    if (specifier === null) return { type: 'unsupported', reason: 'computed specifier' };
    if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
      return this.relative(from, specifier);
    }
    if (specifier.startsWith('/') || /^[A-Za-z]:[\\/]/.test(specifier)) {
      return { type: 'unsupported', reason: 'absolute path' };
    }
    if (specifier.startsWith('node:') || BUILTINS.has(specifier) || BUILTINS.has(specifier.split('/')[0] as string)) {
      return { type: 'external', module: specifier.startsWith('node:') ? specifier : `node:${specifier}` };
    }
    if (specifier.startsWith('#')) return { type: 'unsupported', reason: 'package imports alias (#)' };
    for (const p of this.packages) {
      if (specifier === p.name) {
        return p.entry
          ? { type: 'file', to: p.entry, certainty: 'inferred', reason: `workspace package ${p.name}` }
          : { type: 'unsupported', reason: p.missing ?? `workspace package ${p.name} has no entry file` };
      }
      if (specifier.startsWith(`${p.name}/`))
        return { type: 'unsupported', reason: `subpath of workspace package ${p.name}` };
    }
    if (this.aliases.some((a) => (a.endsWith('*') ? specifier.startsWith(a.slice(0, -1)) : specifier === a))) {
      return { type: 'unsupported', reason: 'tsconfig path alias' };
    }
    return { type: 'external', module: packageName(specifier) };
  }

  private relative(from: string, specifier: string): Resolution {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base === '..' || base.startsWith('../')) return { type: 'unsupported', reason: 'outside the root' };
    const hit = firstFile(this.files, base);
    return hit ? { type: 'file', to: hit, certainty: 'exact' } : { type: 'unsupported', reason: `${base} not found` };
  }
}

/** The first file a path names, by the rules of ADR-0020 §4, in order. */
export function firstFile(files: Set<string>, base: string): string | null {
  const candidates = [base];
  const ext = posix.extname(base);
  for (const mapped of TS_MAPPING[ext] ?? []) candidates.push(base.slice(0, -ext.length) + mapped);
  for (const add of ADDED) candidates.push(base + add);
  for (const add of ADDED) candidates.push(`${base}/index${add}`);
  return candidates.find((c) => files.has(c)) ?? null;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

/** The first string a package's `exports["."]` resolves to under the preferred conditions. */
function pickExport(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    for (const v of value) {
      const hit = pickExport(v);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    for (const c of CONDITIONS) {
      if (c in obj) {
        const hit = pickExport(obj[c]);
        if (hit) return hit;
      }
    }
  }
  return null;
}

/** Workspace packages of the root: every `package.json` among its files that has a name. */
export async function readWorkspacePackages(root: string, files: Set<string>): Promise<WorkspacePackage[]> {
  const out: WorkspacePackage[] = [];
  for (const f of files) {
    if (posix.basename(f) !== 'package.json') continue;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(await readFile(path.join(root, f), 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof json.name !== 'string') continue;
    const dir = posix.dirname(f);
    const exportsField = json.exports;
    let declared: string | null = null;
    if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
      const obj = exportsField as Record<string, unknown>;
      declared =
        '.' in obj ? pickExport(obj['.']) : Object.keys(obj).some((k) => k.startsWith('.')) ? null : pickExport(obj);
    } else if (exportsField !== undefined) {
      declared = pickExport(exportsField);
    }
    declared ??= [json.types, json.module, json.main].find((v): v is string => typeof v === 'string') ?? null;
    const pkg: WorkspacePackage = { name: json.name, dir, entry: null };
    if (!declared) {
      pkg.missing = `workspace package ${json.name} declares no entry`;
    } else {
      const target = posix.normalize(posix.join(dir === '.' ? '' : dir, declared));
      const hit = firstFile(files, target);
      if (hit) pkg.entry = hit;
      else pkg.missing = `the entry of ${json.name} (${declared}) is not among the root's files (a build output?)`;
    }
    out.push(pkg);
  }
  // Longer names first, so `@a/b-c` is tried before `@a/b`.
  return out.sort((a, b) => b.name.length - a.name.length);
}

/** `compilerOptions.paths` keys of the root's tsconfig.json (JSON with comments). */
export async function readAliases(root: string): Promise<string[]> {
  let text: string;
  try {
    text = await readFile(path.join(root, 'tsconfig.json'), 'utf8');
  } catch {
    return [];
  }
  try {
    const json = JSON.parse(stripJsonComments(text)) as { compilerOptions?: { paths?: Record<string, unknown> } };
    return Object.keys(json.compilerOptions?.paths ?? {});
  } catch {
    return [];
  }
}

/** Removes comments and trailing commas outside strings. */
export function stripJsonComments(text: string): string {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    const next = text[i + 1];
    if (inString) {
      out += c;
      if (c === '\\') {
        out += next ?? '';
        i++;
      } else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}
