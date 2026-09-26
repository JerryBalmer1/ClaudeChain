import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { languageOf } from '../../src/ingest/schema.js';
import { parseSource } from '../../src/parse/typescript.js';
import { REPO_ROOT } from '../helpers.js';

/**
 * The layer law, enforced by ClaudeChain's own parser. A file may import only from its own
 * layer or a lower one. `shared` is the foundation; `index.ts` sits above everything.
 */
const LAYERS = ['shared', 'ingest', 'parse', 'model', 'graph', 'query', 'cli'] as const;

function layerOf(srcRelative: string): number {
  const top = srcRelative.split('/')[0] ?? '';
  if (srcRelative === 'index.ts') {
    return LAYERS.length;
  }
  const rank = LAYERS.findIndex((layer: string): boolean => layer === top);
  if (rank < 0) {
    throw new Error(`src/${srcRelative} is not inside a known layer`);
  }
  return rank;
}

async function sourceFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      out.push(...(await sourceFiles(path.join(dir, entry.name), rel)));
    } else if (entry.name.endsWith('.ts')) {
      out.push(rel);
    }
  }
  return out;
}

describe('architecture', (): void => {
  it('no layer imports upward', async (): Promise<void> => {
    const srcRoot = path.join(REPO_ROOT, 'src');
    const violations: string[] = [];
    const files = await sourceFiles(srcRoot);
    expect(files.length).toBeGreaterThan(20);
    for (const rel of files) {
      const text = await readFile(path.join(srcRoot, rel), 'utf8');
      const parsed = parseSource(rel, text, languageOf(rel), { astMode: 'declarations' });
      for (const imp of parsed?.imports ?? []) {
        if (!imp.specifier.startsWith('.')) {
          continue;
        }
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), imp.specifier));
        if (layerOf(target) > layerOf(rel)) {
          violations.push(`src/${rel} imports upward: ${imp.specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it('src contains no any, no ts-ignore family comments, no double assertions', async (): Promise<void> => {
    const srcRoot = path.join(REPO_ROOT, 'src');
    const offenders: string[] = [];
    for (const rel of await sourceFiles(srcRoot)) {
      const text = await readFile(path.join(srcRoot, rel), 'utf8');
      const patterns: readonly [string, RegExp][] = [
        ['any', /(:\s*any\b|\bas any\b|<any>|any\[\])/],
        ['ts-comment', /@ts-(ignore|nocheck|expect-error)/],
        ['as unknown as', /\bas unknown as\b/],
      ];
      for (const [label, pattern] of patterns) {
        if (pattern.test(text)) {
          offenders.push(`src/${rel}: ${label}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
