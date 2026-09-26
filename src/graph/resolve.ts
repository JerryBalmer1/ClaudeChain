import path from 'node:path';

const SOURCE_EXTENSIONS: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.d.ts', '.js', '.jsx', '.mjs', '.cjs', '.json'];

/** NodeNext-style `.js` specifiers that name a TypeScript source. */
const EMITTED_TO_SOURCE: Readonly<Record<string, readonly string[]>> = {
  '.js': ['.ts', '.tsx', '.d.ts'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/**
 * Candidate repo paths a relative specifier may refer to, in resolution order:
 * the exact path, the TypeScript source behind an emitted extension, the path plus
 * each extension, then an index file in the directory.
 */
export function candidatePaths(fromPath: string, specifier: string): string[] {
  const joined = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  if (joined === '..' || joined.startsWith('../') || path.posix.isAbsolute(joined)) {
    return [];
  }
  const base = joined.endsWith('/') ? joined.slice(0, -1) : joined;
  const out: string[] = [base];
  const ext = path.posix.extname(base);
  const sources = EMITTED_TO_SOURCE[ext];
  if (sources !== undefined) {
    const stem = base.slice(0, -ext.length);
    for (const source of sources) {
      out.push(`${stem}${source}`);
    }
  }
  for (const extension of SOURCE_EXTENSIONS) {
    out.push(`${base}${extension}`);
  }
  for (const extension of SOURCE_EXTENSIONS) {
    out.push(`${base === '.' ? '' : `${base}/`}index${extension}`);
  }
  return out;
}

/**
 * Resolve a relative specifier against the repo's known paths. `targets` maps a repo path to the
 * object id it resolves to (Module ids preferred over File ids by the caller). Syntactic only:
 * tsconfig `paths`, package `exports` and symlinked workspaces are not consulted.
 */
export function resolveRelativeSpecifier(
  fromPath: string,
  specifier: string,
  targets: ReadonlyMap<string, string>,
): string | null {
  for (const candidate of candidatePaths(fromPath, specifier)) {
    const hit = targets.get(candidate);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}
