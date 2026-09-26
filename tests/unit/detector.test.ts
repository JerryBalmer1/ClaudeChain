import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSelfDetector, RABBIT_HOLE_MESSAGE, type SelfDetector } from '../../src/ingest/detector.js';
import { computeSelfFingerprint, MIN_CONTENT_MATCH_BYTES, SELF_PACKAGE_NAME } from '../../src/ingest/fingerprint.js';
import { readIngestedFile } from '../../src/ingest/read.js';
import type { IngestedFile } from '../../src/ingest/schema.js';
import { canonicalPath } from '../../src/shared/paths.js';
import { tempDir } from '../helpers.js';

const BODY = `export function detectMe(): string {\n  return '${'y'.repeat(MIN_CONTENT_MATCH_BYTES)}';\n}\n`;

describe('self-reference detector', (): void => {
  let selfRoot = '';
  let targetRoot = '';
  let detector: SelfDetector;
  const cleanups: (() => Promise<void>)[] = [];

  const ingest = async (root: string, rel: string, content: string): Promise<IngestedFile> => {
    const abs = path.join(root, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
    return readIngestedFile({ kind: 'file', absPath: abs, relPath: rel, depth: rel.split('/').length - 1 });
  };

  beforeAll(async (): Promise<void> => {
    const self = await tempDir('det-self');
    const target = await tempDir('det-target');
    cleanups.push(self.cleanup, target.cleanup);
    selfRoot = await canonicalPath(self.dir);
    targetRoot = await canonicalPath(target.dir);
    await writeFile(path.join(selfRoot, 'package.json'), JSON.stringify({ name: SELF_PACKAGE_NAME, version: '0.0.1' }));
    await mkdir(path.join(selfRoot, 'src'), { recursive: true });
    await writeFile(path.join(selfRoot, 'src', 'core.ts'), BODY);
    await writeFile(path.join(selfRoot, 'src', 'tiny.ts'), 'export {};\n');
    detector = createSelfDetector(await computeSelfFingerprint({ root: selfRoot }));
  });

  afterAll(async (): Promise<void> => {
    for (const cleanup of cleanups) {
      await cleanup();
    }
  });

  it('the message is exact', (): void => {
    expect(RABBIT_HOLE_MESSAGE).toBe("I've reached the bottom of the rabbit hole.");
  });

  it('method root: any file inside its own canonical src/ matches, even with new content', async (): Promise<void> => {
    const file = await ingest(selfRoot, 'src/brand-new.ts', 'export const fresh = true;\n');
    expect(detector.check(file)).toMatchObject({ method: 'root', selfFile: 'src/brand-new.ts', hash: file.contentHash });
  });

  it('method root beats content-hash when both apply', async (): Promise<void> => {
    const file = await readIngestedFile({ kind: 'file', absPath: path.join(selfRoot, 'src', 'core.ts'), relPath: 'src/core.ts', depth: 1 });
    expect(detector.check(file)?.method).toBe('root');
  });

  it('files outside src/ in its own root are not self-source', async (): Promise<void> => {
    const file = await readIngestedFile({ kind: 'file', absPath: path.join(selfRoot, 'package.json'), relPath: 'package.json', depth: 0 });
    expect(detector.check(file)).toBeNull();
  });

  it('method content-hash: a vendored copy anywhere else matches', async (): Promise<void> => {
    const file = await ingest(targetRoot, 'vendor/claudechain/core.ts', BODY);
    expect(detector.check(file)).toMatchObject({ method: 'content-hash', relPath: 'vendor/claudechain/core.ts', selfFile: 'src/core.ts' });
  });

  it('content-hash survives CRLF line endings and a BOM', async (): Promise<void> => {
    const file = await ingest(targetRoot, 'copied/core.ts', `\uFEFF${BODY.replace(/\n/g, '\r\n')}`);
    expect(detector.check(file)?.method).toBe('content-hash');
  });

  it('a one-byte change is not a match', async (): Promise<void> => {
    const file = await ingest(targetRoot, 'near/core.ts', BODY.replace('detectMe', 'detectMf'));
    expect(detector.check(file)).toBeNull();
  });

  it('tiny files are never matched by content', async (): Promise<void> => {
    const file = await ingest(targetRoot, 'other/tiny.ts', 'export {};\n');
    expect(detector.check(file)).toBeNull();
  });
});
