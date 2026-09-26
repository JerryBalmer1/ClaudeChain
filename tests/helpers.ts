import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSelfFingerprint, type SelfFingerprint } from '../src/ingest/fingerprint.js';
import { IngestedFileSchema, languageOf, type IngestedFile } from '../src/ingest/schema.js';
import { linkGraph } from '../src/graph/link.js';
import { buildFileObject, buildModuleObjects, buildRepoObject } from '../src/model/build.js';
import { ObjectStore } from '../src/model/store.js';
import { parseSource } from '../src/parse/typescript.js';
import { Chain } from '../src/query/chain.js';
import { normalizeText, sha256Hex } from '../src/shared/hash.js';

export const REPO_ROOT: string = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_ROOT: string = path.join(REPO_ROOT, 'tests', 'fixtures', 'sample-repo');

let cachedFingerprint: Promise<SelfFingerprint> | null = null;

/** ClaudeChain's own fingerprint, computed once per test file. */
export function selfFingerprint(): Promise<SelfFingerprint> {
  cachedFingerprint ??= computeSelfFingerprint({ root: REPO_ROOT });
  return cachedFingerprint;
}

/** A temp directory that the returned cleanup removes. */
export async function tempDir(prefix: string): Promise<{ readonly dir: string; readonly cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), `claudechain-${prefix}-`));
  return {
    dir,
    cleanup: async (): Promise<void> => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** An in-memory ingested file, as if walked from `/virtual`. */
export function virtualFile(relPath: string, content: string): IngestedFile {
  const text = normalizeText(content);
  return IngestedFileSchema.parse({
    absPath: `/virtual/${relPath}`,
    relPath,
    depth: relPath.split('/').length - 1,
    size: Buffer.byteLength(text, 'utf8'),
    contentHash: sha256Hex(text),
    language: languageOf(relPath),
    text,
    skipped: null,
  });
}

/** Build and link a store from in-memory sources, bypassing the walker. */
export function storeFromSources(sources: Readonly<Record<string, string>>): ObjectStore {
  const store = new ObjectStore();
  const repo = buildRepoObject({ name: 'virtual', root: '/virtual', fileHashes: [], moduleCount: 0 });
  store.add(repo);
  for (const [relPath, content] of Object.entries(sources)) {
    const ingested = virtualFile(relPath, content);
    const file = buildFileObject(ingested, repo.id);
    store.add(file);
    const text = ingested.text ?? '';
    const parsed = parseSource(relPath, text, ingested.language, { astMode: 'declarations' });
    if (parsed !== null) {
      const built = buildModuleObjects(file, text, parsed);
      store.add(built.module);
      for (const object of [...built.symbols, ...built.imports, ...built.exports, ...built.calls, ...built.astNodes]) {
        store.add(object);
      }
    }
  }
  linkGraph(store);
  return store;
}

export function chainFromSources(sources: Readonly<Record<string, string>>): Chain {
  return new Chain(storeFromSources(sources));
}
