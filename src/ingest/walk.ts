import type { Dirent } from 'node:fs';
import { readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { compareStrings } from '../shared/compare.js';
import { ChainError } from '../shared/errors.js';
import type { Logger } from '../shared/logger.js';

export interface WalkOptions {
  /** Deepest directory level entered. The root is level 0. Exceeding it yields a `limit` entry and stops. */
  readonly maxDepth: number;
  /** Directory names that are never entered. */
  readonly ignore: ReadonlySet<string>;
  readonly logger: Logger;
}

export interface FileEntry {
  readonly kind: 'file';
  readonly absPath: string;
  /** POSIX-style, relative to the walk root. */
  readonly relPath: string;
  /** Directory level of the containing directory. */
  readonly depth: number;
}

export interface DepthLimitEntry {
  readonly kind: 'limit';
  readonly relPath: string;
  readonly depth: number;
}

export type WalkEntry = FileEntry | DepthLimitEntry;

/**
 * Depth-first, deterministic walk: entries sorted by ordinal name, symlinks never followed,
 * every directory's real path visited at most once. It terminates on any tree, including one
 * with symlink cycles, and stops the moment the depth cap is exceeded.
 */
export async function* walkRepo(root: string, options: WalkOptions): AsyncGenerator<WalkEntry, void, undefined> {
  const visited = new Set<string>();
  yield* walkDirectory(root, '', 0, options, visited);
}

async function* walkDirectory(
  absDir: string,
  relDir: string,
  depth: number,
  options: WalkOptions,
  visited: Set<string>,
): AsyncGenerator<WalkEntry, boolean, undefined> {
  const real = await realpath(absDir);
  if (visited.has(real)) {
    options.logger.debug(`walk: already visited ${real}, skipping`);
    return false;
  }
  visited.add(real);

  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (cause: unknown) {
    throw new ChainError('E_IO', `cannot read directory ${absDir}`, { cause });
  }
  entries.sort((a: Dirent, b: Dirent): number => compareStrings(a.name, b.name));

  for (const entry of entries) {
    const relPath = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    const absPath = path.join(absDir, entry.name);
    if (entry.isSymbolicLink()) {
      options.logger.debug(`walk: symlink not followed: ${relPath}`);
      continue;
    }
    if (entry.isDirectory()) {
      if (options.ignore.has(entry.name)) {
        options.logger.debug(`walk: ignored directory ${relPath}`);
        continue;
      }
      const childDepth = depth + 1;
      if (childDepth > options.maxDepth) {
        yield { kind: 'limit', relPath, depth: childDepth };
        return true;
      }
      const stopped = yield* walkDirectory(absPath, relPath, childDepth, options, visited);
      if (stopped) {
        return true;
      }
      continue;
    }
    if (entry.isFile()) {
      yield { kind: 'file', absPath, relPath, depth };
    }
  }
  return false;
}
