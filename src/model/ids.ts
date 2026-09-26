/**
 * Stable IDs. Every ID is a pure function of repo-relative path plus a name or an offset,
 * so two runs over identical content produce identical IDs on any machine.
 *
 *   repo:<basename>                      file:<path>              module:<path>
 *   symbol:<path>#<qualifiedName>        import:<path>@<offset>   export:<path>#<name>
 *   call:<path>@<offset>                 dep:<fromPath>-><toPath | pkg:name>
 *   ast:<path>@<start>-<end>#<SyntaxKind>                       pkg:<packageName>
 *
 * A collision inside one module (overloads that survive, duplicate declarations) gets `~<offset>` appended.
 */
export const ids = {
  repo: (name: string): string => `repo:${name}`,
  file: (path: string): string => `file:${path}`,
  module: (path: string): string => `module:${path}`,
  symbol: (path: string, qualifiedName: string): string => `symbol:${path}#${qualifiedName}`,
  import: (path: string, offset: number): string => `import:${path}@${offset}`,
  export: (path: string, name: string): string => `export:${path}#${name}`,
  call: (path: string, offset: number): string => `call:${path}@${offset}`,
  dependency: (fromPath: string, toKey: string): string => `dep:${fromPath}->${toKey}`,
  ast: (path: string, start: number, end: number, nodeKind: string): string => `ast:${path}@${start}-${end}#${nodeKind}`,
  package: (name: string): string => `pkg:${name}`,
} as const;

/** Hands out IDs, disambiguating repeats deterministically by source offset. */
export class IdAllocator {
  private readonly used = new Set<string>();

  public allocate(candidate: string, offset: number): string {
    if (!this.used.has(candidate)) {
      this.used.add(candidate);
      return candidate;
    }
    let attempt = `${candidate}~${offset}`;
    let n = 1;
    while (this.used.has(attempt)) {
      n += 1;
      attempt = `${candidate}~${offset}.${n}`;
    }
    this.used.add(attempt);
    return attempt;
  }
}

/** The path portion of a module/file ID, or null when the ID is not one. */
export function pathOfId(id: string): string | null {
  if (id.startsWith('module:')) {
    return id.slice('module:'.length);
  }
  if (id.startsWith('file:')) {
    return id.slice('file:'.length);
  }
  return null;
}
