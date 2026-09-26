import { describe, expect, it } from 'vitest';
import type { SymbolObject } from '../../src/model/schema.js';
import { Chain } from '../../src/query/chain.js';
import { ChainError } from '../../src/shared/errors.js';
import { chainFromSources } from '../helpers.js';

const chain = chainFromSources({
  'src/a.ts': "import { b } from './b.js';\nexport function alpha(): void { b(); }\nexport const ALPHA = 1;\nfunction hidden(): void {}\n",
  'src/b.ts': 'export function b(): void {}\nexport class Beta { go(): void {} }\n',
  'lib/c.ts': 'export function gamma(): void {}\n',
});

const names = (symbols: readonly SymbolObject[]): string[] => symbols.map((s: SymbolObject): string => s.name);

describe('Chain.query', (): void => {
  it('filters by exact value and returns typed objects', (): void => {
    const result = chain.query({ kind: 'Symbol', where: { symbolKind: 'function', exported: true } });
    expect(names(result)).toEqual(['alpha', 'b', 'gamma']);
  });

  it('supports $in, $ne and $regex', (): void => {
    expect(names(chain.query({ kind: 'Symbol', where: { name: { $in: ['alpha', 'go'] } } }))).toEqual(['alpha', 'go']);
    expect(names(chain.query({ kind: 'Symbol', where: { symbolKind: { $ne: 'function' } } }))).toEqual(['ALPHA', 'Beta', 'go']);
    expect(names(chain.query({ kind: 'Symbol', where: { qualifiedName: { $regex: '^Beta\\.' } } }))).toEqual(['go']);
  });

  it('matches null fields', (): void => {
    expect(names(chain.query({ kind: 'Symbol', where: { parentId: null, exported: false } }))).toEqual(['hidden']);
  });

  it('filters on provenance file by exact path or regex', (): void => {
    expect(chain.query({ kind: 'Module', file: 'lib/c.ts' }).map((m): string => m.id)).toEqual(['module:lib/c.ts']);
    expect(chain.query({ kind: 'Module', file: { $regex: '^src/' } })).toHaveLength(2);
  });

  it('paginates with offset and limit', (): void => {
    const all = chain.query({ kind: 'Symbol' });
    expect(chain.query({ kind: 'Symbol', offset: 1, limit: 2 })).toEqual(all.slice(1, 3));
  });

  it('rejects unknown fields, bad kinds, bad regexes and non-scalar filters', (): void => {
    expect((): unknown => chain.queryUnknown({ kind: 'Symbol', where: { nope: 1 } })).toThrow(/has no field "nope"/);
    expect((): unknown => chain.queryUnknown({ kind: 'Widget' })).toThrow(ChainError);
    expect((): unknown => chain.queryUnknown({ kind: 'Symbol', where: { name: { $regex: '(' } } })).toThrow(/invalid \$regex/);
    expect((): unknown => chain.queryUnknown({ kind: 'Import', where: { names: 'x' } })).toThrow(/not a scalar field/);
    expect((): unknown => chain.queryUnknown({ kind: 'Symbol', extra: true })).toThrow(/invalid query/);
  });

  it('queryUnknown and query agree', (): void => {
    expect(chain.queryUnknown({ kind: 'Symbol', where: { exported: true } })).toEqual(chain.query({ kind: 'Symbol', where: { exported: true } }));
  });
});

describe('Chain graph API', (): void => {
  it('get and require by stable id', (): void => {
    expect(chain.get('symbol:src/a.ts#alpha')?.kind).toBe('Symbol');
    expect(chain.get('symbol:missing')).toBeNull();
    expect((): unknown => chain.require('symbol:missing')).toThrow(/no object with id/);
  });

  it('callers and callees across modules', (): void => {
    expect(chain.callers('symbol:src/b.ts#b').map((c): string => c.from)).toEqual(['symbol:src/a.ts#alpha']);
    expect(chain.callees('symbol:src/a.ts#alpha').map((c): string | null => c.to)).toEqual(['symbol:src/b.ts#b']);
    expect(chain.dependencies('module:src/a.ts').map((d): string => d.to)).toEqual(['module:src/b.ts']);
    expect(chain.dependents('module:src/b.ts').map((d): string => d.from)).toEqual(['module:src/a.ts']);
  });

  it('refuses graph calls on the wrong kind of object', (): void => {
    expect((): unknown => chain.callers('module:src/a.ts')).toThrow(/expected Symbol/);
    expect((): unknown => chain.dependencies('symbol:src/a.ts#alpha')).toThrow(/expected Module/);
  });
});

describe('snapshots', (): void => {
  it('round-trip every object exactly', (): void => {
    const snapshot = JSON.parse(JSON.stringify(chain.toSnapshot({ name: 'claudechain', version: '0.0.0' }))) as unknown;
    const restored = Chain.fromSnapshot(snapshot);
    expect(restored.counts()).toEqual(chain.counts());
    expect(restored.query({ kind: 'CallEdge' })).toEqual(chain.query({ kind: 'CallEdge' }));
    expect(restored.callers('symbol:src/b.ts#b')).toEqual(chain.callers('symbol:src/b.ts#b'));
  });

  it('reject malformed input and duplicate ids', (): void => {
    expect((): unknown => Chain.fromSnapshot({ format: 'nope' })).toThrow(/invalid snapshot/);
    const snapshot = chain.toSnapshot({ name: 'claudechain', version: '0.0.0' });
    const first = snapshot.objects[0];
    if (first === undefined) {
      throw new Error('empty snapshot');
    }
    expect((): unknown => Chain.fromSnapshot({ ...snapshot, objects: [first, first] })).toThrow(/duplicate object id/);
    const tampered = { ...snapshot, objects: [{ ...first, hash: 'ABC' }] };
    expect((): unknown => Chain.fromSnapshot(tampered)).toThrow(/invalid snapshot at objects\.0\.hash/);
  });
});
