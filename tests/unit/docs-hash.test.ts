import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeText, sha256Hex } from '../../src/shared/hash.js';
import { REPO_ROOT } from '../helpers.js';

/** Hashed docs: `<name>.sha256` next to `<name>.md`, in sha256sum format (`<hex>  <repo-relative path>`). */
const HASHED_DOCS: readonly string[] = ['docs/GROK_CONVO.md'];

describe('hashed docs', (): void => {
  for (const doc of HASHED_DOCS) {
    it(`${doc} matches its recorded sha256`, async (): Promise<void> => {
      const recordPath = path.join(REPO_ROOT, doc.replace(/\.md$/, '.sha256'));
      const record = (await readFile(recordPath, 'utf8')).trim();
      const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(record);
      expect(match, `${recordPath} must be "<sha256>  <path>"`).not.toBeNull();
      expect(match?.[2]).toBe(doc);
      const bytes = await readFile(path.join(REPO_ROOT, doc));
      const text = bytes.toString('utf8');
      expect(normalizeText(text), `${doc} must be LF-only with no BOM`).toBe(text);
      expect(sha256Hex(bytes)).toBe(match?.[1]);
    });
  }
});
