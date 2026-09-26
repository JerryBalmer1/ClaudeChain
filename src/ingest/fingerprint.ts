import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { canonicalJson } from '../shared/canonical-json.js';
import { ChainError } from '../shared/errors.js';
import { Hex64Schema, sha256Hex } from '../shared/hash.js';
import { silentLogger } from '../shared/logger.js';
import { canonicalPath, toPosix } from '../shared/paths.js';
import { readIngestedFile } from './read.js';
import { walkRepo } from './walk.js';

/** The package name ClaudeChain looks for when it goes hunting for its own root. */
export const SELF_PACKAGE_NAME = 'claudechain';

/**
 * Files shorter than this (normalized bytes) are fingerprinted but never used for content-hash
 * matching: a tiny re-export barrel is too generic to prove anything about where it came from.
 */
export const MIN_CONTENT_MATCH_BYTES = 256;

export const FingerprintFileSchema = z.strictObject({
  /** POSIX path relative to the package root, always starting with `src/`. */
  relPath: z.string().min(1),
  hash: Hex64Schema,
  size: z.int().min(0),
  eligible: z.boolean(),
});
export type FingerprintFile = z.infer<typeof FingerprintFileSchema>;

export const SelfFingerprintSchema = z.strictObject({
  packageName: z.string().min(1),
  version: z.string().min(1),
  /** Canonical absolute path of the package root. */
  root: z.string().min(1),
  /** Canonical absolute path of `<root>/src`. */
  srcRoot: z.string().min(1),
  /** sha256 over `relPath NUL hash LF` for every src file in ordinal order. */
  srcTreeHash: Hex64Schema,
  /** sha256 of canonical JSON {packageName, version, srcTreeHash}: the whole identity in one value. */
  fingerprintHash: Hex64Schema,
  files: z.array(FingerprintFileSchema),
});
export type SelfFingerprint = z.infer<typeof SelfFingerprintSchema>;

const PackageJsonSchema = z.object({ name: z.string(), version: z.string() });

async function readPackageJson(dir: string): Promise<z.infer<typeof PackageJsonSchema> | null> {
  let raw: string;
  try {
    raw = await readFile(path.join(dir, 'package.json'), 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = PackageJsonSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

/** Walk upward from `startDir` to the directory whose package.json is named `claudechain`. */
export async function locateSelfRoot(startDir: string): Promise<string> {
  let dir = path.resolve(startDir);
  for (;;) {
    const pkg = await readPackageJson(dir);
    if (pkg?.name === SELF_PACKAGE_NAME) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new ChainError(
        'E_FINGERPRINT',
        `cannot locate the ${SELF_PACKAGE_NAME} package root above ${startDir}; self-detection cannot be armed`,
      );
    }
    dir = parent;
  }
}

function moduleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
}

export interface FingerprintOptions {
  /** Package root to fingerprint. Defaults to the root this module was loaded from. */
  readonly root?: string;
}

/**
 * Compute ClaudeChain's own identity: package name, version and a content hash of `src/**`.
 * Throws E_FINGERPRINT rather than returning a partial fingerprint: a chain that cannot
 * recognise itself must not run.
 */
export async function computeSelfFingerprint(options: FingerprintOptions = {}): Promise<SelfFingerprint> {
  const located = options.root ?? (await locateSelfRoot(moduleDirectory()));
  const root = await canonicalPath(located);
  const pkg = await readPackageJson(root);
  if (pkg === null) {
    throw new ChainError('E_FINGERPRINT', `no readable package.json with name and version at ${root}`);
  }
  const srcRoot = path.join(root, 'src');
  const srcStat = await stat(srcRoot).catch((): null => null);
  if (srcStat === null || !srcStat.isDirectory()) {
    throw new ChainError('E_FINGERPRINT', `${srcRoot} is missing; the source tree is the fingerprint and it is gone`);
  }

  const files: FingerprintFile[] = [];
  for await (const entry of walkRepo(srcRoot, { maxDepth: 64, ignore: new Set<string>(), logger: silentLogger })) {
    if (entry.kind === 'limit') {
      throw new ChainError('E_FINGERPRINT', `src tree deeper than 64 levels at ${entry.relPath}`);
    }
    const file = await readIngestedFile(entry);
    const size = file.text === null ? file.size : Buffer.byteLength(file.text, 'utf8');
    files.push({
      relPath: `src/${toPosix(entry.relPath)}`,
      hash: file.contentHash,
      size,
      eligible: file.text !== null && size >= MIN_CONTENT_MATCH_BYTES,
    });
  }
  if (files.length === 0) {
    throw new ChainError('E_FINGERPRINT', `${srcRoot} contains no files`);
  }

  const srcTreeHash = sha256Hex(files.map((f: FingerprintFile): string => `${f.relPath}\u0000${f.hash}\n`).join(''));
  const fingerprintHash = sha256Hex(canonicalJson({ packageName: pkg.name, version: pkg.version, srcTreeHash }));
  return SelfFingerprintSchema.parse({
    packageName: pkg.name,
    version: pkg.version,
    root,
    srcRoot: await canonicalPath(srcRoot),
    srcTreeHash,
    fingerprintHash,
    files,
  });
}
