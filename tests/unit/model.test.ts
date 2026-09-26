import { describe, expect, it } from 'vitest';
import { buildFileObject, buildModuleObjects, isRelativeSpecifier, packageNameOf } from '../../src/model/build.js';
import { IdAllocator, ids } from '../../src/model/ids.js';
import { ChainObjectSchema, type ChainObject } from '../../src/model/schema.js';
import { ObjectStore } from '../../src/model/store.js';
import { parseSource } from '../../src/parse/typescript.js';
import { ChainError } from '../../src/shared/errors.js';
import { sha256Hex } from '../../src/shared/hash.js';
import { storeFromSources, virtualFile } from '../helpers.js';

describe('ids', (): void => {
  it('are deterministic and path-based', (): void => {
    expect(ids.symbol('src/a.ts', 'C.m')).toBe('symbol:src/a.ts#C.m');
    expect(ids.dependency('src/a.ts', 'pkg:zod')).toBe('dep:src/a.ts->pkg:zod');
  });

  it('IdAllocator disambiguates repeats by offset', (): void => {
    const allocator = new IdAllocator();
    expect(allocator.allocate('symbol:a#x', 10)).toBe('symbol:a#x');
    expect(allocator.allocate('symbol:a#x', 20)).toBe('symbol:a#x~20');
    expect(allocator.allocate('symbol:a#x', 20)).toBe('symbol:a#x~20.2');
  });
});

describe('specifiers', (): void => {
  it('distinguishes relative from bare specifiers', (): void => {
    expect(isRelativeSpecifier('./a.js')).toBe(true);
    expect(isRelativeSpecifier('..')).toBe(true);
    expect(isRelativeSpecifier('zod')).toBe(false);
  });

  it('derives package names, normalizing builtins', (): void => {
    expect(packageNameOf('@scope/pkg/deep/x')).toBe('@scope/pkg');
    expect(packageNameOf('lodash/fp')).toBe('lodash');
    expect(packageNameOf('fs')).toBe('node:fs');
    expect(packageNameOf('node:path')).toBe('node:path');
  });
});

describe('buildModuleObjects', (): void => {
  const text = 'const hidden = 1;\nexport function shown(): number { return helper(); }\nfunction helper(): number { return hidden; }\nexport { helper as aliased };\n';
  const ingested = virtualFile('src/m.ts', text);
  const file = buildFileObject(ingested, 'repo:virtual');
  const parsed = parseSource('src/m.ts', text, 'typescript', { astMode: 'declarations' });
  if (parsed === null) {
    throw new Error('parse failed');
  }
  const built = buildModuleObjects(file, text, parsed);

  it('produces objects that validate against their schemas', (): void => {
    const all: ChainObject[] = [file, built.module, ...built.symbols, ...built.imports, ...built.exports, ...built.calls, ...built.astNodes];
    for (const object of all) {
      expect(ChainObjectSchema.safeParse(object).success).toBe(true);
    }
  });

  it('hashes span objects over their exact source slice', (): void => {
    const shown = built.symbols.find((s): boolean => s.name === 'shown');
    expect(shown?.hash).toBe(sha256Hex('export function shown(): number { return helper(); }'));
    expect(shown?.provenance).toMatchObject({ file: 'src/m.ts', span: { start: { line: 2 } } });
  });

  it('marks symbols exported by modifier or by a later export clause', (): void => {
    const exported = Object.fromEntries(built.symbols.map((s): [string, boolean] => [s.name, s.exported]));
    expect(exported).toEqual({ hidden: false, shown: true, helper: true });
    expect(built.exports.find((e): boolean => e.name === 'aliased')?.symbolId).toBe('symbol:src/m.ts#helper');
  });

  it('attributes calls to the enclosing symbol and leaves resolution to the graph', (): void => {
    expect(built.calls).toHaveLength(1);
    expect(built.calls[0]).toMatchObject({ from: 'symbol:src/m.ts#shown', to: null, resolved: false });
  });

  it('the file hash is the ingest content hash', (): void => {
    expect(file.hash).toBe(ingested.contentHash);
    expect(built.module.hash).toBe(file.hash);
  });
});

describe('ObjectStore', (): void => {
  it('rejects duplicate ids and unknown replacements', (): void => {
    const store = storeFromSources({ 'a.ts': 'export const a = 1;' });
    const symbol = store.getOfKind('Symbol', 'symbol:a.ts#a');
    expect(symbol).toBeDefined();
    if (symbol === undefined) {
      return;
    }
    expect((): void => {
      store.add(symbol);
    }).toThrow(ChainError);
    expect((): void => {
      new ObjectStore().replace(symbol);
    }).toThrow(/unknown object id/);
  });

  it('counts by kind', (): void => {
    const store = storeFromSources({ 'a.ts': 'export const a = 1;', 'README.md': '# hi' });
    expect(store.countByKind()).toMatchObject({ Repo: 1, File: 2, Module: 1, Symbol: 1, Export: 1 });
  });
});
