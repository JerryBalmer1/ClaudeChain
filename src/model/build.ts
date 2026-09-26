import { isBuiltin } from 'node:module';
import type { IngestedFile } from '../ingest/schema.js';
import type { ParsedModule, RawSymbol } from '../parse/schema.js';
import { canonicalJson } from '../shared/canonical-json.js';
import { sha256Hex } from '../shared/hash.js';
import { EMPTY_SPAN, wholeTextSpan, type Span } from '../shared/span.js';
import { IdAllocator, ids } from './ids.js';
import {
  AstNodeSchema,
  CallEdgeSchema,
  ExportSchema,
  FileSchema,
  ImportSchema,
  ModuleSchema,
  RepoSchema,
  SymbolSchema,
  type AstNodeObject,
  type CallEdgeObject,
  type ExportObject,
  type FileObject,
  type ImportObject,
  type ModuleObject,
  type RepoObject,
  type SymbolObject,
} from './schema.js';

export interface RepoSummary {
  readonly name: string;
  /** Canonical absolute POSIX path. */
  readonly root: string;
  readonly fileHashes: readonly string[];
  readonly moduleCount: number;
}

/** The Repo object. Its hash is sha256 over the ordered file content hashes, so it changes when any file does. */
export function buildRepoObject(summary: RepoSummary): RepoObject {
  return RepoSchema.parse({
    id: ids.repo(summary.name),
    kind: 'Repo',
    hash: sha256Hex(summary.fileHashes.join('\n')),
    provenance: { file: '.', span: EMPTY_SPAN },
    name: summary.name,
    root: summary.root,
    fileCount: summary.fileHashes.length,
    moduleCount: summary.moduleCount,
  });
}

export function buildFileObject(file: IngestedFile, repoId: string): FileObject {
  return FileSchema.parse({
    id: ids.file(file.relPath),
    kind: 'File',
    hash: file.contentHash,
    provenance: { file: file.relPath, span: file.text === null ? EMPTY_SPAN : wholeTextSpan(file.text) },
    repoId,
    path: file.relPath,
    language: file.language,
    size: file.size,
    skipped: file.skipped,
  });
}

/** True for `./x`, `../x`, `.`, `..` and absolute paths; false for package and builtin specifiers. */
export function isRelativeSpecifier(specifier: string): boolean {
  return (
    specifier === '.' ||
    specifier === '..' ||
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/')
  );
}

/** Package name of a bare specifier: `@scope/pkg/deep` → `@scope/pkg`, `fs` → `node:fs`. */
export function packageNameOf(specifier: string): string {
  if (specifier.startsWith('node:')) {
    return specifier;
  }
  const segments = specifier.split('/');
  const head = segments[0] ?? specifier;
  const name = head.startsWith('@') && segments[1] !== undefined ? `${head}/${segments[1]}` : head;
  return isBuiltin(name) ? `node:${name}` : name;
}

export interface ModuleBuild {
  readonly module: ModuleObject;
  readonly symbols: readonly SymbolObject[];
  readonly imports: readonly ImportObject[];
  readonly exports: readonly ExportObject[];
  readonly calls: readonly CallEdgeObject[];
  readonly astNodes: readonly AstNodeObject[];
}

/**
 * Turn one parsed module into model objects. Everything knowable from this file alone is
 * filled in here (local export → symbol links, exported flags); cross-module references
 * (import resolution, re-exports, call targets) are left null for the graph layer.
 */
export function buildModuleObjects(file: FileObject, text: string, parsed: ParsedModule): ModuleBuild {
  const path = file.path;
  const moduleId = ids.module(path);
  const sliceHash = (span: Span): string => sha256Hex(text.slice(span.start.offset, span.end.offset));
  const allocator = new IdAllocator();

  const module = ModuleSchema.parse({
    id: moduleId,
    kind: 'Module',
    hash: file.hash,
    provenance: file.provenance,
    fileId: file.id,
    path,
    language: parsed.language,
    lineCount: parsed.lineCount,
  });

  const symbolIds = parsed.symbols.map((raw: RawSymbol): string =>
    allocator.allocate(ids.symbol(path, raw.qualifiedName), raw.span.start.offset),
  );
  const symbolIdAt = (index: number | null): string | null => (index === null ? null : (symbolIds[index] ?? null));

  const topLevelByName = new Map<string, string>();
  parsed.symbols.forEach((raw: RawSymbol, index: number): void => {
    const id = symbolIds[index];
    if (raw.parentIndex === null && id !== undefined && !topLevelByName.has(raw.name)) {
      topLevelByName.set(raw.name, id);
    }
  });

  const exports: ExportObject[] = parsed.exports.map((raw): ExportObject => {
    const local = raw.exportKind === 'declaration' || raw.exportKind === 'default' || raw.exportKind === 'named' || raw.exportKind === 'assignment';
    const symbolId = local && raw.localName !== null ? (topLevelByName.get(raw.localName) ?? null) : null;
    return ExportSchema.parse({
      id: allocator.allocate(ids.export(path, raw.name), raw.span.start.offset),
      kind: 'Export',
      hash: sliceHash(raw.span),
      provenance: { file: path, span: raw.span },
      moduleId,
      name: raw.name,
      localName: raw.localName,
      exportKind: raw.exportKind,
      source: raw.source,
      typeOnly: raw.typeOnly,
      symbolId,
    });
  });
  const exportedSymbolIds = new Set<string>();
  for (const exported of exports) {
    if (exported.symbolId !== null) {
      exportedSymbolIds.add(exported.symbolId);
    }
  }

  const symbols: SymbolObject[] = parsed.symbols.map((raw: RawSymbol, index: number): SymbolObject => {
    const id = symbolIds[index] ?? ids.symbol(path, raw.qualifiedName);
    return SymbolSchema.parse({
      id,
      kind: 'Symbol',
      hash: sliceHash(raw.span),
      provenance: { file: path, span: raw.span },
      moduleId,
      name: raw.name,
      qualifiedName: raw.qualifiedName,
      symbolKind: raw.symbolKind,
      parentId: symbolIdAt(raw.parentIndex),
      exported: raw.exportedByModifier || exportedSymbolIds.has(id),
      isDefault: raw.isDefault,
      signature: raw.signature,
    });
  });

  const imports: ImportObject[] = parsed.imports.map((raw): ImportObject => {
    const external = !isRelativeSpecifier(raw.specifier);
    return ImportSchema.parse({
      id: allocator.allocate(ids.import(path, raw.span.start.offset), raw.span.start.offset),
      kind: 'Import',
      hash: sliceHash(raw.span),
      provenance: { file: path, span: raw.span },
      moduleId,
      specifier: raw.specifier,
      importKind: raw.importKind,
      typeOnly: raw.typeOnly,
      names: raw.names,
      external,
      packageName: external ? packageNameOf(raw.specifier) : null,
      resolvedId: null,
    });
  });

  const calls: CallEdgeObject[] = parsed.calls.map((raw): CallEdgeObject =>
    CallEdgeSchema.parse({
      id: allocator.allocate(ids.call(path, raw.span.start.offset), raw.span.start.offset),
      kind: 'CallEdge',
      hash: sliceHash(raw.span),
      provenance: { file: path, span: raw.span },
      moduleId,
      from: symbolIdAt(raw.callerIndex) ?? moduleId,
      to: null,
      calleeText: raw.calleeText,
      calleeName: raw.calleeName,
      receiver: raw.receiver,
      isNew: raw.isNew,
      resolved: false,
    }),
  );

  const astIds: string[] = [];
  const astNodes: AstNodeObject[] = parsed.astNodes.map((raw): AstNodeObject => {
    const id = allocator.allocate(ids.ast(path, raw.span.start.offset, raw.span.end.offset, raw.nodeKind), raw.span.start.offset);
    astIds.push(id);
    return AstNodeSchema.parse({
      id,
      kind: 'AstNode',
      hash: sliceHash(raw.span),
      provenance: { file: path, span: raw.span },
      moduleId,
      nodeKind: raw.nodeKind,
      name: raw.name,
      parentId: raw.parentIndex === null ? null : (astIds[raw.parentIndex] ?? null),
      depth: raw.depth,
    });
  });

  return { module, symbols, imports, exports, calls, astNodes };
}

/** Content hash for an edge: canonical JSON of the fields that define it. */
export function edgeHash(fields: Readonly<Record<string, string | boolean | readonly string[]>>): string {
  return sha256Hex(canonicalJson(fields));
}
