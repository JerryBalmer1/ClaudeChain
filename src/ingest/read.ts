import { readFile } from 'node:fs/promises';
import { ChainError } from '../shared/errors.js';
import { normalizeText, sha256Hex } from '../shared/hash.js';
import type { FileEntry } from './walk.js';
import { IngestedFileSchema, languageOf, type IngestedFile } from './schema.js';

/** Files larger than this are hashed but never decoded or parsed. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;

const BINARY_SNIFF_BYTES = 8000;

function looksBinary(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.byteLength, BINARY_SNIFF_BYTES);
  for (let i = 0; i < limit; i += 1) {
    if (bytes[i] === 0) {
      return true;
    }
  }
  return false;
}

/**
 * Read one walked file into its validated ingest form. Text files are hashed over their
 * normalized text; binary and oversized files over their raw bytes.
 */
export async function readIngestedFile(entry: FileEntry): Promise<IngestedFile> {
  let bytes: Buffer;
  try {
    bytes = await readFile(entry.absPath);
  } catch (cause: unknown) {
    throw new ChainError('E_IO', `cannot read file ${entry.absPath}`, { cause });
  }
  const base = {
    absPath: entry.absPath,
    relPath: entry.relPath,
    depth: entry.depth,
    size: bytes.byteLength,
    language: languageOf(entry.relPath),
  };
  if (bytes.byteLength > MAX_FILE_BYTES) {
    return IngestedFileSchema.parse({ ...base, contentHash: sha256Hex(bytes), text: null, skipped: 'too-large' });
  }
  if (looksBinary(bytes)) {
    return IngestedFileSchema.parse({ ...base, contentHash: sha256Hex(bytes), text: null, skipped: 'binary' });
  }
  const text = normalizeText(new TextDecoder('utf-8').decode(bytes));
  return IngestedFileSchema.parse({ ...base, contentHash: sha256Hex(text), text, skipped: null });
}
