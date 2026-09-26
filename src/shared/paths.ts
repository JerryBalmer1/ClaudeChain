import { realpath } from 'node:fs/promises';
import path from 'node:path';

/** Native separators to forward slashes. Every path stored in a ChainObject is POSIX-style. */
export function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

/** Absolute, symlink-free, native-case path. The one form path comparisons are made in. */
export async function canonicalPath(p: string): Promise<string> {
  return realpath(path.resolve(p));
}

function comparable(p: string): string {
  const normalized = path.normalize(p);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function samePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b);
}

/** True when `child` is `parent` or lies beneath it. Both should already be canonical. */
export function isWithin(child: string, parent: string): boolean {
  const c = comparable(child);
  const p = comparable(parent);
  if (c === p) {
    return true;
  }
  const rel = path.relative(p, c);
  if (rel === '' || path.isAbsolute(rel)) {
    return false;
  }
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}
