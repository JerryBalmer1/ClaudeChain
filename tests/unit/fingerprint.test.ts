import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  computeSelfFingerprint,
  locateSelfRoot,
  MIN_CONTENT_MATCH_BYTES,
  SELF_PACKAGE_NAME,
} from '../../src/ingest/fingerprint.js';
import { ChainError } from '../../src/shared/errors.js';
import { REPO_ROOT, selfFingerprint, tempDir } from '../helpers.js';

const LONG = `export function long(): string {\n  return '${'x'.repeat(MIN_CONTENT_MATCH_BYTES)}';\n}\n`;

async function fakePackage(dir: string, files: Readonly<Record<string, string>>, version = '1.2.3'): Promise<void> {
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: SELF_PACKAGE_NAME, version }));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

describe('self-fingerprint', (): void => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async (): Promise<void> => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  it('fingerprints this checkout: name, version, every src file', async (): Promise<void> => {
    const fp = await selfFingerprint();
    expect(fp.packageName).toBe('claudechain');
    expect(fp.version).toBe('0.1.0');
    expect(fp.files.map((f): string => f.relPath)).toContain('src/ingest/fingerprint.ts');
    expect(fp.files.every((f): boolean => f.relPath.startsWith('src/'))).toBe(true);
  });

  it('locates its own root by walking up from any directory beneath it', async (): Promise<void> => {
    const located = await locateSelfRoot(path.join(REPO_ROOT, 'src', 'ingest'));
    expect(path.resolve(located)).toBe(path.resolve(REPO_ROOT));
  });

  it('is deterministic and changes when any source file changes', async (): Promise<void> => {
    const { dir, cleanup } = await tempDir('fp');
    cleanups.push(cleanup);
    await fakePackage(dir, { 'src/a.ts': LONG, 'src/b/c.ts': 'export const c = 1;\n' });
    const first = await computeSelfFingerprint({ root: dir });
    const second = await computeSelfFingerprint({ root: dir });
    expect(second).toEqual(first);

    await writeFile(path.join(dir, 'src', 'b', 'c.ts'), 'export const c = 2;\n');
    const edited = await computeSelfFingerprint({ root: dir });
    expect(edited.srcTreeHash).not.toBe(first.srcTreeHash);
    expect(edited.fingerprintHash).not.toBe(first.fingerprintHash);
  });

  it('folds the version into the fingerprint hash', async (): Promise<void> => {
    const one = await tempDir('fp-v1');
    const two = await tempDir('fp-v2');
    cleanups.push(one.cleanup, two.cleanup);
    await fakePackage(one.dir, { 'src/a.ts': LONG }, '1.0.0');
    await fakePackage(two.dir, { 'src/a.ts': LONG }, '2.0.0');
    const a = await computeSelfFingerprint({ root: one.dir });
    const b = await computeSelfFingerprint({ root: two.dir });
    expect(a.srcTreeHash).toBe(b.srcTreeHash);
    expect(a.fingerprintHash).not.toBe(b.fingerprintHash);
  });

  it('only files of at least MIN_CONTENT_MATCH_BYTES are eligible for content matching', async (): Promise<void> => {
    const { dir, cleanup } = await tempDir('fp-elig');
    cleanups.push(cleanup);
    await fakePackage(dir, { 'src/a.ts': LONG, 'src/tiny.ts': 'export * from "./a.js";\n' });
    const fp = await computeSelfFingerprint({ root: dir });
    expect(Object.fromEntries(fp.files.map((f): [string, boolean] => [f.relPath, f.eligible]))).toEqual({
      'src/a.ts': true,
      'src/tiny.ts': false,
    });
  });

  it('refuses to arm without a src tree or a package root', async (): Promise<void> => {
    const { dir, cleanup } = await tempDir('fp-empty');
    cleanups.push(cleanup);
    await fakePackage(dir, {});
    await expect(computeSelfFingerprint({ root: dir })).rejects.toThrow(/source tree is the fingerprint/);
    await expect(locateSelfRoot(path.parse(dir).root)).rejects.toBeInstanceOf(ChainError);
  });
});
