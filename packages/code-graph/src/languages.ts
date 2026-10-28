import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Tree-sitter languages (ADR-0020 §1): `@vscode/tree-sitter-wasm` ships the web-tree-sitter
 * runtime and its grammars built together. One parser per language, created on first use.
 */

const require = createRequire(import.meta.url);

// The runtime is a UMD bundle; these are the parts of its API Friday uses.
export interface TsPoint {
  row: number;
  column: number;
}
export interface TsNode {
  type: string;
  text: string;
  startPosition: TsPoint;
  namedChildren: (TsNode | null)[];
  children: (TsNode | null)[];
  childForFieldName(name: string): TsNode | null;
}
interface TsTree {
  rootNode: TsNode;
  delete(): void;
}
interface TsParser {
  setLanguage(language: unknown): void;
  parse(source: string): TsTree | null;
}
interface TsRuntime {
  Parser: { init(): Promise<void>; new (): TsParser };
  Language: { load(file: string): Promise<unknown> };
}

export type LanguageId = 'typescript' | 'tsx' | 'javascript';

export interface LanguageSpec {
  id: LanguageId;
  extensions: string[];
  grammar: string;
}

export const LANGUAGES: LanguageSpec[] = [
  { id: 'typescript', extensions: ['.ts', '.mts', '.cts'], grammar: 'tree-sitter-typescript.wasm' },
  { id: 'tsx', extensions: ['.tsx'], grammar: 'tree-sitter-tsx.wasm' },
  { id: 'javascript', extensions: ['.js', '.jsx', '.mjs', '.cjs'], grammar: 'tree-sitter-javascript.wasm' },
];

export function languageOf(file: string): LanguageSpec | undefined {
  const lower = file.toLowerCase();
  if (lower.endsWith('.d.ts')) return LANGUAGES[0];
  const ext = path.posix.extname(lower);
  return LANGUAGES.find((l) => l.extensions.includes(ext));
}

let runtime: Promise<TsRuntime> | undefined;
const parsers = new Map<LanguageId, Promise<TsParser>>();

function loadRuntime(): Promise<TsRuntime> {
  runtime ??= (async () => {
    const rt = require('@vscode/tree-sitter-wasm') as TsRuntime;
    await rt.Parser.init();
    return rt;
  })();
  return runtime;
}

export function parserFor(lang: LanguageSpec): Promise<TsParser> {
  let p = parsers.get(lang.id);
  if (!p) {
    p = (async () => {
      const rt = await loadRuntime();
      const dir = path.dirname(require.resolve('@vscode/tree-sitter-wasm'));
      const language = await rt.Language.load(path.join(dir, lang.grammar));
      const parser = new rt.Parser();
      parser.setLanguage(language);
      return parser;
    })();
    parsers.set(lang.id, p);
  }
  return p;
}

/** Parses `source`, hands the root to `fn`, and frees the tree's WebAssembly memory. */
export async function withTree<T>(lang: LanguageSpec, source: string, fn: (root: TsNode) => T): Promise<T> {
  const parser = await parserFor(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter could not parse a ${lang.id} file`);
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}
