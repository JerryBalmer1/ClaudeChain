import { mkdir, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readIngestedFile, MAX_FILE_BYTES } from '../../src/ingest/read.js';
import { languageOf } from '../../src/ingest/schema.js';
import { walkRepo, type WalkEntry } from '../../src/ingest/walk.js';
import { silentLogger } from '../../src/shared/logger.js';
import { tempDir } from '../helpers.js';

async function collect(root: string, maxDepth: number, ignore: readonly string[] = ['node_modules']): Promise<WalkEntry[]> {
  const out: WalkEntry[] = [];
  for await (const entry of walkRepo(root, { maxDepth, ignore: new Set(ignore), logger: silentLogger })) {
    out.push(entry);
  }
  return out;
}

const describeEntry = (e: WalkEntry): string => (e.kind === 'file' ? `${e.relPath}@${e.depth}` : `LIMIT ${e.relPath}@${e.depth}`);

describe('walkRepo', (): void => {
  let root = '';
  let cleanup: () => Promise<void> = (): Promise<void> => Promise.resolve();

  beforeAll(async (): Promise<void> => {
    const tmp = await tempDir('walk');
    root = tmp.dir;
    cleanup = tmp.cleanup;
    for (const rel of ['b.ts', 'a.ts', 'Z.md', 'dir/x.ts', 'dir/deeper/y.ts', 'node_modules/pkg/index.js']) {
      await mkdir(path.join(root, path.dirname(rel)), { recursive: true });
      await writeFile(path.join(root, rel), `// ${rel}\n`);
    }
  });

  afterAll(async (): Promise<void> => {
    await cleanup();
  });

  it('walks depth-first in ordinal order and skips ignored directories', async (): Promise<void> => {
    expect((await collect(root, 10)).map(describeEntry)).toEqual(['Z.md@0', 'a.ts@0', 'b.ts@0', 'dir/deeper/y.ts@2', 'dir/x.ts@1']);
  });

  it('stops at the first directory beyond maxDepth with a limit entry', async (): Promise<void> => {
    expect((await collect(root, 1)).map(describeEntry)).toEqual(['Z.md@0', 'a.ts@0', 'b.ts@0', 'LIMIT dir/deeper@2']);
    expect((await collect(root, 0)).map(describeEntry)).toEqual(['Z.md@0', 'a.ts@0', 'b.ts@0', 'LIMIT dir@1']);
  });

  it('never follows symlinks, so a symlink cycle terminates', async (ctx): Promise<void> => {
    try {
      await symlink(root, path.join(root, 'dir', 'loop'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      ctx.skip('symlinks unavailable on this machine');
    }
    const entries = await collect(root, 50);
    expect(entries.some((e: WalkEntry): boolean => e.relPath.includes('loop'))).toBe(false);
    expect(entries).toHaveLength(5);
  });
});

describe('readIngestedFile', (): void => {
  it('hashes text over normalized content and flags binary and oversized files', async (): Promise<void> => {
    const { dir, cleanup } = await tempDir('read');
    try {
      await writeFile(path.join(dir, 'crlf.ts'), 'a\r\nb\r\n');
      await writeFile(path.join(dir, 'lf.ts'), 'a\nb\n');
      await writeFile(path.join(dir, 'bin.dat'), Buffer.from([1, 0, 2]));
      await writeFile(path.join(dir, 'big.txt'), Buffer.alloc(MAX_FILE_BYTES + 1, 97));
      const read = (name: string): ReturnType<typeof readIngestedFile> =>
        readIngestedFile({ kind: 'file', absPath: path.join(dir, name), relPath: name, depth: 0 });
      const crlf = await read('crlf.ts');
      const lf = await read('lf.ts');
      expect(crlf.contentHash).toBe(lf.contentHash);
      expect(crlf.text).toBe('a\nb\n');
      expect(crlf.size).toBe(6);
      expect(await read('bin.dat')).toMatchObject({ skipped: 'binary', text: null });
      expect(await read('big.txt')).toMatchObject({ skipped: 'too-large', text: null });
    } finally {
      await cleanup();
    }
  });

  it('detects languages by extension', (): void => {
    expect(['a.ts', 'a.mts', 'a.tsx', 'a.cjs', 'a.jsx', 'a.json', 'a.MD', 'a.yml', 'a.rs'].map(languageOf)).toEqual([
      'typescript',
      'typescript',
      'tsx',
      'javascript',
      'jsx',
      'json',
      'markdown',
      'yaml',
      'other',
    ]);
  });
});
