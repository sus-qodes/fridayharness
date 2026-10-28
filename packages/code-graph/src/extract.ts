import type { TsNode } from './languages.js';

/** How a file refers to another module (ADR-0020 §3). */
export type ImportKind =
  | 'import'
  | 'type-import'
  | 'side-effect'
  | 're-export'
  | 'import-equals'
  | 'require'
  | 'dynamic-import';

export interface ImportFact {
  kind: ImportKind;
  /** The module specifier; null when it is computed at run time. */
  specifier: string | null;
  line: number;
}

/** A string literal's value, or null for anything else (including templates with substitutions). */
function literal(node: TsNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string') {
    const text = node.text;
    return text.length >= 2 ? text.slice(1, -1) : null;
  }
  if (node.type === 'template_string') {
    if (node.namedChildren.some((c) => c?.type === 'template_substitution')) return null;
    return node.text.slice(1, -1);
  }
  return null;
}

const firstArgument = (call: TsNode): TsNode | null => {
  const args = call.childForFieldName('arguments');
  return args?.namedChildren.find((c) => c && c.type !== 'comment') ?? null;
};

/** Every import-like reference in a syntax tree, in source order. */
export function extractImports(root: TsNode): ImportFact[] {
  const out: ImportFact[] = [];
  const stack: TsNode[] = [root];
  while (stack.length) {
    const node = stack.pop() as TsNode;
    const line = node.startPosition.row + 1;
    switch (node.type) {
      case 'import_statement': {
        const requireClause = node.namedChildren.find((c) => c?.type === 'import_require_clause');
        if (requireClause) {
          const src =
            requireClause.childForFieldName('source') ?? requireClause.namedChildren.find((c) => c?.type === 'string');
          out.push({ kind: 'import-equals', specifier: literal(src), line });
          continue;
        }
        const source = node.childForFieldName('source');
        const hasClause = node.namedChildren.some((c) => c?.type === 'import_clause');
        const typeOnly = /^import\s+type\b/.test(node.text);
        out.push({
          kind: typeOnly ? 'type-import' : hasClause ? 'import' : 'side-effect',
          specifier: literal(source),
          line,
        });
        continue;
      }
      case 'export_statement': {
        const source = node.childForFieldName('source');
        if (source) out.push({ kind: 're-export', specifier: literal(source), line });
        break;
      }
      case 'call_expression': {
        const fn = node.childForFieldName('function');
        if (fn?.type === 'import') {
          out.push({ kind: 'dynamic-import', specifier: literal(firstArgument(node)), line });
        } else if (fn?.type === 'identifier' && fn.text === 'require') {
          out.push({ kind: 'require', specifier: literal(firstArgument(node)), line });
        }
        break;
      }
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i--) {
      const child = node.namedChildren[i];
      if (child) stack.push(child);
    }
  }
  return out.sort((a, b) => a.line - b.line);
}
