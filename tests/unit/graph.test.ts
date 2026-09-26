import { describe, expect, it } from 'vitest';
import { CodeGraph } from '../../src/graph/graph.js';
import { candidatePaths, resolveRelativeSpecifier } from '../../src/graph/resolve.js';
import type { CallEdgeObject, TraversalStep } from '../../src/index.js';
import { storeFromSources } from '../helpers.js';

describe('resolveRelativeSpecifier', (): void => {
  const targets = new Map<string, string>([
    ['src/a.ts', 'module:src/a.ts'],
    ['src/dir/index.ts', 'module:src/dir/index.ts'],
    ['src/data.json', 'file:src/data.json'],
    ['src/comp.tsx', 'module:src/comp.tsx'],
  ]);

  it('maps NodeNext .js specifiers to .ts sources', (): void => {
    expect(resolveRelativeSpecifier('src/b.ts', './a.js', targets)).toBe('module:src/a.ts');
  });

  it('resolves extensionless, index and non-module files', (): void => {
    expect(resolveRelativeSpecifier('src/b.ts', './a', targets)).toBe('module:src/a.ts');
    expect(resolveRelativeSpecifier('src/b.ts', './dir', targets)).toBe('module:src/dir/index.ts');
    expect(resolveRelativeSpecifier('src/b.ts', './data.json', targets)).toBe('file:src/data.json');
    expect(resolveRelativeSpecifier('src/b.ts', './comp.js', targets)).toBe('module:src/comp.tsx');
  });

  it('never resolves outside the repo root', (): void => {
    expect(candidatePaths('a.ts', '../outside.js')).toEqual([]);
    expect(resolveRelativeSpecifier('src/b.ts', './missing.js', targets)).toBeNull();
  });
});

const SOURCES = {
  'src/util.ts': 'export function util(): number { return 1; }\nexport function unused(): void {}\n',
  'src/barrel.ts': "export { util as renamed } from './util.js';\nexport * from './more.js';\n",
  'src/more.ts': "import { util } from './util.js';\nexport function more(): number { return util() + 1; }\n",
  'src/main.ts': [
    "import { renamed, more } from './barrel.js';",
    "import * as u from './util.js';",
    "import type { T } from './types.js';",
    "import { z } from 'zod';",
    'export class Svc {',
    '  run(): number { return this.step() + renamed() + more() + u.util(); }',
    '  step(): number { return Svc.make(); }',
    '  static make(): number { return 0; }',
    '}',
    'export function entry(): void { new Svc().run(); z.string(); }',
  ].join('\n'),
  'src/types.ts': 'export type T = string;\n',
  'src/cyc1.ts': "import { c2 } from './cyc2.js';\nexport function c1(): void { c2(); }\n",
  'src/cyc2.ts': "import { c1 } from './cyc1.js';\nexport function c2(): void { c1(); }\n",
  'src/self.ts': "import './self.js';\n",
};

describe('linkGraph + CodeGraph', (): void => {
  const store = storeFromSources(SOURCES);
  const graph = CodeGraph.fromStore(store);
  const calleesOf = (id: string): (string | null)[] => graph.callees(id).map((c: CallEdgeObject): string | null => c.to);

  it('resolves imports and marks external ones', (): void => {
    const imports = store.ofKind('Import').filter((i): boolean => i.moduleId === 'module:src/main.ts');
    expect(imports.map((i): string | null => i.resolvedId)).toEqual(['module:src/barrel.ts', 'module:src/util.ts', 'module:src/types.ts', null]);
    expect(imports[3]).toMatchObject({ external: true, packageName: 'zod' });
  });

  it('creates one dependency edge per module pair, with type-only and external flags', (): void => {
    const deps = graph.dependencies('module:src/main.ts').map((d): string => `${d.to}${d.typeOnly ? ' (type)' : ''}${d.external ? ' (ext)' : ''}`);
    expect(deps).toEqual(['module:src/barrel.ts', 'module:src/util.ts', 'module:src/types.ts (type)', 'pkg:zod (ext)']);
  });

  it('follows renamed re-exports and star re-exports to the defining symbol', (): void => {
    const exports = store.ofKind('Export').filter((e): boolean => e.moduleId === 'module:src/barrel.ts');
    expect(exports.find((e): boolean => e.name === 'renamed')?.symbolId).toBe('symbol:src/util.ts#util');
  });

  it('resolves this.method, Class.static, namespace and re-exported calls', (): void => {
    expect(calleesOf('symbol:src/main.ts#Svc.run')).toEqual([
      'symbol:src/main.ts#Svc.step',
      'symbol:src/util.ts#util',
      'symbol:src/more.ts#more',
      'symbol:src/util.ts#util',
    ]);
    expect(calleesOf('symbol:src/main.ts#Svc.step')).toEqual(['symbol:src/main.ts#Svc.make']);
  });

  it('resolves constructors to the class and leaves unknown receivers unresolved', (): void => {
    const edges = graph.callees('symbol:src/main.ts#entry');
    expect(edges.map((e): string => `${e.calleeText}=${e.to ?? 'null'}`)).toEqual([
      '<expression>.run=null',
      'Svc=symbol:src/main.ts#Svc',
      'z.string=null',
    ]);
  });

  it('answers callers, and the transitive closure without revisiting', (): void => {
    expect(graph.callers('symbol:src/util.ts#util').map((c): string => c.from).sort()).toEqual([
      'symbol:src/main.ts#Svc.run',
      'symbol:src/main.ts#Svc.run',
      'symbol:src/more.ts#more',
    ]);
    const closure = graph.transitiveCallers('symbol:src/util.ts#util');
    expect(closure.steps.map((s: TraversalStep): string => `${s.depth}:${s.id}`)).toEqual([
      '1:symbol:src/more.ts#more',
      '1:symbol:src/main.ts#Svc.run',
    ]);
    expect(graph.callers('symbol:src/util.ts#unused')).toEqual([]);
  });

  it('transitive dependencies terminate on cycles and honour depth and external options', (): void => {
    const cyc = graph.transitiveDependencies('module:src/cyc1.ts');
    expect(cyc.steps.map((s: TraversalStep): string => s.id)).toEqual(['module:src/cyc2.ts']);
    expect(cyc.truncated).toBe(false);

    const shallow = graph.transitiveDependencies('module:src/main.ts', { maxDepth: 1 });
    expect(shallow.truncated).toBe(true);
    expect(shallow.steps.every((s: TraversalStep): boolean => s.depth === 1)).toBe(true);

    const withExternal = graph.transitiveDependencies('module:src/main.ts', { includeExternal: true });
    expect(withExternal.steps.map((s: TraversalStep): string => s.id)).toContain('pkg:zod');
    const capped = graph.transitiveDependencies('module:src/main.ts', { maxNodes: 2 });
    expect(capped.steps).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it('transitive dependents walk edges backwards', (): void => {
    const dependents = graph.transitiveDependents('module:src/util.ts');
    expect(dependents.steps.map((s: TraversalStep): string => s.id).sort()).toEqual([
      'module:src/barrel.ts',
      'module:src/main.ts',
      'module:src/more.ts',
    ]);
  });

  it('finds module cycles, including a self-import', (): void => {
    expect(graph.cycles()).toEqual([['module:src/cyc1.ts', 'module:src/cyc2.ts'], ['module:src/self.ts']]);
  });
});
