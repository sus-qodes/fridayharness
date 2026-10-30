import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import path from 'node:path';

/**
 * Resolution of module specifiers to files of the execution root (ADR-0020 §4 and its 2026-10-20
 * amendment). Every answer says how sure it is; nothing is guessed: what the project's own
 * configuration declares (package `exports`, tsconfig `paths`, a build's `outDir`/`rootDir`) is
 * followed, and everything else is reported as unsupported with its reason.
 */

export type Certainty = 'exact' | 'inferred' | 'unsupported';

export type Resolution =
  | { type: 'file'; to: string; certainty: 'exact' | 'inferred'; reason?: string }
  | { type: 'unsupported'; reason: string }
  | { type: 'external'; module: string };

/** One key of a package's `exports` map, with the target picked under Friday's conditions. */
export interface ExportEntry {
  /** `.`, `./sub` or a pattern with one `*` (`./modules/*`). */
  subpath: string;
  /** The package-relative target, or null when the key is blocked (`null`) or none of the conditions matched. */
  target: string | null;
}

/** Where a package's TypeScript build writes, as its own tsconfig declares it. */
export interface BuildLayout {
  /** Root-relative path of the tsconfig that declares `outDir`. */
  config: string;
  /** Root-relative folder of the sources (`rootDir`). */
  rootDir: string;
  /** Root-relative folder of the outputs (`outDir`). */
  outDir: string;
}

export interface WorkspacePackage {
  name: string;
  /** Root-relative folder of the package (`.` for the root). */
  dir: string;
  /** Root-relative entry file, when `.` resolves to one of the root's files. */
  entry: string | null;
  /** Why there is no entry. */
  missing?: string;
  /** The `exports` map; null when the package has none (every file of its folder is then reachable). */
  exports: ExportEntry[] | null;
  /** The entry `types`/`module`/`main` declares, used only without an `exports` map. */
  legacyEntry: string | null;
  /** The declared build layout, when `<dir>/tsconfig.build.json` or `<dir>/tsconfig.json` declares `outDir` and `rootDir`. */
  build: BuildLayout | null;
  /** Why outputs are not mapped to sources, when they are not. */
  buildNote?: string;
}

/** The `compilerOptions.paths` of one tsconfig, with the folder its targets are relative to. */
export interface PathAliases {
  /** Root-relative path of the tsconfig.json. */
  config: string;
  /** Root-relative folder whose files this config governs (`.` for the root). */
  dir: string;
  /** Root-relative folder the targets are joined to: `baseUrl`, else the folder of the config declaring `paths`. */
  base: string;
  paths: { pattern: string; targets: string[] }[];
}

const TS_MAPPING: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};
const ADDED = ['.ts', '.tsx', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json'];
const BUILTINS = new Set(builtinModules);
export const CONDITIONS = ['development', 'import', 'types', 'default', 'require', 'node'];
const BUILD_CONFIGS = ['tsconfig.build.json', 'tsconfig.json'];

const posix = path.posix;

export class Resolver {
  private readonly aliases: PathAliases[];

  constructor(
    private readonly files: Set<string>,
    private readonly packages: WorkspacePackage[],
    aliases: PathAliases[],
  ) {
    // The nearest tsconfig governs a file: deeper folders first.
    this.aliases = [...aliases].sort((a, b) => b.dir.length - a.dir.length);
  }

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
    // tsconfig `paths` come first, as they do for TypeScript.
    const aliased = this.alias(from, specifier);
    if (aliased) return aliased;
    for (const p of this.packages) {
      if (specifier === p.name) return this.fromPackage(p, '.');
      if (specifier.startsWith(`${p.name}/`)) return this.fromPackage(p, `./${specifier.slice(p.name.length + 1)}`);
    }
    return { type: 'external', module: packageName(specifier) };
  }

  private relative(from: string, specifier: string): Resolution {
    const base = posix.normalize(posix.join(posix.dirname(from), specifier));
    if (base === '..' || base.startsWith('../')) return { type: 'unsupported', reason: 'outside the root' };
    const hit = firstFile(this.files, base);
    return hit ? { type: 'file', to: hit, certainty: 'exact' } : { type: 'unsupported', reason: `${base} not found` };
  }

  /** The nearest tsconfig's `paths`, by TypeScript's rules: an exact key, else the pattern with the longest prefix. */
  private alias(from: string, specifier: string): Resolution | null {
    const config = this.aliases.find((a) => a.dir === '.' || from.startsWith(`${a.dir}/`));
    if (!config) return null;
    const match = matchPattern(
      config.paths.map((p) => p.pattern),
      specifier,
    );
    if (!match) return null;
    const entry = config.paths.find((p) => p.pattern === match.pattern) as PathAliases['paths'][number];
    const mapped = entry.targets.map((t) => posix.normalize(posix.join(config.base, t.replaceAll('*', match.star))));
    for (const m of mapped) {
      const hit = firstFile(this.files, m);
      if (hit) {
        return {
          type: 'file',
          to: hit,
          certainty: 'inferred',
          reason: `tsconfig path ${match.pattern} (${config.config})`,
        };
      }
    }
    return {
      type: 'unsupported',
      reason: `tsconfig path ${match.pattern} of ${config.config} maps ${specifier} to ${mapped.join(' or ')}, not among the root's files`,
    };
  }

  private fromPackage(p: WorkspacePackage, subpath: string): Resolution {
    const named = subpath === '.' ? `workspace package ${p.name}` : `export ${subpath} of workspace package ${p.name}`;
    if (p.exports === null) {
      if (subpath === '.') {
        if (!p.legacyEntry) return { type: 'unsupported', reason: `workspace package ${p.name} declares no entry` };
        return this.target(p, p.legacyEntry, named, 'the entry');
      }
      // Without an exports map, every file of the package's folder is reachable.
      const file = posix.normalize(posix.join(p.dir, subpath));
      const hit = firstFile(this.files, file);
      return hit
        ? {
            type: 'file',
            to: hit,
            certainty: 'inferred',
            reason: `file of workspace package ${p.name} (no exports map)`,
          }
        : { type: 'unsupported', reason: `${file} not found in workspace package ${p.name}` };
    }
    const match = matchPattern(
      p.exports.map((e) => e.subpath),
      subpath,
    );
    if (!match)
      return { type: 'unsupported', reason: `subpath ${subpath} is not exported by workspace package ${p.name}` };
    const entry = p.exports.find((e) => e.subpath === match.pattern) as ExportEntry;
    if (entry.target === null) {
      return {
        type: 'unsupported',
        reason: `export ${match.pattern} of workspace package ${p.name} has no target under the conditions Friday reads (${CONDITIONS.join(', ')})`,
      };
    }
    const declared = entry.target.replaceAll('*', match.star);
    return this.target(p, declared, named, subpath === '.' ? 'the entry' : `the target of export ${subpath}`);
  }

  /** The file a declared, package-relative target names: as written, or the source its declared build writes it from. */
  private target(p: WorkspacePackage, declared: string, named: string, what: string): Resolution {
    const file = posix.normalize(posix.join(p.dir === '.' ? '' : p.dir, declared));
    const outside = p.dir === '.' ? file === '..' || file.startsWith('../') : !file.startsWith(`${p.dir}/`);
    if (outside)
      return { type: 'unsupported', reason: `${what} of ${p.name} (${declared}) points outside the package` };
    const hit = firstFile(this.files, file);
    if (hit) return { type: 'file', to: hit, certainty: 'inferred', reason: named };
    const source = sourceOfOutput(p.build, file);
    if (source) {
      const built = firstFile(this.files, source);
      if (built) {
        return {
          type: 'file',
          to: built,
          certainty: 'inferred',
          reason: `${named} (its build output, mapped to the source by ${(p.build as BuildLayout).config})`,
        };
      }
      return {
        type: 'unsupported',
        reason: `${what} of ${p.name} (${declared}) maps to ${source} by ${(p.build as BuildLayout).config}, not among the root's files`,
      };
    }
    const note = p.buildNote ? `; ${p.buildNote}` : '';
    return {
      type: 'unsupported',
      reason: `${what} of ${p.name} (${declared}) is not among the root's files (a build output?)${note}`,
    };
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

/**
 * Matches a subpath or specifier against keys that are exact or hold one `*`: an exact key wins,
 * then the pattern with the longest prefix (Node's and TypeScript's rule).
 */
export function matchPattern(keys: string[], value: string): { pattern: string; star: string } | null {
  if (keys.includes(value)) return { pattern: value, star: '' };
  let best: { pattern: string; star: string; prefix: number } | null = null;
  for (const key of keys) {
    const at = key.indexOf('*');
    if (at === -1 || key.indexOf('*', at + 1) !== -1) continue;
    const prefix = key.slice(0, at);
    const suffix = key.slice(at + 1);
    if (value.length <= prefix.length + suffix.length || !value.startsWith(prefix) || !value.endsWith(suffix)) continue;
    if (!best || prefix.length > best.prefix) {
      best = { pattern: key, star: value.slice(prefix.length, value.length - suffix.length), prefix: prefix.length };
    }
  }
  return best ? { pattern: best.pattern, star: best.star } : null;
}

/**
 * The source a build output was written from, when the package declares its layout: `<outDir>/x.d.ts`
 * and `<outDir>/x.js` come from `<rootDir>/x` (extension by {@link firstFile}). Null when the file is
 * not under the declared `outDir`, or no layout is declared.
 */
export function sourceOfOutput(build: BuildLayout | null, file: string): string | null {
  if (!build) return null;
  const prefix = build.outDir === '.' ? '' : `${build.outDir}/`;
  if (!file.startsWith(prefix)) return null;
  let rest = file.slice(prefix.length);
  const declaration = /\.d\.(ts|mts|cts)$/.exec(rest);
  if (declaration) rest = rest.slice(0, -declaration[0].length) + (declaration[1] === 'ts' ? '' : `.${declaration[1]}`);
  return posix.normalize(posix.join(build.rootDir, rest));
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] as string);
}

/** The first string an exports value resolves to under the preferred conditions. */
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

/** The `exports` field as entries; null when the package has none. */
export function readExports(exportsField: unknown): ExportEntry[] | null {
  if (exportsField === undefined) return null;
  if (exportsField && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    const obj = exportsField as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.some((k) => k.startsWith('.'))) {
      return keys.filter((k) => k.startsWith('.')).map((k) => ({ subpath: k, target: pickExport(obj[k]) }));
    }
  }
  return [{ subpath: '.', target: pickExport(exportsField) }];
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
    const layout = await readBuildLayout(root, files, dir);
    const pkg: WorkspacePackage = {
      name: json.name,
      dir,
      entry: null,
      exports: readExports(json.exports),
      legacyEntry: [json.types, json.module, json.main].find((v): v is string => typeof v === 'string') ?? null,
      build: layout.build,
      ...(layout.note ? { buildNote: layout.note } : {}),
    };
    const entry = new Resolver(files, [pkg], []).resolve('package.json', pkg.name);
    if (entry.type === 'file') pkg.entry = entry.to;
    else if (entry.type === 'unsupported') pkg.missing = entry.reason;
    out.push(pkg);
  }
  // Longer names first, so `@a/b-c` is tried before `@a/b`.
  return out.sort((a, b) => b.name.length - a.name.length);
}

/** The build layout a package's own tsconfig declares (`tsconfig.build.json`, then `tsconfig.json`). */
async function readBuildLayout(
  root: string,
  files: Set<string>,
  dir: string,
): Promise<{ build: BuildLayout | null; note?: string }> {
  const seen: string[] = [];
  for (const name of BUILD_CONFIGS) {
    const config = dir === '.' ? name : `${dir}/${name}`;
    if (!files.has(config)) continue;
    seen.push(config);
    const options = await loadCompilerOptions(root, files, config);
    if (!options.outDir) continue;
    if (!options.rootDir) {
      return {
        build: null,
        note: `${config} declares outDir but no rootDir, so its outputs are not mapped to sources`,
      };
    }
    return {
      build: {
        config,
        rootDir: posix.normalize(posix.join(options.rootDir.configDir, options.rootDir.value)),
        outDir: posix.normalize(posix.join(options.outDir.configDir, options.outDir.value)),
      },
    };
  }
  return {
    build: null,
    note: seen.length
      ? `${seen.join(' and ')} declare${seen.length === 1 ? 's' : ''} no outDir, so build outputs are not mapped to sources`
      : `${dir === '.' ? '' : `${dir}/`}tsconfig.json is not among the root's files, so build outputs are not mapped to sources`,
  };
}

interface Located {
  value: string;
  /** Root-relative folder of the tsconfig that declared the value (paths are relative to it). */
  configDir: string;
}

interface CompilerOptions {
  outDir?: Located;
  rootDir?: Located;
  baseUrl?: Located;
  paths?: { value: Record<string, unknown>; configDir: string };
}

/**
 * The compiler options of a tsconfig with its relative `extends` chain applied (the child wins).
 * An `extends` that names a package is not followed: only files of the root are read.
 */
async function loadCompilerOptions(
  root: string,
  files: Set<string>,
  config: string,
  seen = new Set<string>(),
): Promise<CompilerOptions> {
  if (seen.has(config) || !files.has(config)) return {};
  seen.add(config);
  let json: { extends?: unknown; compilerOptions?: Record<string, unknown> };
  try {
    json = JSON.parse(stripJsonComments(await readFile(path.join(root, config), 'utf8'))) as typeof json;
  } catch {
    return {};
  }
  const configDir = posix.dirname(config);
  let merged: CompilerOptions = {};
  const parents = Array.isArray(json.extends) ? json.extends : json.extends !== undefined ? [json.extends] : [];
  for (const parent of parents) {
    if (typeof parent !== 'string' || !(parent.startsWith('./') || parent.startsWith('../'))) continue;
    let target = posix.normalize(posix.join(configDir, parent));
    if (!files.has(target) && files.has(`${target}.json`)) target = `${target}.json`;
    merged = { ...merged, ...(await loadCompilerOptions(root, files, target, seen)) };
  }
  const own = json.compilerOptions ?? {};
  for (const key of ['outDir', 'rootDir', 'baseUrl'] as const) {
    if (typeof own[key] === 'string') merged[key] = { value: own[key] as string, configDir };
  }
  if (own.paths && typeof own.paths === 'object' && !Array.isArray(own.paths)) {
    merged.paths = { value: own.paths as Record<string, unknown>, configDir };
  }
  return merged;
}

/** The `compilerOptions.paths` of every `tsconfig.json` among the root's files, with relative `extends` applied. */
export async function readTsconfigPaths(root: string, files: Set<string>): Promise<PathAliases[]> {
  const out: PathAliases[] = [];
  for (const f of files) {
    if (posix.basename(f) !== 'tsconfig.json') continue;
    const options = await loadCompilerOptions(root, files, f);
    if (!options.paths) continue;
    const paths = Object.entries(options.paths.value)
      .filter(
        (entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((t) => typeof t === 'string'),
      )
      .map(([pattern, targets]) => ({ pattern, targets }));
    if (paths.length === 0) continue;
    const base = options.baseUrl
      ? posix.normalize(posix.join(options.baseUrl.configDir, options.baseUrl.value))
      : options.paths.configDir;
    out.push({ config: f, dir: posix.dirname(f), base, paths });
  }
  return out.sort((a, b) => b.dir.length - a.dir.length);
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
