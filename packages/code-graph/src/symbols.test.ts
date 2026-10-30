/**
 * Symbols, bindings and references of a file (ADR-0037 §1; plan Phase 5A).
 */
import { describe, expect, it } from 'vitest';
import { LANGUAGES, withTree } from './languages.js';
import { enclosingSymbol, extractFacts, MODULE_SYMBOL, type ParsedFacts } from './symbols.js';

const tsx = LANGUAGES.find((l) => l.id === 'tsx') as (typeof LANGUAGES)[number];
const facts = (src: string): Promise<ParsedFacts> => withTree(tsx, src, extractFacts);

const SAMPLE = `/** doc */
import def, { a as b, type T } from './m.ts';
import * as ns from './n.ts';
export function f(x: number): T {
  return b(x) + ns.g();
}
export default class C extends Base {
  private n = 1;
  static s() {}
  async m(): Promise<void> {
    new Other();
    obj.method();
    this.n;
  }
}
const arrow = async (y: string) => y;
export const v = 1, w = () => 2;
interface I { k: string }
export type Alias<X> = X[];
enum E { A, B }
export { arrow, v as vee };
export * from './x.ts';
namespace NS { export const q = 1; }
abstract class AC { abstract am(): void; }
function* gen() {}
const el = <Foo bar={1} />;
const el2 = <ns.Comp />;
let typed: I = { k: 'x' };
const fs = require('node:fs');
`;

describe('extractFacts', () => {
  it('declares every kind of symbol with its range, export and signature', async () => {
    const f = await facts(SAMPLE);
    const rows = f.symbols.map((s) => [s.name, s.kind, s.line, s.end_line, s.exported, s.parent]);
    expect(rows).toEqual([
      ['f', 'function', 4, 6, true, null],
      ['C', 'class', 7, 15, true, null],
      ['n', 'field', 8, 8, true, 'C'],
      ['s', 'method', 9, 9, true, 'C'],
      ['m', 'method', 10, 14, true, 'C'],
      ['arrow', 'function', 16, 16, true, null],
      ['v', 'variable', 17, 17, true, null],
      ['w', 'function', 17, 17, true, null],
      ['I', 'interface', 18, 18, false, null],
      ['Alias', 'type', 19, 19, true, null],
      ['E', 'enum', 20, 20, false, null],
      ['NS', 'namespace', 23, 23, false, null],
      ['q', 'variable', 23, 23, true, 'NS'],
      ['AC', 'class', 24, 24, false, null],
      ['am', 'method', 24, 24, false, 'AC'],
      ['gen', 'function', 25, 25, false, null],
      ['el', 'variable', 26, 26, false, null],
      ['el2', 'variable', 27, 27, false, null],
      ['typed', 'variable', 28, 28, false, null],
      ['fs', 'variable', 29, 29, false, null],
    ]);
    // The declaration's own first line; `export` is the flag, not part of the signature.
    expect(f.symbols.find((s) => s.name === 'f')?.signature).toBe('function f(x: number): T');
    expect(f.symbols.find((s) => s.name === 'm')?.signature).toBe('async m(): Promise<void>');
    expect(f.default_export).toBe('C');
    expect(f.imports.map((i) => [i.kind, i.specifier])).toEqual([
      ['import', './m.ts'],
      ['import', './n.ts'],
      ['re-export', './x.ts'],
      ['require', 'node:fs'],
    ]);
  });

  it('binds what each import names, and records calls, constructions, types, JSX and member calls', async () => {
    const f = await facts(SAMPLE);
    expect(f.bindings).toEqual([
      { local: 'def', imported: 'default', specifier: './m.ts', line: 2 },
      { local: 'b', imported: 'a', specifier: './m.ts', line: 2 },
      { local: 'T', imported: 'T', specifier: './m.ts', line: 2 },
      { local: 'ns', imported: '*', specifier: './n.ts', line: 3 },
      { local: 'fs', imported: '*', specifier: 'node:fs', line: 29 },
    ]);
    const refs = f.references.map((r) => `${r.kind}:${r.via ?? ''}:${r.name}@${r.line}`);
    expect(refs).toEqual([
      'type::T@4',
      'call::b@5',
      'member:ns:g@5',
      'type::Base@7',
      'type::Promise@10',
      'new::Other@11',
      'member:obj:method@12',
      'type::X@19',
      'jsx::Foo@26',
      'jsx:ns:Comp@27',
      'type::I@28',
    ]);
  });

  it('handles the other export forms and names the innermost symbol around a line', async () => {
    const f = await facts('export default function main() {}');
    expect(f.symbols.map((s) => [s.name, s.exported])).toEqual([['main', true]]);
    expect(f.default_export).toBe('main');
    const anonFn = await facts('export default function () {}');
    expect(anonFn.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([['default', 'function', true]]);
    const anon = await facts('export default () => 1;\nexport const k = 2;\nexport { k as kay };');
    expect(anon.symbols.map((s) => [s.name, s.kind, s.exported])).toEqual([
      ['default', 'function', true],
      ['k', 'variable', true],
    ]);
    expect(anon.default_export).toBe('default');
    const sample = await facts(SAMPLE);
    expect(enclosingSymbol(sample.symbols, 5)).toBe('f');
    expect(enclosingSymbol(sample.symbols, 11)).toBe('C.m');
    expect(enclosingSymbol(sample.symbols, 2)).toBe(MODULE_SYMBOL);
    expect(enclosingSymbol(sample.symbols, 7)).toBe('C');
  });
});
