import { describe, expect, it } from 'vitest';
import type { ParsedModule, RawImport, RawSymbol } from '../../src/parse/schema.js';
import { isParsableLanguage, parseSource } from '../../src/parse/typescript.js';

const SOURCE = `import def, { a as b, c } from './x.js';
import * as ns from 'lodash/fp';
import type { T } from './t.js';
import './side.js';
import fs = require('fs');
const r = require('./r.js');
const { p, q: qq } = require('./pq.js');
export { b as bee };
export { z } from './z.js';
export * from './star.js';
export * as nsx from './nsx.js';
export default function () { return lazy(); }
export const k = 1, m = () => helper();
export class C extends Base {
  constructor() { super(); }
  method(): void { this.other(); ns.fn(); }
  get g(): number { return 1; }
  other(): void {}
}
function overloaded(x: string): void;
function overloaded(x: number): void;
function overloaded(x: unknown): void { new C(); }
async function lazy() { return import('./dyn.js'); }
function helper() { function inner() {} inner(); }
interface I { x: number }
type U = string | number;
enum E { A }
namespace N { export const v = 1; }
`;

function parse(text: string, astMode: 'declarations' | 'full' = 'declarations'): ParsedModule {
  const parsed = parseSource('src/sample.ts', text, 'typescript', { astMode });
  if (parsed === null) {
    throw new Error('expected a parse result');
  }
  return parsed;
}

describe('parseSource', (): void => {
  const parsed = parse(SOURCE);
  const symbol = (qualifiedName: string): RawSymbol | undefined =>
    parsed.symbols.find((s: RawSymbol): boolean => s.qualifiedName === qualifiedName);
  const importOf = (specifier: string): RawImport | undefined =>
    parsed.imports.find((i: RawImport): boolean => i.specifier === specifier);

  it('refuses languages it cannot parse', (): void => {
    expect(isParsableLanguage('markdown')).toBe(false);
    expect(parseSource('README.md', '# x', 'markdown', { astMode: 'declarations' })).toBeNull();
  });

  it('extracts every declaration kind with qualified names', (): void => {
    const kinds = Object.fromEntries(parsed.symbols.map((s: RawSymbol): [string, string] => [s.qualifiedName, s.symbolKind]));
    expect(kinds).toEqual({
      r: 'const',
      p: 'const',
      qq: 'const',
      default: 'function',
      k: 'const',
      m: 'const',
      C: 'class',
      'C.constructor': 'constructor',
      'C.method': 'method',
      'C.g': 'accessor',
      'C.other': 'method',
      overloaded: 'function',
      lazy: 'function',
      helper: 'function',
      'helper.inner': 'function',
      I: 'interface',
      U: 'type',
      E: 'enum',
      N: 'namespace',
      'N.v': 'const',
    });
  });

  it('records one symbol per overloaded function: the implementation', (): void => {
    const overloads = parsed.symbols.filter((s: RawSymbol): boolean => s.name === 'overloaded');
    expect(overloads).toHaveLength(1);
    expect(overloads[0]?.signature).toBe('function overloaded(x: unknown): void');
  });

  it('marks export modifiers and default exports', (): void => {
    expect(symbol('default')?.isDefault).toBe(true);
    expect(symbol('C')?.exportedByModifier).toBe(true);
    expect(symbol('k')?.exportedByModifier).toBe(true);
    expect(symbol('lazy')?.exportedByModifier).toBe(false);
    expect(symbol('N.v')?.exportedByModifier).toBe(false);
  });

  it('extracts spans with 1-based lines and 0-based offsets', (): void => {
    const lazy = symbol('lazy');
    expect(lazy?.span.start.line).toBe(23);
    expect(lazy?.span.start.column).toBe(1);
    expect(SOURCE.slice(lazy?.span.start.offset, lazy?.span.end.offset)).toBe("async function lazy() { return import('./dyn.js'); }");
  });

  it('classifies every import form', (): void => {
    expect(importOf('./x.js')).toMatchObject({
      importKind: 'static',
      typeOnly: false,
      names: [
        { imported: 'default', local: 'def' },
        { imported: 'a', local: 'b' },
        { imported: 'c', local: 'c' },
      ],
    });
    expect(importOf('lodash/fp')?.names).toEqual([{ imported: '*', local: 'ns' }]);
    expect(importOf('./t.js')?.typeOnly).toBe(true);
    expect(importOf('./side.js')?.names).toEqual([]);
    expect(importOf('fs')).toMatchObject({ importKind: 'import-equals', names: [{ imported: '*', local: 'fs' }] });
    expect(importOf('./r.js')).toMatchObject({ importKind: 'require', names: [{ imported: '*', local: 'r' }] });
    expect(importOf('./pq.js')?.names).toEqual([
      { imported: 'p', local: 'p' },
      { imported: 'q', local: 'qq' },
    ]);
    expect(importOf('./z.js')?.importKind).toBe('reexport');
    expect(importOf('./star.js')?.importKind).toBe('reexport');
    expect(importOf('./nsx.js')?.names).toEqual([{ imported: '*', local: 'nsx' }]);
    expect(importOf('./dyn.js')?.importKind).toBe('dynamic');
    expect(parsed.imports).toHaveLength(11);
  });

  it('classifies every export form', (): void => {
    const exports = parsed.exports.map((e): string => `${e.exportKind}:${e.name}:${e.localName ?? '-'}:${e.source ?? '-'}`);
    expect(exports).toEqual([
      'named:bee:b:-',
      'reexport:z:z:./z.js',
      'star:*:-:./star.js',
      'namespace-reexport:nsx:*:./nsx.js',
      'default:default:default:-',
      'declaration:k:k:-',
      'declaration:m:m:-',
      'declaration:C:C:-',
    ]);
  });

  it('records calls with their enclosing symbol, receiver and constructor flag', (): void => {
    const calls = parsed.calls.map((call): string => {
      const caller = call.callerIndex === null ? '<module>' : (parsed.symbols[call.callerIndex]?.qualifiedName ?? '?');
      return `${caller} ${call.isNew ? 'new ' : ''}${call.calleeText} [${call.receiver ?? '-'}]`;
    });
    expect(calls).toEqual([
      'default lazy [-]',
      'm helper [-]',
      'C.constructor super [-]',
      'C.method this.other [this]',
      'C.method ns.fn [ns]',
      'overloaded new C [-]',
      'helper inner [-]',
    ]);
  });

  it('does not count require() or import() as calls', (): void => {
    expect(parsed.calls.some((c): boolean => c.calleeName === 'require' || c.calleeName === 'import')).toBe(false);
  });

  it('records declaration-level AST nodes by default and every node in full mode', (): void => {
    const declarations = parse(SOURCE, 'declarations').astNodes;
    const full = parse(SOURCE, 'full').astNodes;
    expect(declarations[0]).toMatchObject({ nodeKind: 'SourceFile', parentIndex: null, depth: 0 });
    expect(declarations.some((n): boolean => n.nodeKind === 'MethodDeclaration' && n.name === 'method')).toBe(true);
    expect(declarations.some((n): boolean => n.nodeKind === 'Identifier')).toBe(false);
    expect(full.some((n): boolean => n.nodeKind === 'Identifier')).toBe(true);
    expect(full.length).toBeGreaterThan(declarations.length * 5);
    for (const node of full) {
      if (node.parentIndex !== null) {
        expect(full[node.parentIndex]?.depth).toBe(node.depth - 1);
      }
    }
  });

  it('parses JavaScript and TSX', (): void => {
    expect(parseSource('a.js', 'function f() { g(); }', 'javascript', { astMode: 'declarations' })?.calls).toHaveLength(1);
    const tsx = parseSource('a.tsx', 'export const App = () => <div>{render()}</div>;', 'tsx', { astMode: 'declarations' });
    expect(tsx?.calls.map((c): string => c.calleeName)).toEqual(['render']);
  });
});
