import { extractImports, type ImportFact } from './extract.js';
import type { TsNode } from './languages.js';

/**
 * Symbols, import bindings and references of one file (ADR-0037 §1): what a file declares, what
 * names its imports bind, and what it calls, constructs, types, renders or calls through a member.
 * Facts only; edges between symbols are derived at build time from these and the file graph.
 */

export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'variable'
  | 'method'
  | 'field'
  | 'namespace';

export interface SymbolFact {
  name: string;
  kind: SymbolKind;
  line: number;
  end_line: number;
  /** Exported as a declaration, as the default, or in an `export { … }` list. */
  exported: boolean;
  /** The class or namespace a member belongs to; null at the top level. */
  parent: string | null;
  /** The declaration's first line, trimmed, at most 200 characters. */
  signature: string;
}

/** What one import clause binds in the file. `imported` is `default`, `*` (a namespace) or the name. */
export interface ImportBinding {
  local: string;
  imported: string;
  specifier: string | null;
  line: number;
}

export type ReferenceKind = 'call' | 'new' | 'type' | 'jsx' | 'member';

/** A name the file uses. `via` is the object of a member call (`ns.f()` → name `f`, via `ns`). */
export interface ReferenceFact {
  name: string;
  via: string | null;
  kind: ReferenceKind;
  line: number;
}

export interface ParsedFacts {
  imports: ImportFact[];
  symbols: SymbolFact[];
  references: ReferenceFact[];
  bindings: ImportBinding[];
  /** The local name the default export names (`export default f`, `export default class C`); null when none or anonymous. */
  default_export: string | null;
}

/** The module level, the `from` end of a reference outside every declaration. */
export const MODULE_SYMBOL = '<module>';

const SIGNATURE_MAX = 200;

const DECLARATIONS = new Set([
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

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

function signature(node: TsNode): string {
  const first = node.text.split('\n')[0] ?? '';
  const trimmed = first
    .trim()
    .replace(/\s*[{=]\s*$/, '')
    .replace(/\s+$/, '');
  return trimmed.length > SIGNATURE_MAX ? `${trimmed.slice(0, SIGNATURE_MAX - 1)}…` : trimmed;
}

const literal = (node: TsNode | null | undefined): string | null => {
  if (!node) return null;
  if (node.type === 'string') return node.text.length >= 2 ? node.text.slice(1, -1) : null;
  return null;
};

const row = (n: TsNode) => n.startPosition.row + 1;
const endRow = (n: TsNode) => n.endPosition.row + 1;

function nameOf(node: TsNode): string | null {
  const field = node.childForFieldName('name');
  if (field) return field.text;
  const first = node.namedChildren.find(
    (c) => c && (c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'property_identifier'),
  );
  return first?.text ?? null;
}

/** Every symbol, binding and reference of a syntax tree, in source order. */
export function extractFacts(root: TsNode): ParsedFacts {
  const symbols: SymbolFact[] = [];
  const bindings: ImportBinding[] = [];
  const references = new Map<string, ReferenceFact>();
  const exportedNames = new Set<string>();
  let default_export: string | null = null;

  const addSymbol = (s: SymbolFact) => symbols.push(s);
  const addRef = (r: ReferenceFact) => {
    const key = `${r.kind}:${r.via ?? ''}:${r.name}:${r.line}`;
    if (!references.has(key)) references.set(key, r);
  };

  const declare = (node: TsNode, exported: boolean, parent: string | null): void => {
    switch (node.type) {
      case 'function_declaration':
      case 'generator_function_declaration': {
        const name = nameOf(node);
        if (name)
          addSymbol({
            name,
            kind: 'function',
            line: row(node),
            end_line: endRow(node),
            exported,
            parent,
            signature: signature(node),
          });
        return;
      }
      case 'class_declaration':
      case 'abstract_class_declaration': {
        const name = nameOf(node);
        if (!name) return;
        addSymbol({
          name,
          kind: 'class',
          line: row(node),
          end_line: endRow(node),
          exported,
          parent,
          signature: signature(node),
        });
        const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'class_body');
        for (const m of body?.namedChildren ?? []) {
          if (!m) continue;
          if (
            m.type === 'method_definition' ||
            m.type === 'method_signature' ||
            m.type === 'abstract_method_signature'
          ) {
            const mn = nameOf(m);
            if (mn)
              addSymbol({
                name: mn,
                kind: 'method',
                line: row(m),
                end_line: endRow(m),
                exported,
                parent: name,
                signature: signature(m),
              });
          } else if (m.type === 'public_field_definition' || m.type === 'property_signature') {
            const fn = nameOf(m);
            if (fn)
              addSymbol({
                name: fn,
                kind: 'field',
                line: row(m),
                end_line: endRow(m),
                exported,
                parent: name,
                signature: signature(m),
              });
          }
        }
        return;
      }
      case 'interface_declaration': {
        const name = nameOf(node);
        if (name)
          addSymbol({
            name,
            kind: 'interface',
            line: row(node),
            end_line: endRow(node),
            exported,
            parent,
            signature: signature(node),
          });
        return;
      }
      case 'type_alias_declaration': {
        const name = nameOf(node);
        if (name)
          addSymbol({
            name,
            kind: 'type',
            line: row(node),
            end_line: endRow(node),
            exported,
            parent,
            signature: signature(node),
          });
        return;
      }
      case 'enum_declaration': {
        const name = nameOf(node);
        if (name)
          addSymbol({
            name,
            kind: 'enum',
            line: row(node),
            end_line: endRow(node),
            exported,
            parent,
            signature: signature(node),
          });
        return;
      }
      case 'lexical_declaration':
      case 'variable_declaration': {
        for (const d of node.namedChildren) {
          if (d?.type !== 'variable_declarator') continue;
          const nameNode = d.childForFieldName('name');
          if (nameNode?.type !== 'identifier') continue; // destructuring patterns name nothing
          const value = d.childForFieldName('value');
          // `const x = require('y')`: a binding, as an import would be.
          if (value?.type === 'call_expression') {
            const fn = value.childForFieldName('function');
            if (fn?.type === 'identifier' && fn.text === 'require') {
              const arg = value.childForFieldName('arguments')?.namedChildren.find((c) => c && c.type !== 'comment');
              bindings.push({ local: nameNode.text, imported: '*', specifier: literal(arg), line: row(d) });
            }
          }
          const kind: SymbolKind = value && FUNCTION_VALUES.has(value.type) ? 'function' : 'variable';
          addSymbol({
            name: nameNode.text,
            kind,
            line: row(d),
            end_line: endRow(d),
            exported,
            parent,
            signature: signature(node.namedChildren.length === 1 ? node : d),
          });
        }
        return;
      }
      case 'internal_module': {
        const name = nameOf(node);
        if (!name) return;
        addSymbol({
          name,
          kind: 'namespace',
          line: row(node),
          end_line: endRow(node),
          exported,
          parent,
          signature: signature(node),
        });
        const body = node.childForFieldName('body') ?? node.namedChildren.find((c) => c?.type === 'statement_block');
        for (const s of body?.namedChildren ?? []) if (s) statement(s, name);
        return;
      }
      default:
        return;
    }
  };

  /** A statement at the top level or in a namespace: declarations, exports, imports. */
  const statement = (node: TsNode, parent: string | null): void => {
    if (DECLARATIONS.has(node.type)) {
      declare(node, false, parent);
      return;
    }
    if (node.type === 'expression_statement') {
      const inner = node.namedChildren[0];
      if (inner?.type === 'internal_module') declare(inner, false, parent);
      return;
    }
    if (node.type === 'export_statement') {
      const decl =
        node.childForFieldName('declaration') ?? node.namedChildren.find((c) => c && DECLARATIONS.has(c.type));
      const isDefault = /^export\s+default\b/.test(node.text);
      if (decl) {
        declare(decl, true, parent);
        if (isDefault) default_export = nameOf(decl);
        return;
      }
      const value = node.childForFieldName('value');
      if (isDefault && value) {
        if (value.type === 'identifier') default_export = value.text;
        else {
          // An anonymous default (`export default () => …`, an object): a symbol named `default`.
          addSymbol({
            name: 'default',
            kind: FUNCTION_VALUES.has(value.type) ? 'function' : 'variable',
            line: row(node),
            end_line: endRow(node),
            exported: true,
            parent,
            signature: signature(node),
          });
          default_export = 'default';
        }
        return;
      }
      const clause = node.namedChildren.find((c) => c?.type === 'export_clause');
      for (const spec of clause?.namedChildren ?? []) {
        if (spec?.type !== 'export_specifier') continue;
        const local = spec.childForFieldName('name') ?? spec.namedChildren[0];
        if (local) exportedNames.add(local.text);
      }
      return;
    }
    if (node.type === 'import_statement') {
      const specifier = literal(
        node.childForFieldName('source') ?? node.namedChildren.find((c) => c?.type === 'string'),
      );
      const line = row(node);
      const requireClause = node.namedChildren.find((c) => c?.type === 'import_require_clause');
      if (requireClause) {
        const id = requireClause.namedChildren.find((c) => c?.type === 'identifier');
        if (id) bindings.push({ local: id.text, imported: '*', specifier, line });
        return;
      }
      const clause = node.namedChildren.find((c) => c?.type === 'import_clause');
      for (const c of clause?.namedChildren ?? []) {
        if (!c) continue;
        if (c.type === 'identifier') bindings.push({ local: c.text, imported: 'default', specifier, line });
        else if (c.type === 'namespace_import') {
          const id = c.namedChildren.find((x) => x?.type === 'identifier');
          if (id) bindings.push({ local: id.text, imported: '*', specifier, line });
        } else if (c.type === 'named_imports') {
          for (const spec of c.namedChildren) {
            if (spec?.type !== 'import_specifier') continue;
            const name = spec.childForFieldName('name') ?? spec.namedChildren.find((x) => x?.type === 'identifier');
            const alias = spec.childForFieldName('alias');
            if (name) bindings.push({ local: (alias ?? name).text, imported: name.text, specifier, line });
          }
        }
      }
    }
  };

  for (const s of root.namedChildren) if (s) statement(s, null);
  for (const s of symbols) if (!s.exported && s.parent === null && exportedNames.has(s.name)) s.exported = true;

  // References, over the whole tree.
  const stack: TsNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as TsNode;
    const line = row(node);
    switch (node.type) {
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'identifier') {
          if (fn.text !== 'require') addRef({ name: fn.text, via: null, kind: 'call', line });
        } else if (fn?.type === 'member_expression') {
          const prop = fn.childForFieldName('property');
          const obj = fn.childForFieldName('object');
          if (prop && obj)
            addRef({
              name: prop.text,
              via: obj.type === 'identifier' || obj.type === 'this' ? obj.text : '?',
              kind: 'member',
              line,
            });
        }
        break;
      }
      case 'new_expression': {
        const ctor = node.childForFieldName('constructor');
        if (ctor?.type === 'identifier') addRef({ name: ctor.text, via: null, kind: 'new', line });
        else if (ctor?.type === 'member_expression') {
          const prop = ctor.childForFieldName('property');
          const obj = ctor.childForFieldName('object');
          if (prop && obj)
            addRef({ name: prop.text, via: obj.type === 'identifier' ? obj.text : '?', kind: 'new', line });
        }
        break;
      }
      case 'jsx_opening_element':
      case 'jsx_self_closing_element': {
        const name = node.childForFieldName('name') ?? node.namedChildren[0];
        if (name?.type === 'identifier' && /^[A-Z]/.test(name.text))
          addRef({ name: name.text, via: null, kind: 'jsx', line });
        else if (name?.type === 'member_expression') {
          const prop = name.childForFieldName('property');
          const obj = name.childForFieldName('object');
          if (prop && obj)
            addRef({ name: prop.text, via: obj.type === 'identifier' ? obj.text : '?', kind: 'jsx', line });
        }
        break;
      }
      case 'type_identifier': {
        addRef({ name: node.text, via: null, kind: 'type', line });
        break;
      }
      case 'extends_clause': {
        for (const c of node.namedChildren)
          if (c?.type === 'identifier') addRef({ name: c.text, via: null, kind: 'type', line });
        break;
      }
      default:
        break;
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) {
      const child = node.namedChildren[i];
      if (!child) continue;
      // A declaration's own name is not a reference to itself.
      if (child.type === 'type_identifier' && DECLARATIONS.has(node.type) && nameOf(node) === child.text) continue;
      stack.push(child);
    }
  }

  const byLine = (a: { line: number }, b: { line: number }) => a.line - b.line;
  return {
    imports: extractImports(root),
    symbols: [...symbols].sort((a, b) => a.line - b.line || a.name.localeCompare(b.name)),
    references: [...references.values()].sort((a, b) => byLine(a, b) || a.name.localeCompare(b.name)),
    bindings: [...bindings].sort(byLine),
    default_export,
  };
}

/** The innermost symbol whose range holds the line, else the module level. */
export function enclosingSymbol(symbols: readonly SymbolFact[], line: number): string {
  let best: SymbolFact | undefined;
  for (const s of symbols) {
    if (s.line <= line && line <= s.end_line) {
      if (!best || s.end_line - s.line < best.end_line - best.line) best = s;
    }
  }
  return best ? (best.parent ? `${best.parent}.${best.name}` : best.name) : MODULE_SYMBOL;
}
