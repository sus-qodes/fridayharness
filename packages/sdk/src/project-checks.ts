/**
 * The project's checks, set from the interface (2026-11-17).
 *
 * Verification ran only Friday's own checks (scope, credentials, evidence) until someone wrote
 * `verification.checks` into config.yaml by hand, from an example in a dialog: a person who never
 * opens that file had work "verified" that no test had run on. Two things here:
 *
 * - `suggestChecks`: the checks a project most likely wants, read from the scripts of its
 *   package.json (tests, lint, type check, build), run through the package manager its lockfile
 *   names. Read, never run; a suggestion is a command a person sees before they add it.
 * - `editChecksText`: config.yaml with checks added to, or removed from, `verification.checks`.
 *   The file is a person's, and tracked, so as little of it changes as can be: new items become new
 *   lines where the list stands, a removed one loses its own lines, and every comment and every
 *   other line stay. A layout the small edit does not handle is written whole through the YAML
 *   library. Either way the result is read back: it must be a configuration Friday reads, whose
 *   checks are the old ones with exactly this change, and whose every other value is the same.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { FridayError } from '@friday/protocol';
import { isMap, isScalar, isSeq, parseDocument, parse as parseYaml } from 'yaml';
import { parseConfig } from './config.js';

export type SuggestedKind = 'test' | 'lint' | 'typecheck' | 'build';

export interface SuggestedCheck {
  /** The name it takes under `verification.checks`. */
  name: string;
  kind: SuggestedKind;
  command: string;
  args: string[];
  /** The package.json script it runs, and what that script is (shown to the person, never run here). */
  script: string;
  runs: string;
}

/** The scripts looked for, per kind: the first one a project has is the suggestion. */
const WANTED: readonly { kind: SuggestedKind; name: string; scripts: readonly string[] }[] = [
  { kind: 'test', name: 'tests', scripts: ['test', 'test:unit', 'test:ci', 'tests'] },
  { kind: 'lint', name: 'lint', scripts: ['lint', 'lint:check', 'check:lint'] },
  { kind: 'typecheck', name: 'typecheck', scripts: ['typecheck', 'type-check', 'check-types', 'types', 'tsc'] },
  { kind: 'build', name: 'build', scripts: ['build'] },
];

/** The lockfiles that name a package manager, the most specific first. */
const LOCKFILES: readonly (readonly [string, string])[] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
  ['npm-shrinkwrap.json', 'npm'],
];
const MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];

/** A script that is no check: npm's placeholder, or one that never ends (a watcher, a dev server). */
function unusable(script: string): boolean {
  const s = script.trim();
  if (!s) return true;
  if (/no test specified/i.test(s)) return true;
  return /(^|\s)(--watch|--watchAll|-w)(\s|=|$)/.test(s);
}

/** The package manager a project uses: its lockfile's, else the one package.json names, else npm. */
export function packageManagerOf(root: string, pkg?: { packageManager?: unknown }): string {
  for (const [file, manager] of LOCKFILES) if (existsSync(path.join(root, file))) return manager;
  const named = typeof pkg?.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  return named && MANAGERS.includes(named) ? named : 'npm';
}

/**
 * The checks a project most likely wants, from its package.json; empty when it has none, it cannot
 * be read, or its scripts hold nothing of the kind.
 */
export function suggestChecks(root: string): SuggestedCheck[] {
  const file = path.join(root, 'package.json');
  if (!existsSync(file)) return [];
  let pkg: { scripts?: unknown; packageManager?: unknown };
  try {
    pkg = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as typeof pkg;
  } catch {
    return [];
  }
  const scripts = pkg && typeof pkg.scripts === 'object' && pkg.scripts !== null ? pkg.scripts : {};
  const manager = packageManagerOf(root, pkg);
  const out: SuggestedCheck[] = [];
  for (const w of WANTED) {
    const script = w.scripts.find((s) => {
      const v = (scripts as Record<string, unknown>)[s];
      return typeof v === 'string' && !unusable(v);
    });
    if (!script) continue;
    out.push({
      name: w.name,
      kind: w.kind,
      command: manager,
      // `run <script>` for every manager: `bun test` is bun's own runner, not the project's script.
      args: ['run', script],
      script,
      runs: String((scripts as Record<string, unknown>)[script]).slice(0, 300),
    });
  }
  return out;
}

/** A check as the interface adds it: the fields a suggestion has, nothing a page could slip in. */
export interface CheckToAdd {
  name: string;
  kind: SuggestedKind | 'other';
  command: string;
  args: string[];
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.:-]{0,59}$/;

/** A scalar as config.yaml writes it: a plain word as it is, anything else quoted as JSON (valid YAML). */
function scalar(value: string): string {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value) && !/^(?:true|false|null|yes|no|on|off)$/i.test(value)
    ? value
    : JSON.stringify(value);
}

/** The lines of one check as a block item, its dash at `indent`. */
function itemLines(c: CheckToAdd, indent: string): string[] {
  return [
    `${indent}- name: ${scalar(c.name)}`,
    `${indent}  kind: ${c.kind}`,
    `${indent}  command: ${scalar(c.command)}`,
    `${indent}  args: [${c.args.map((a) => JSON.stringify(a)).join(', ')}]`,
  ];
}

/** What stands before an offset on its line. */
function lineBefore(text: string, offset: number): string {
  return text.slice(text.lastIndexOf('\n', offset - 1) + 1, offset);
}

/** The offset just past the line an offset is on (past its newline), or the text's end. */
function lineEndAfter(text: string, offset: number): number {
  const nl = text.indexOf('\n', offset);
  return nl === -1 ? text.length : nl + 1;
}

/** A value with its keys in order, as text: two configurations are the same when these are. */
function canonical(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === 'object'
        ? Object.fromEntries(
            Object.keys(x as Record<string, unknown>)
              .sort()
              .map((k) => [k, sort((x as Record<string, unknown>)[k])]),
          )
        : x;
  return JSON.stringify(sort(v));
}

type Raw = Record<string, unknown>;

function rawChecks(root: Raw): unknown[] {
  const v = root.verification;
  const checks = v && typeof v === 'object' && !Array.isArray(v) ? (v as Raw).checks : undefined;
  return Array.isArray(checks) ? checks : [];
}

const nameOf = (c: unknown): string =>
  c && typeof c === 'object' && typeof (c as Raw).name === 'string' ? ((c as Raw).name as string) : '';

/** The small edit: null when the file is laid out in a way it does not handle. */
function patchChecks(text: string, add: readonly CheckToAdd[], remove: readonly string[]): string | null {
  let out = text;
  for (const name of remove) {
    const doc = parseDocument(out);
    if (doc.errors.length) return null;
    const seq = doc.getIn(['verification', 'checks'], true);
    if (!isSeq(seq) || seq.flow) return null;
    const at = seq.items.findIndex((item) => isMap(item) && item.get('name') === name);
    if (at === -1) continue;
    const item = seq.items[at] as { range?: [number, number, number] | null };
    if (!item.range) return null;
    const dashLine = out.lastIndexOf('\n', item.range[0] - 1) + 1;
    // Only an item whose dash starts its line, with nothing but the dash before its first key.
    if (!/^ *- +$/.test(out.slice(dashLine, item.range[0]))) return null;
    if (seq.items.length === 1) {
      // The last one: the list is written empty where its key stands.
      const holder = doc.getIn(['verification'], true);
      if (!isMap(holder) || holder.flow) return null;
      const pair = holder.items.find((p) => isScalar(p.key) && p.key.value === 'checks');
      const key = pair?.key as { range?: [number, number, number] | null } | undefined;
      if (!key?.range) return null;
      const keyLineEnd = out.indexOf('\n', key.range[1]);
      if (keyLineEnd === -1 || !/^:[ \t]*$/.test(out.slice(key.range[1], keyLineEnd))) return null;
      const end = lineEndAfter(out, Math.max(item.range[0], item.range[1] - 1));
      out = `${out.slice(0, key.range[1])}: []\n${out.slice(end)}`;
      continue;
    }
    const next = seq.items[at + 1] as { range?: [number, number, number] | null } | undefined;
    // Up to the next item's dash line, or, for the last item, the end of its own last line.
    const end = next?.range
      ? out.lastIndexOf('\n', next.range[0] - 1) + 1
      : lineEndAfter(out, Math.max(item.range[0], item.range[1] - 1));
    out = `${out.slice(0, dashLine)}${out.slice(end)}`;
  }
  if (!add.length) return out;
  const doc = parseDocument(out);
  if (doc.errors.length) return null;
  const holder = doc.getIn(['verification'], true);
  if (!isMap(holder) || holder.flow) return null;
  const pair = holder.items.find((p) => isScalar(p.key) && p.key.value === 'checks');
  const key = pair?.key as { range?: [number, number, number] | null } | undefined;
  const seq = pair?.value;
  if (!pair || !key?.range) {
    // No `checks` under `verification`: new lines after the section's last line.
    if (!holder.items.length || !holder.range) return null;
    const first = holder.items[0]?.key as { range?: [number, number, number] | null } | null | undefined;
    if (!first?.range) return null;
    const indent = lineBefore(out, first.range[0]);
    if (!/^ *$/.test(indent)) return null;
    const lastLineEnd = out.indexOf('\n', Math.max(0, holder.range[1] - 1));
    const head = lastLineEnd === -1 ? out : out.slice(0, lastLineEnd);
    const tail = lastLineEnd === -1 ? '\n' : out.slice(lastLineEnd);
    const lines = [`${indent}checks:`, ...add.flatMap((c) => itemLines(c, `${indent}  `))];
    return `${head}\n${lines.join('\n')}${tail}`;
  }
  const keyIndent = lineBefore(out, key.range[0]);
  if (!/^ *$/.test(keyIndent)) return null;
  if (isSeq(seq) && !seq.flow && seq.items.length && seq.range) {
    // A block list: the new items after its last line, their dashes under the ones there.
    const first = seq.items[0] as { range?: [number, number, number] | null };
    if (!first.range) return null;
    const dashLine = out.lastIndexOf('\n', first.range[0] - 1) + 1;
    const lead = out.slice(dashLine, first.range[0]);
    if (!/^ *- +$/.test(lead)) return null;
    const indent = lead.slice(0, lead.indexOf('-'));
    const last = seq.items.at(-1) as { range?: [number, number, number] | null };
    if (!last.range) return null;
    const end = lineEndAfter(out, Math.max(last.range[0], last.range[1] - 1));
    const lines = add.flatMap((c) => itemLines(c, indent)).join('\n');
    const head = out.slice(0, end);
    return `${head}${head.endsWith('\n') ? '' : '\n'}${lines}\n${out.slice(end)}`;
  }
  // An empty list (`checks: []`, or `checks:` with nothing under it): its own line is rewritten.
  const empty = (isSeq(seq) && seq.items.length === 0) || (isScalar(seq) && seq.value === null);
  if (!empty) return null;
  const lineEnd = out.indexOf('\n', key.range[1]);
  const rest = out.slice(key.range[1], lineEnd === -1 ? out.length : lineEnd);
  if (!/^:[ \t]*(\[[ \t]*\])?[ \t]*(#.*)?$/.test(rest)) return null;
  const comment = rest.match(/#.*$/)?.[0];
  const lines = add.flatMap((c) => itemLines(c, `${keyIndent}  `)).join('\n');
  const after = lineEnd === -1 ? '\n' : out.slice(lineEnd);
  return `${out.slice(0, key.range[1])}:${comment ? ` ${comment}` : ''}\n${lines}${after}`;
}

/**
 * `text` (a config.yaml) with these checks added and those removed, by name. A check whose name is
 * already there is not added again; a name that is not there is not an error. Refused when a check
 * is not one the interface adds, or the result is not a valid configuration.
 */
export function editChecksText(
  text: string,
  change: { add?: readonly CheckToAdd[]; remove?: readonly string[] },
  source = 'config.yaml',
): { text: string; added: string[]; removed: string[] } {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const raw = bom ? text.slice(1) : text;
  const newlines = raw.match(/\r\n|\n/g) ?? [];
  const crlf = newlines.length > 0 && newlines.filter((n) => n === '\r\n').length * 2 >= newlines.length;
  const lf = raw.replace(/\r\n/g, '\n');
  let before: Raw;
  try {
    before = (parseYaml(lf) ?? {}) as Raw;
  } catch (e) {
    throw new FridayError('invalid_request', `${source} is not valid YAML: ${(e as Error).message}`);
  }
  if (typeof before !== 'object' || before === null || Array.isArray(before)) {
    throw new FridayError('invalid_request', `${source} is not a list of settings; correct the file by hand`);
  }
  for (const c of change.add ?? []) {
    if (!NAME.test(c.name)) throw new FridayError('invalid_request', `"${c.name}" is not a name a check can have`);
    if (!MANAGERS.includes(c.command)) {
      throw new FridayError(
        'invalid_request',
        `a check added here runs through npm, pnpm, yarn or bun, not "${c.command}"`,
      );
    }
    if (c.args.length > 8 || c.args.some((a) => typeof a !== 'string' || !a || a.length > 120 || /[\r\n\0]/.test(a))) {
      throw new FridayError('invalid_request', `the arguments of "${c.name}" are not ones a check added here can have`);
    }
  }
  const have = rawChecks(before);
  const names = new Set(have.map(nameOf));
  const remove = [...new Set(change.remove ?? [])].filter((n) => names.has(n));
  const gone = new Set(remove);
  const add: CheckToAdd[] = [];
  for (const c of change.add ?? []) {
    if ((names.has(c.name) && !gone.has(c.name)) || add.some((a) => a.name === c.name)) continue;
    add.push({ name: c.name, kind: c.kind, command: c.command, args: [...c.args] });
  }
  if (!add.length && !remove.length) return { text, added: [], removed: [] };

  // What the file must read as afterwards: the old values, with exactly this change to the list.
  const wantChecks = [...have.filter((c) => !gone.has(nameOf(c))), ...add.map((c) => ({ ...c }))];
  const goal = canonical({
    ...before,
    verification: {
      ...(before.verification && typeof before.verification === 'object' ? (before.verification as Raw) : {}),
      checks: wantChecks,
    },
  });
  const reads = (candidate: string): boolean => {
    try {
      const got = (parseYaml(candidate) ?? {}) as Raw;
      const v = got.verification && typeof got.verification === 'object' ? (got.verification as Raw) : {};
      return canonical({ ...got, verification: { ...v, checks: rawChecks(got) } }) === goal;
    } catch {
      return false;
    }
  };

  let out = patchChecks(lf, add, remove);
  if (out !== null && !reads(out)) out = null;
  if (out === null) {
    // The whole document, through the YAML library: comments are kept, their spacing is its own.
    const doc = parseDocument(lf);
    if (doc.errors.length) {
      throw new FridayError(
        'invalid_request',
        `${source} is not valid YAML: ${doc.errors[0]?.message ?? 'unreadable'}`,
      );
    }
    try {
      const section = doc.getIn(['verification'], true);
      if (section !== undefined && !isMap(section) && !(isScalar(section) && section.value === null)) {
        throw new FridayError(
          'invalid_request',
          `${source}: verification is not a section of settings, so its checks cannot be changed; correct the file by hand`,
        );
      }
      const node = doc.createNode(wantChecks);
      doc.setIn(['verification', 'checks'], node);
      out = doc.toString({ lineWidth: 0 });
    } catch (e) {
      if (e instanceof FridayError) throw e;
      throw new FridayError(
        'invalid_request',
        `${source} could not be changed (${(e as Error).message}); correct the file by hand`,
      );
    }
    if (!reads(out)) {
      throw new FridayError(
        'invalid_request',
        `${source} could not be changed without altering other settings; correct the file by hand`,
      );
    }
  }
  // It must still be a configuration Friday reads (a name twice, a kind it does not know).
  parseConfig(out, source);
  const result = crlf ? out.replace(/\n/g, '\r\n') : out;
  return { text: `${bom}${result}`, added: add.map((c) => c.name), removed: remove };
}
