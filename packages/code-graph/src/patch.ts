/**
 * Symbolic patching (ADR-0039): one declaration replaced by name, with its boundary taken from a
 * fresh parse of the file, never from the cached symbol rows. Pure functions over source text; the
 * daemon judges the write, reads and writes the file, and records the change.
 */
import { type LanguageSpec, type TsNode, withTree } from './languages.js';

export type PatchKind =
  | 'function'
  | 'class'
  | 'method'
  | 'field'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'namespace';

/** A declaration as a fresh parse finds it: its exact character range in the file. */
export interface Declaration {
  name: string;
  kind: PatchKind;
  /** The class, interface or namespace it belongs to, and which of those it is. */
  parent: string | null;
  parent_kind: 'class' | 'interface' | 'namespace' | null;
  line: number;
  end_line: number;
  /** Character offsets of the declaration node in the source (the `export` prefix excluded). */
  start: number;
  end: number;
  exported: 'none' | 'export' | 'export default';
  /** For a variable statement: how many variables it declares (one is patchable). */
  declarators: number;
  /** A variable whose value is a function (an arrow function, a function expression). */
  function_value: boolean;
}

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);
const TOP_LEVEL = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'lexical_declaration',
  'variable_declaration',
  'internal_module',
]);
const MEMBERS = new Set([
  'method_definition',
  'abstract_method_signature',
  'method_signature',
  'public_field_definition',
  'property_signature',
]);

function nameOf(node: TsNode): string | null {
  const field = node.childForFieldName('name');
  if (field) return field.text;
  const first = node.namedChildren.find(
    (c) => c && (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier'),
  );
  return first?.text ?? null;
}

const kindOf = (type: string): PatchKind | null => {
  switch (type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      return 'function';
    case 'class_declaration':
    case 'abstract_class_declaration':
      return 'class';
    case 'interface_declaration':
      return 'interface';
    case 'type_alias_declaration':
      return 'type';
    case 'enum_declaration':
      return 'enum';
    case 'lexical_declaration':
    case 'variable_declaration':
      return 'variable';
    case 'internal_module':
      return 'namespace';
    case 'method_definition':
    case 'abstract_method_signature':
    case 'method_signature':
      return 'method';
    case 'public_field_definition':
    case 'property_signature':
      return 'field';
    default:
      return null;
  }
};

/** The `ERROR` and missing nodes of a tree: what tree-sitter could not read. */
export function countErrors(root: TsNode): number {
  let n = 0;
  const walk = (node: TsNode): void => {
    if (node.type === 'ERROR' || node.isMissing === true) n++;
    for (const c of node.children) if (c) walk(c);
  };
  walk(root);
  return n;
}

/** Every patchable declaration of a tree, in source order, with its exact range. */
export function collectDeclarations(root: TsNode): Declaration[] {
  const out: Declaration[] = [];
  const add = (
    node: TsNode,
    kind: PatchKind,
    name: string,
    parent: { name: string; kind: 'class' | 'interface' | 'namespace' } | null,
    exported: Declaration['exported'],
    extra: Partial<Declaration> = {},
  ) =>
    out.push({
      name,
      kind,
      parent: parent?.name ?? null,
      parent_kind: parent?.kind ?? null,
      line: node.startPosition.row + 1,
      end_line: node.endPosition.row + 1,
      start: node.startIndex,
      end: node.endIndex,
      exported,
      declarators: 1,
      function_value: false,
      ...extra,
    });

  type Parent = { name: string; kind: 'class' | 'interface' | 'namespace' } | null;
  const members = (node: TsNode, parent: { name: string; kind: 'class' | 'interface' }): void => {
    const body = node.childForFieldName('body');
    for (const m of body?.namedChildren ?? []) {
      if (!m || !MEMBERS.has(m.type)) continue;
      const memberName = m.childForFieldName('name')?.text;
      if (!memberName) continue;
      add(m, kindOf(m.type) as PatchKind, memberName, parent, 'none');
    }
  };

  const declare = (node: TsNode, exported: Declaration['exported'], parent: Parent): void => {
    const kind = kindOf(node.type);
    if (!kind) return;
    if (kind === 'variable') {
      const declarators = node.namedChildren.filter((c): c is TsNode => c?.type === 'variable_declarator');
      for (const d of declarators) {
        const nameNode = d.childForFieldName('name');
        if (nameNode?.type !== 'identifier') continue;
        const value = d.childForFieldName('value');
        add(node, 'variable', nameNode.text, parent, exported, {
          declarators: declarators.length,
          function_value: Boolean(value && FUNCTION_VALUES.has(value.type)),
        });
      }
      return;
    }
    const name = nameOf(node);
    if (!name) return;
    add(node, kind, name, parent, exported);
    if (kind === 'class') members(node, { name, kind: 'class' });
    else if (kind === 'interface') members(node, { name, kind: 'interface' });
    else if (kind === 'namespace') {
      const body = node.childForFieldName('body');
      for (const s of body?.namedChildren ?? []) if (s) statement(s, { name, kind: 'namespace' });
    }
  };

  const statement = (node: TsNode, parent: Parent): void => {
    if (TOP_LEVEL.has(node.type)) {
      declare(node, 'none', parent);
      return;
    }
    if (node.type === 'expression_statement') {
      const inner = node.namedChildren[0];
      if (inner?.type === 'internal_module') declare(inner, 'none', parent);
      return;
    }
    if (node.type === 'export_statement') {
      const decl = node.childForFieldName('declaration') ?? node.namedChildren.find((c) => c && TOP_LEVEL.has(c.type));
      if (decl) declare(decl, /^export\s+default\b/.test(node.text) ? 'export default' : 'export', parent);
    }
  };

  for (const s of root.namedChildren) if (s) statement(s, null);
  return out;
}

export interface Want {
  /** `name`, or `Parent.member` for a class member or a namespace's declaration. */
  symbol: string;
  kind?: PatchKind;
  /** The line the agent read in a graph answer; when given, the declaration must start there. */
  line?: number;
}

export type Located = { ok: true; found: Declaration } | { ok: false; reason: string; candidates: Declaration[] };

const describe = (d: Declaration) =>
  `${d.parent ? `${d.parent}.` : ''}${d.name} (${d.kind}, lines ${d.line}-${d.end_line})`;

/** Exactly one declaration matching what the agent named, else why not. */
export function locateDeclaration(decls: readonly Declaration[], want: Want): Located {
  const dot = want.symbol.lastIndexOf('.');
  const parent = dot > 0 ? want.symbol.slice(0, dot) : null;
  const name = dot > 0 ? want.symbol.slice(dot + 1) : want.symbol;
  const byName = decls.filter((d) => d.name === name && (parent === null ? true : d.parent === parent));
  if (!byName.length) {
    return { ok: false, reason: `no declaration named ${want.symbol} in the file`, candidates: [] };
  }
  // The graph calls an arrow-function constant a function; a patch takes either name for it.
  const kindMatches = (d: Declaration, k: PatchKind) =>
    d.kind === k || (k === 'function' && d.kind === 'variable' && d.function_value);
  const byKind = want.kind ? byName.filter((d) => kindMatches(d, want.kind as PatchKind)) : byName;
  if (!byKind.length) {
    return {
      ok: false,
      reason: `${want.symbol} is not a ${want.kind}: ${byName.map(describe).join('; ')}`,
      candidates: byName,
    };
  }
  const byLine = want.line ? byKind.filter((d) => d.line === want.line) : byKind;
  if (!byLine.length) {
    return {
      ok: false,
      reason: `${want.symbol} does not start at line ${want.line} any more: ${byKind.map(describe).join('; ')}; read the file again`,
      candidates: byKind,
    };
  }
  if (byLine.length > 1) {
    return {
      ok: false,
      reason: `${want.symbol} is declared ${byLine.length} times: ${byLine.map(describe).join('; ')}; name the parent as Parent.member, or give the line`,
      candidates: byLine,
    };
  }
  const found = byLine[0] as Declaration;
  if (found.declarators > 1) {
    return {
      ok: false,
      reason: `${want.symbol} is declared in a statement with ${found.declarators} variables; edit it in the editor`,
      candidates: [found],
    };
  }
  return { ok: true, found };
}

export interface PatchPlan {
  found: Declaration;
  /** The text replaced and the text written in its place. */
  before: string;
  after: string;
  new_source: string;
  /** The lines of the file the patch replaces, and where the new declaration ends. */
  lines: { from: number; to: number; new_to: number };
  /** A line-by-line preview: `- ` lines out, `+ ` lines in, cut at 200 lines. */
  preview: string;
}

export type PatchResult = { ok: true; plan: PatchPlan } | { ok: false; reason: string; candidates: string[] };

const PREVIEW_LINES = 200;

function compatible(found: Declaration, next: Declaration): string | null {
  if (found.kind === next.kind) return null;
  const members = new Set<PatchKind>(['method', 'field']);
  if (members.has(found.kind) && members.has(next.kind)) return null;
  if (
    (found.kind === 'function' && next.kind === 'variable' && next.function_value) ||
    (found.kind === 'variable' && found.function_value && next.kind === 'function')
  ) {
    return null;
  }
  return `the new text declares a ${next.kind}; ${found.name} is a ${found.kind}`;
}

/**
 * Plans the replacement of one declaration (ADR-0039 §1, §2): finds it in a fresh parse, checks the
 * new text is one declaration of the same name and kind, splices it in and checks the whole file
 * still parses. Nothing is written here; the plan carries the new source and a preview.
 */
export async function planPatch(lang: LanguageSpec, source: string, want: Want, body: string): Promise<PatchResult> {
  const fail = (reason: string, candidates: Declaration[] = []): PatchResult => ({
    ok: false,
    reason,
    candidates: candidates.map(describe),
  });
  const { errors, decls } = await withTree(lang, source, (root) => ({
    errors: countErrors(root),
    decls: collectDeclarations(root),
  }));
  if (errors > 0) {
    return fail(
      `the file does not parse as it is (${errors} syntax error${errors > 1 ? 's' : ''}); fix it in the editor first`,
    );
  }
  const located = locateDeclaration(decls, want);
  if (!located.ok) return fail(located.reason, located.candidates);
  const found = located.found;

  // The body: the file's line endings, no blank lines around it, no export prefix of its own.
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  let text = body
    .replace(/\r\n?/g, '\n')
    .replace(/^\s*\n/, '')
    .replace(/\s+$/, '');
  const prefix = /^export\s+(default\s+)?/.exec(text);
  if (prefix) {
    if (found.exported === 'none') {
      return fail(`${describe(found)} is not exported; adding an export is a file-level change, made in the editor`);
    }
    const wants = prefix[1] ? 'export default' : 'export';
    if (wants !== found.exported) {
      return fail(`${describe(found)} is ${found.exported}; changing that is made in the editor`);
    }
    text = text.slice(prefix[0].length);
  }
  if (!text.trim()) return fail('the new text is empty; a declaration is removed in the editor');

  // The new text alone: one declaration, the same name, a compatible kind.
  const member = found.kind === 'method' || found.kind === 'field';
  const probe = member ? `${found.parent_kind === 'interface' ? 'interface' : 'class'} __ {\n${text}\n}` : text;
  const own = await withTree(lang, probe, (root) => ({
    errors: countErrors(root),
    decls: collectDeclarations(root),
    statements: root.namedChildren.filter((c) => c && c.type !== 'comment').length,
  }));
  if (own.errors > 0)
    return fail(`the new text does not parse (${own.errors} syntax error${own.errors > 1 ? 's' : ''})`);
  const declared = member ? own.decls.filter((d) => d.parent === '__') : own.decls.filter((d) => d.parent === null);
  if (declared.length !== 1 || (!member && own.statements !== 1)) {
    return fail(
      `the new text must be exactly one declaration (found ${declared.length}${member ? '' : `, ${own.statements} statements`})`,
    );
  }
  const next = declared[0] as Declaration;
  if (next.name !== found.name) return fail(`the new text declares ${next.name}, not ${found.name}`);
  if (next.declarators > 1) return fail('the new text declares several variables; one is replaced');
  const why = compatible(found, next);
  if (why) return fail(why);

  const before = source.slice(found.start, found.end);
  // A member's or a statement's `;` is the file's: the new text ends the way the old one did.
  if (/;$/.test(before) && !/;$/.test(text)) text += ';';
  else if (!/;$/.test(before) && /;$/.test(text) && found.kind !== 'namespace') text = text.replace(/;+$/, '');
  const after = text.replace(/\n/g, eol);
  const new_source = `${source.slice(0, found.start)}${after}${source.slice(found.end)}`;
  const afterErrors = await withTree(lang, new_source, countErrors);
  if (afterErrors > 0) {
    return fail(
      `with the new text the file no longer parses (${afterErrors} syntax error${afterErrors > 1 ? 's' : ''}); edit it in the editor`,
    );
  }
  const oldLines = before.split(/\r?\n/);
  const newLines = text.split('\n');
  const preview = [
    `@@ ${found.line},${found.end_line} -> ${found.line},${found.line + newLines.length - 1} @@`,
    ...oldLines.map((l) => `- ${l}`),
    ...newLines.map((l) => `+ ${l}`),
  ];
  return {
    ok: true,
    plan: {
      found,
      before,
      after,
      new_source,
      lines: { from: found.line, to: found.end_line, new_to: found.line + newLines.length - 1 },
      preview: (preview.length > PREVIEW_LINES
        ? [...preview.slice(0, PREVIEW_LINES), `… (${preview.length - PREVIEW_LINES} more lines)`]
        : preview
      ).join('\n'),
    },
  };
}

export type RangeStatus = 'exact' | 'end_differs' | 'ambiguous' | 'missing' | 'unsupported';

/**
 * The measurement of ADR-0039 §6: each recorded symbol (name, parent, line, end line) located again
 * among a fresh parse's declarations. `exact`: one declaration, same end line; `end_differs`: one,
 * another end line; `ambiguous`: several at that line; `missing`: none (an anonymous default, a
 * destructuring, a kind the patch does not take); `unsupported`: found, but in a statement with
 * several variables.
 */
export function checkRanges(
  decls: readonly Declaration[],
  symbols: readonly { name: string; parent: string | null; line: number; end_line: number }[],
): { name: string; parent: string | null; line: number; status: RangeStatus; detail?: string }[] {
  return symbols.map((s) => {
    const at = decls.filter((d) => d.name === s.name && d.parent === s.parent && d.line === s.line);
    if (!at.length) return { name: s.name, parent: s.parent, line: s.line, status: 'missing' };
    if (at.length > 1) return { name: s.name, parent: s.parent, line: s.line, status: 'ambiguous' };
    const d = at[0] as Declaration;
    if (d.declarators > 1) return { name: s.name, parent: s.parent, line: s.line, status: 'unsupported' };
    if (d.end_line !== s.end_line) {
      return {
        name: s.name,
        parent: s.parent,
        line: s.line,
        status: 'end_differs',
        detail: `${s.end_line} vs ${d.end_line}`,
      };
    }
    return { name: s.name, parent: s.parent, line: s.line, status: 'exact' };
  });
}
