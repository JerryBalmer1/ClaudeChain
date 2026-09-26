import path from 'node:path';
import { z } from 'zod';
import { Hex64Schema } from '../shared/hash.js';
import { isWithin, toPosix } from '../shared/paths.js';
import type { SelfFingerprint } from './fingerprint.js';
import type { IngestedFile } from './schema.js';

/** The exact line logged when the chain finds itself. Tests assert on this string byte for byte. */
export const RABBIT_HOLE_MESSAGE = "I've reached the bottom of the rabbit hole.";

export const DetectionMethodSchema = z.enum(['root', 'content-hash']);
export type DetectionMethod = z.infer<typeof DetectionMethodSchema>;

export const SelfReferenceMatchSchema = z.strictObject({
  method: DetectionMethodSchema,
  /** Absolute POSIX path of the ingested file that matched. */
  matchedPath: z.string().min(1),
  /** The same file relative to the target root. */
  relPath: z.string().min(1),
  /** Content hash of the matched file. */
  hash: Hex64Schema,
  /** The ClaudeChain source file it matched, relative to the ClaudeChain package root. */
  selfFile: z.string().min(1),
});
export type SelfReferenceMatch = z.infer<typeof SelfReferenceMatchSchema>;

export interface SelfDetector {
  /** Null when the file is not ClaudeChain's own source; the match otherwise. */
  check(file: IngestedFile): SelfReferenceMatch | null;
}

/**
 * Two checks, in order:
 *  1. root: the file's canonical path lies inside ClaudeChain's own canonical `src/`.
 *  2. content-hash: the file's normalized content hash equals an eligible ClaudeChain source
 *     file, which catches copied or vendored ClaudeChain source anywhere in the target.
 */
export function createSelfDetector(fingerprint: SelfFingerprint): SelfDetector {
  const byHash = new Map<string, string>();
  for (const file of fingerprint.files) {
    if (file.eligible && !byHash.has(file.hash)) {
      byHash.set(file.hash, file.relPath);
    }
  }
  return {
    check(file: IngestedFile): SelfReferenceMatch | null {
      if (isWithin(file.absPath, fingerprint.srcRoot)) {
        return {
          method: 'root',
          matchedPath: toPosix(file.absPath),
          relPath: file.relPath,
          hash: file.contentHash,
          selfFile: `src/${toPosix(path.relative(fingerprint.srcRoot, file.absPath))}`,
        };
      }
      const selfFile = byHash.get(file.contentHash);
      if (selfFile !== undefined) {
        return {
          method: 'content-hash',
          matchedPath: toPosix(file.absPath),
          relPath: file.relPath,
          hash: file.contentHash,
          selfFile,
        };
      }
      return null;
    },
  };
}
