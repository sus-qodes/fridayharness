import { describe, expect, it } from 'vitest';
import { h } from '../ui/dom.js';
import { splitLines } from './diff.js';
import { type Language, languageOf, MAX_HIGHLIGHT_CHARS, type Token, tokenize, tokenizeLines } from './highlight.js';

/** A template literal with a placeholder, as source text. */
const TEMPLATE = ['`t $', '{x}`'].join('');

const HOSTILE = '<img src=x onerror=alert(1)></script><b>bold</b>\u202Eevil\u200Bzero';

const SAMPLES: Record<Exclude<Language, 'plain'>, string> = {
  typescript: [
    "import { a } from './a.js';",
    '/** Doc */',
    'export async function run(x: number): Promise<string> {',
    `  const s = ${TEMPLATE}; // note`,
    "  return 'q' + 0x1f + 1.5e3 + this.value;",
    '}',
    '@Decorator class Foo<T> {}',
  ].join('\n'),
  json: '{\n  "name": "friday",\n  "n": -1.5e2,\n  "ok": true,\n  "list": [null, "x"]\n}',
  yaml: '# comment\n---\nname: friday\nlist:\n  - a: "x"\n  - b: 12\nanchor: &base\nref: *base\nflag: yes\nblock: |\n  text',
  python: '@dataclass\ndef run(x):\n    """Doc\n    string"""\n    return f"{x}" if x else None  # tail\n',
  rust: '#[derive(Debug)]\nfn main<\'a>(x: &\'a str) -> i32 {\n    let c = \'c\';\n    println!("{}", r#"raw"#);\n    42u8 as i32\n}',
  css: '/* c */\n@media (max-width: 600px) {\n  a:hover, .x > #y {\n    color: #fff;\n    --gap: 4px;\n    margin: calc(1rem + 2%) !important;\n  }\n}',
  markdown:
    '# Title\n\nSome *em* and **strong**, `code`, [link](http://x).\n\n```ts\nconst x = 1;\n```\n\n> quote\n- item\n<img src=x>',
};

function kinds(tokens: Token[], kind: string): string[] {
  return tokens.filter((t) => t.kind === kind).map((t) => t.text);
}

describe('languageOf', () => {
  it.each([
    ['src/a.ts', 'typescript'],
    ['src/a.tsx', 'typescript'],
    ['lib/x.mjs', 'typescript'],
    ['C:\\p\\a.JS', 'typescript'],
    ['package.json', 'json'],
    ['.friday/config.yaml', 'yaml'],
    ['ci.yml', 'yaml'],
    ['tool.py', 'python'],
    ['src/main.rs', 'rust'],
    ['styles/a.css', 'css'],
    ['README.md', 'markdown'],
    ['Makefile', 'plain'],
    ['.env', 'plain'],
    ['archive.tar.gz', 'plain'],
  ])('%s → %s', (path, lang) => {
    expect(languageOf(path)).toBe(lang);
  });
});

describe('tokenize', () => {
  it.each(Object.entries(SAMPLES))('%s tokens join back into the input', (lang, text) => {
    const tokens = tokenize(text, lang as Language);
    expect(tokens.map((t) => t.text).join('')).toBe(text);
    expect(tokens.every((t) => t.text.length > 0)).toBe(true);
  });

  it.each([...Object.keys(SAMPLES), 'plain'])('%s: hostile text stays plain text when rendered', (lang) => {
    const text = `${SAMPLES[lang as keyof typeof SAMPLES] ?? ''}\n${HOSTILE}\n"${HOSTILE}"\n// ${HOSTILE}`;
    const tokens = tokenize(text, lang as Language);
    expect(tokens.map((t) => t.text).join('')).toBe(text);
    const el = h(
      'code',
      null,
      tokens.map((t) => h('span', { class: `dr-tk-${t.kind}` }, t.text)),
    );
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.children.length).toBe(tokens.length);
    expect(el.textContent).toBe(text);
  });

  it('TypeScript: keywords, strings, comments, numbers, functions, types', () => {
    const t = tokenize(SAMPLES.typescript, 'typescript');
    expect(kinds(t, 'keyword')).toEqual(
      expect.arrayContaining(['import', 'from', 'export', 'async', 'function', 'const', 'return', 'class']),
    );
    expect(kinds(t, 'string')).toEqual(expect.arrayContaining(["'./a.js'", TEMPLATE, "'q'"]));
    expect(kinds(t, 'comment')).toEqual(['/** Doc */', '// note']);
    expect(kinds(t, 'number')).toEqual(['0x1f', '1.5e3']);
    expect(kinds(t, 'function')).toContain('run');
    expect(kinds(t, 'type')).toEqual(expect.arrayContaining(['number', 'Promise', 'string', 'Foo', 'T']));
    expect(kinds(t, 'constant')).toContain('this');
    expect(kinds(t, 'property')).toContain('value');
    expect(kinds(t, 'meta')).toEqual(['@Decorator']);
  });

  it('JSON: keys are properties, values strings, numbers and constants', () => {
    const t = tokenize(SAMPLES.json, 'json');
    expect(kinds(t, 'property')).toEqual(['"name"', '"n"', '"ok"', '"list"']);
    expect(kinds(t, 'string')).toEqual(['"friday"', '"x"']);
    expect(kinds(t, 'number')).toEqual(['-1.5e2']);
    expect(kinds(t, 'constant')).toEqual(['true', 'null']);
  });

  it('YAML: keys, comments, anchors, constants, numbers', () => {
    const t = tokenize(SAMPLES.yaml, 'yaml');
    expect(kinds(t, 'comment')).toEqual(['# comment']);
    expect(kinds(t, 'property')).toEqual(expect.arrayContaining(['name', 'list', 'a', 'b', 'anchor', 'ref', 'flag']));
    expect(kinds(t, 'variable')).toEqual(['&base', '*base']);
    expect(kinds(t, 'constant')).toEqual(['yes']);
    expect(kinds(t, 'number')).toEqual(['12']);
    expect(kinds(t, 'meta')).toEqual(['---']);
  });

  it('Python: keywords, decorators, triple-quoted and prefixed strings', () => {
    const t = tokenize(SAMPLES.python, 'python');
    expect(kinds(t, 'keyword')).toEqual(expect.arrayContaining(['def', 'return', 'if', 'else']));
    expect(kinds(t, 'meta')).toEqual(['@dataclass']);
    expect(kinds(t, 'string')).toEqual(['"""Doc\n    string"""', 'f"{x}"']);
    expect(kinds(t, 'constant')).toEqual(['None']);
    expect(kinds(t, 'comment')).toEqual(['# tail']);
  });

  it('Rust: attributes, lifetimes, chars, macros, raw strings, typed numbers', () => {
    const t = tokenize(SAMPLES.rust, 'rust');
    expect(kinds(t, 'meta')).toEqual(['#[derive(Debug)]']);
    expect(kinds(t, 'variable')).toEqual(["'a", "'a"]);
    expect(kinds(t, 'string')).toEqual(expect.arrayContaining(["'c'", '"{}"', 'r#"raw"#']));
    expect(kinds(t, 'function')).toEqual(['println!']);
    expect(kinds(t, 'number')).toEqual(['42u8']);
    expect(kinds(t, 'type')).toEqual(['str', 'i32', 'i32']);
  });

  it('CSS: selectors outside braces, properties inside, colours, variables, at-rules', () => {
    const t = tokenize(SAMPLES.css, 'css');
    expect(kinds(t, 'keyword')).toEqual(['@media', '!important']);
    expect(kinds(t, 'property')).toEqual(expect.arrayContaining(['color', 'margin']));
    expect(kinds(t, 'property')).not.toContain('a');
    expect(kinds(t, 'tag').join('')).toContain('a');
    expect(kinds(t, 'number')).toEqual(expect.arrayContaining(['#fff', '4px', '1rem', '2%', '600px']));
    expect(kinds(t, 'variable')).toEqual(['--gap']);
    expect(kinds(t, 'function')).toEqual(['calc']);
  });

  it('Markdown: headings, emphasis, code spans and fences, links, quotes, tags as text', () => {
    const t = tokenize(SAMPLES.markdown, 'markdown');
    expect(kinds(t, 'heading')).toEqual(['# Title']);
    expect(kinds(t, 'emphasis')).toEqual(['*em*', '**strong**']);
    expect(kinds(t, 'code')).toEqual(['`code`', '```ts\nconst x = 1;\n```']);
    expect(kinds(t, 'link')).toEqual(['[link](http://x)']);
    expect(kinds(t, 'comment')).toEqual(['> quote']);
    expect(kinds(t, 'tag')).toEqual(['<img src=x>']);
  });

  it('leaves unknown languages and very large texts as one plain token', () => {
    expect(tokenize('a < b', 'plain')).toEqual([{ text: 'a < b', kind: 'plain' }]);
    const big = 'x'.repeat(MAX_HIGHLIGHT_CHARS + 1);
    expect(tokenize(big, 'typescript')).toEqual([{ text: big, kind: 'plain' }]);
    expect(tokenize('', 'typescript')).toEqual([]);
  });

  it('keeps astral characters whole', () => {
    const text = 'const 😀 = "😀";';
    const tokens = tokenize(text, 'typescript');
    expect(tokens.map((t) => t.text).join('')).toBe(text);
    expect(tokens.some((t) => t.text.includes('\uD83D') && !t.text.includes('\uDE00'))).toBe(false);
  });

  it('handles a 5 000-character line', () => {
    const line = `const s = "${'a'.repeat(5000)}";`;
    const tokens = tokenize(line, 'typescript');
    expect(tokens.map((t) => t.text).join('')).toBe(line);
    expect(kinds(tokens, 'string')[0]?.length).toBe(5002);
  });
});

describe('tokenizeLines', () => {
  it('splits a token that spans lines and keeps its kind', () => {
    const text = 'a /* one\ntwo */ b\nc';
    const lines = tokenizeLines(text, 'typescript');
    expect(lines).toHaveLength(3);
    expect(lines[0]?.at(-1)).toEqual({ text: '/* one', kind: 'comment' });
    expect(lines[1]?.[0]).toEqual({ text: 'two */', kind: 'comment' });
    expect(lines[2]).toEqual([{ text: 'c', kind: 'plain' }]);
  });

  it.each(['a\nb\n', 'a\r\nb\r\n', '\n\n', 'x', ''])('gives the same lines as splitLines for %j', (text) => {
    const lines = tokenizeLines(text, 'typescript');
    expect(lines.map((l) => l.map((t) => t.text).join(''))).toEqual(splitLines(text));
  });

  it('gives no lines for a missing side', () => {
    expect(tokenizeLines(null, 'json')).toEqual([]);
  });
});
