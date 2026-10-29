/**
 * A small syntax highlighter for the diff drawer (plan §7.4): TypeScript/JavaScript, JSON, YAML,
 * Python, Rust, CSS and Markdown, chosen by file extension. It returns `{text, kind}` tokens whose
 * texts, joined, are exactly the input: the drawer renders each as a text node with a class, so a
 * token never carries markup (plan FD-20). Pure; no DOM.
 */
import { splitLines } from './diff.js';

export type TokenKind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'comment'
  | 'number'
  | 'constant'
  | 'type'
  | 'function'
  | 'property'
  | 'variable'
  | 'operator'
  | 'punct'
  | 'meta'
  | 'tag'
  | 'heading'
  | 'emphasis'
  | 'code'
  | 'link';

export interface Token {
  text: string;
  kind: TokenKind;
}

export type Language = 'typescript' | 'json' | 'yaml' | 'python' | 'rust' | 'css' | 'markdown' | 'plain';

/** Beyond this many characters a text is not highlighted (it stays plain text). */
export const MAX_HIGHLIGHT_CHARS = 512 * 1024;

const EXTENSIONS: Record<string, Language> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'typescript',
  jsx: 'typescript',
  mjs: 'typescript',
  cjs: 'typescript',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  py: 'python',
  pyi: 'python',
  rs: 'rust',
  css: 'css',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
};

/** The language of a path by its extension; `plain` when unknown. */
export function languageOf(path: string): Language {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 && !name.startsWith('.')) return 'plain';
  const ext = name.slice(dot + 1).toLowerCase();
  return EXTENSIONS[ext] ?? 'plain';
}

type WordClass = (word: string, next: string, prev: string) => TokenKind;

interface Rule {
  kind: TokenKind | 'word';
  re: RegExp;
}

interface Spec {
  rules: Rule[];
  word?: WordClass;
  /** Adjusts tokens after scanning (CSS: properties outside braces are selectors). */
  post?: (tokens: Token[]) => Token[];
}

const sticky = (source: string, flags = ''): RegExp => new RegExp(source, `y${flags}`);

const words = (list: string): Set<string> => new Set(list.split(/\s+/).filter(Boolean));

const TS_KEYWORDS = words(`
  abstract as asserts async await break case catch class const continue debugger declare default delete do else
  enum export extends finally for from function get if implements import in infer instanceof interface is keyof
  let module namespace new of override private protected public readonly return satisfies set static switch
  throw try type typeof unique var void while with yield`);
const TS_CONSTANTS = words('true false null undefined NaN Infinity this super');
const TS_TYPES = words('string number boolean bigint symbol object unknown never any void');

const PY_KEYWORDS = words(`
  and as assert async await break class continue def del elif else except finally for from global if import in
  is lambda nonlocal not or pass raise return try while with yield match case`);
const PY_CONSTANTS = words('True False None self cls');

const RS_KEYWORDS = words(`
  as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut
  pub ref return static struct super trait type union unsafe use where while yield`);
const RS_CONSTANTS = words('true false self Self None Some Ok Err');
const RS_TYPES = words(
  'i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str String Vec Option Result Box',
);

const IDENT = '[A-Za-z_$][\\w$]*';
const NUMBER =
  '(?:0[xX][\\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?:\\d[\\d_]*(?:\\.\\d[\\d_]*)?|\\.\\d[\\d_]*)(?:[eE][+-]?\\d+)?)';
const WHITESPACE: Rule = { kind: 'plain', re: sticky('\\s+') };

function codeWord(keywords: Set<string>, constants: Set<string>, types: Set<string>): WordClass {
  return (word, next, prev) => {
    if (keywords.has(word)) return 'keyword';
    if (constants.has(word)) return 'constant';
    if (types.has(word)) return 'type';
    if (next === '(') return 'function';
    if (prev === '.') return 'property';
    if (/^[A-Z]/.test(word)) return 'type';
    return 'plain';
  };
}

const SPECS: Record<Exclude<Language, 'plain'>, Spec> = {
  typescript: {
    rules: [
      WHITESPACE,
      { kind: 'comment', re: sticky('\\/\\/[^\\n]*') },
      { kind: 'comment', re: sticky('\\/\\*[\\s\\S]*?(?:\\*\\/|$(?![\\s\\S]))') },
      { kind: 'string', re: sticky("'(?:[^'\\\\\\n]|\\\\.)*'?") },
      { kind: 'string', re: sticky('"(?:[^"\\\\\\n]|\\\\.)*"?') },
      { kind: 'string', re: sticky('`(?:[^`\\\\]|\\\\[\\s\\S])*`?') },
      { kind: 'number', re: sticky(`${NUMBER}n?(?![\\w$])`) },
      { kind: 'meta', re: sticky(`@${IDENT}`) },
      { kind: 'word', re: sticky(IDENT) },
      { kind: 'operator', re: sticky('=>|[+\\-*/%=&|^!<>?:~]+') },
      { kind: 'punct', re: sticky('[{}()\\[\\];,.]') },
    ],
    word: codeWord(TS_KEYWORDS, TS_CONSTANTS, TS_TYPES),
  },
  json: {
    rules: [
      WHITESPACE,
      { kind: 'comment', re: sticky('\\/\\/[^\\n]*') },
      { kind: 'comment', re: sticky('\\/\\*[\\s\\S]*?(?:\\*\\/|$(?![\\s\\S]))') },
      { kind: 'property', re: sticky('"(?:[^"\\\\\\n]|\\\\.)*"(?=\\s*:)') },
      { kind: 'string', re: sticky('"(?:[^"\\\\\\n]|\\\\.)*"?') },
      { kind: 'number', re: sticky('-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?') },
      { kind: 'constant', re: sticky('(?:true|false|null)(?![\\w$])') },
      { kind: 'punct', re: sticky('[{}\\[\\],:]') },
    ],
  },
  yaml: {
    rules: [
      WHITESPACE,
      { kind: 'comment', re: sticky('(?<=^|\\s)#[^\\n]*', 'm') },
      { kind: 'meta', re: sticky('^(?:---|\\.\\.\\.)(?=\\s|$)', 'm') },
      { kind: 'string', re: sticky("'(?:[^'\\n]|'')*'?") },
      { kind: 'string', re: sticky('"(?:[^"\\\\\\n]|\\\\.)*"?') },
      { kind: 'property', re: sticky('(?:[A-Za-z0-9_$@./]|-(?!\\s))[\\w$@./ -]*?(?=\\s*:(?:\\s|$))', 'm') },
      { kind: 'variable', re: sticky('[&*][\\w-]+') },
      { kind: 'meta', re: sticky('!!?[\\w-]*') },
      { kind: 'constant', re: sticky('(?:true|false|yes|no|on|off|null|~)(?![\\w-])') },
      { kind: 'number', re: sticky('[-+]?(?:\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)(?![\\w-])') },
      { kind: 'operator', re: sticky('[|>][-+]?(?=\\s*$)', 'm') },
      { kind: 'punct', re: sticky('[-:,\\[\\]{}?]') },
      { kind: 'plain', re: sticky('[^\\s#:,\\[\\]{}\'"]+') },
    ],
  },
  python: {
    rules: [
      WHITESPACE,
      { kind: 'comment', re: sticky('#[^\\n]*') },
      {
        kind: 'string',
        re: sticky('[rRbBuUfF]{0,2}(?:"""[\\s\\S]*?(?:"""|$(?![\\s\\S]))|\'\'\'[\\s\\S]*?(?:\'\'\'|$(?![\\s\\S])))'),
      },
      { kind: 'string', re: sticky('[rRbBuUfF]{0,2}(?:"(?:[^"\\\\\\n]|\\\\.)*"?|\'(?:[^\'\\\\\\n]|\\\\.)*\'?)') },
      { kind: 'meta', re: sticky('@[\\w.]+') },
      { kind: 'number', re: sticky(`${NUMBER}[jJ]?(?![\\w])`) },
      { kind: 'word', re: sticky('[A-Za-z_]\\w*') },
      { kind: 'operator', re: sticky('->|[+\\-*/%=&|^!<>~:@]+') },
      { kind: 'punct', re: sticky('[{}()\\[\\];,.]') },
    ],
    word: codeWord(PY_KEYWORDS, PY_CONSTANTS, new Set()),
  },
  rust: {
    rules: [
      WHITESPACE,
      { kind: 'comment', re: sticky('\\/\\/[^\\n]*') },
      { kind: 'comment', re: sticky('\\/\\*[\\s\\S]*?(?:\\*\\/|$(?![\\s\\S]))') },
      { kind: 'meta', re: sticky('#!?\\[[^\\]\\n]*\\]?') },
      { kind: 'string', re: sticky('b?r(#*)"[\\s\\S]*?(?:"\\1|$(?![\\s\\S]))') },
      { kind: 'string', re: sticky('b?"(?:[^"\\\\]|\\\\[\\s\\S])*"?') },
      {
        kind: 'string',
        re: sticky("b?'(?:[^'\\\\\\n]|\\\\(?:[nrt\\\\0'\"]|x[\\da-fA-F]{2}|u\\{[\\da-fA-F]{1,6}\\}))'"),
      },
      { kind: 'variable', re: sticky("'[A-Za-z_]\\w*") },
      { kind: 'number', re: sticky(`${NUMBER}(?:[iuf](?:8|16|32|64|128|size))?(?![\\w])`) },
      { kind: 'function', re: sticky('[A-Za-z_]\\w*!(?!=)') },
      { kind: 'word', re: sticky('[A-Za-z_]\\w*') },
      { kind: 'operator', re: sticky('->|=>|::|[+\\-*/%=&|^!<>?~]+') },
      { kind: 'punct', re: sticky('[{}()\\[\\];,.:]') },
    ],
    word: codeWord(RS_KEYWORDS, RS_CONSTANTS, RS_TYPES),
  },
  css: {
    rules: [
      WHITESPACE,
      { kind: 'comment', re: sticky('\\/\\*[\\s\\S]*?(?:\\*\\/|$(?![\\s\\S]))') },
      { kind: 'string', re: sticky("'(?:[^'\\\\\\n]|\\\\.)*'?") },
      { kind: 'string', re: sticky('"(?:[^"\\\\\\n]|\\\\.)*"?') },
      { kind: 'keyword', re: sticky('@[\\w-]+|!important') },
      { kind: 'variable', re: sticky('--[\\w-]+') },
      { kind: 'number', re: sticky('#[\\da-fA-F]{3,8}(?![\\w-])') },
      { kind: 'number', re: sticky('-?(?:\\d*\\.\\d+|\\d+)(?:%|[a-zA-Z]+)?') },
      { kind: 'function', re: sticky('[\\w-]+(?=\\()') },
      { kind: 'property', re: sticky('[\\w-]+(?=\\s*:)') },
      { kind: 'plain', re: sticky('[\\w-]+') },
      { kind: 'punct', re: sticky('[{}()\\[\\];,.:>+~*=]') },
    ],
    post: cssSelectors,
  },
  markdown: {
    rules: [
      { kind: 'code', re: sticky('^(`{3,}|~{3,})[^\\n]*(?:\\n[\\s\\S]*?)?(?:\\n\\1[^\\n]*|$(?![\\s\\S]))', 'm') },
      { kind: 'heading', re: sticky('^#{1,6}(?:[ \\t][^\\n]*)?$', 'm') },
      { kind: 'comment', re: sticky('^>[^\\n]*', 'm') },
      { kind: 'punct', re: sticky('^(?:-{3,}|\\*{3,}|_{3,})[ \\t]*$', 'm') },
      { kind: 'punct', re: sticky('^[ \\t]*(?:[-*+]|\\d+[.)])(?=[ \\t])', 'm') },
      WHITESPACE,
      { kind: 'code', re: sticky('`[^`\\n]+`') },
      { kind: 'emphasis', re: sticky('\\*\\*[^*\\n]+\\*\\*|__[^_\\n]+__|\\*[^*\\n]+\\*|_[^_\\n]+_') },
      { kind: 'link', re: sticky('!?\\[[^\\]\\n]*\\]\\([^)\\n]*\\)') },
      { kind: 'tag', re: sticky('<\\/?[A-Za-z][^>\\n]*>') },
      { kind: 'plain', re: sticky('[^\\s`*_\\[!<]+') },
    ],
  },
};

/**
 * CSS: every word outside braces, and a word before a `{` with no `;` or `}` between, is part of a
 * selector (`a:hover`); a word before `:` inside a block is a property.
 */
function cssSelectors(tokens: Token[]): Token[] {
  const nextStop: (string | null)[] = new Array<string | null>(tokens.length).fill(null);
  let next: string | null = null;
  for (let i = tokens.length - 1; i >= 0; i--) {
    nextStop[i] = next;
    const t = tokens[i] as Token;
    if (t.kind === 'punct' && (t.text === '{' || t.text === ';' || t.text === '}')) next = t.text;
  }
  let depth = 0;
  tokens.forEach((t, i) => {
    if (t.kind === 'punct') {
      if (t.text === '{') depth++;
      else if (t.text === '}') depth = Math.max(0, depth - 1);
      return;
    }
    const inSelector = depth === 0 || nextStop[i] === '{';
    const wordy = t.kind === 'property' || (t.kind === 'plain' && /^[\s\w-]+$/.test(t.text) && /[\w-]/.test(t.text));
    if (inSelector && wordy) t.kind = 'tag';
  });
  return tokens;
}

function push(tokens: Token[], text: string, kind: TokenKind): void {
  if (!text) return;
  const last = tokens[tokens.length - 1];
  if (last && last.kind === kind && kind === 'plain') last.text += text;
  else tokens.push({ text, kind });
}

function nextVisible(text: string, from: number): string {
  for (let i = from; i < text.length; i++) {
    const c = text[i] as string;
    if (c !== ' ' && c !== '\t') return c;
  }
  return '';
}

/** Tokens of a whole text. Joined, their texts equal `text`. */
export function tokenize(text: string, lang: Language): Token[] {
  if (!text) return [];
  if (lang === 'plain' || text.length > MAX_HIGHLIGHT_CHARS) return [{ text, kind: 'plain' }];
  const spec = SPECS[lang];
  const tokens: Token[] = [];
  let pos = 0;
  while (pos < text.length) {
    let matched = false;
    for (const rule of spec.rules) {
      rule.re.lastIndex = pos;
      const m = rule.re.exec(text);
      if (!m || m[0].length === 0) continue;
      const value = m[0];
      let kind: TokenKind;
      if (rule.kind === 'word') {
        const prev = pos > 0 ? (text[pos - 1] as string) : '';
        kind = spec.word ? spec.word(value, nextVisible(text, pos + value.length), prev) : 'plain';
      } else kind = rule.kind;
      push(tokens, value, kind);
      pos += value.length;
      matched = true;
      break;
    }
    if (!matched) {
      // One code point that no rule takes (a lone symbol): plain text.
      const cp = text.codePointAt(pos) ?? 0;
      const step = cp > 0xffff ? 2 : 1;
      push(tokens, text.slice(pos, pos + step), 'plain');
      pos += step;
    }
  }
  return spec.post ? spec.post(tokens) : tokens;
}

/**
 * Tokens per line, with the same lines as `splitLines` (diff.ts): a token that spans lines (a
 * block comment, a template string) is split at each newline and keeps its kind.
 */
export function tokenizeLines(text: string | null | undefined, lang: Language): Token[][] {
  const count = splitLines(text).length;
  if (!text || count === 0) return [];
  const lines: Token[][] = [[]];
  for (const token of tokenize(text, lang)) {
    const parts = token.text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (part) (lines[lines.length - 1] as Token[]).push({ text: part, kind: token.kind });
    });
  }
  for (const line of lines) {
    const last = line[line.length - 1];
    if (last?.text.endsWith('\r')) {
      last.text = last.text.slice(0, -1);
      if (!last.text) line.pop();
    }
  }
  return lines.slice(0, count);
}
