import path from 'node:path';
import { z } from 'zod';
import { Hex64Schema } from '../shared/hash.js';

export const LanguageSchema = z.enum(['typescript', 'tsx', 'javascript', 'jsx', 'json', 'markdown', 'yaml', 'other']);
export type Language = z.infer<typeof LanguageSchema>;

export const SkipReasonSchema = z.enum(['binary', 'too-large']);
export type SkipReason = z.infer<typeof SkipReasonSchema>;

/** One file as it leaves the ingest layer. `text` is normalized (see normalizeText) or null when skipped. */
export const IngestedFileSchema = z.strictObject({
  absPath: z.string().min(1),
  relPath: z.string().min(1),
  depth: z.int().min(0),
  size: z.int().min(0),
  contentHash: Hex64Schema,
  language: LanguageSchema,
  text: z.string().nullable(),
  skipped: SkipReasonSchema.nullable(),
});
export type IngestedFile = z.infer<typeof IngestedFileSchema>;

const EXTENSION_LANGUAGE: Readonly<Record<string, Language>> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.json': 'json',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.yml': 'yaml',
  '.yaml': 'yaml',
};

export function languageOf(relPath: string): Language {
  return EXTENSION_LANGUAGE[path.posix.extname(relPath).toLowerCase()] ?? 'other';
}

/** Directory names never descended into. Matched against a single path segment, not a glob. */
export const DEFAULT_IGNORES: readonly string[] = [
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'coverage',
  '.claudechain',
  '.next',
  '.turbo',
  '.cache',
];
