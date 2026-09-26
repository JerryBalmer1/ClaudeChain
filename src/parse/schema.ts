import { z } from 'zod';
import { LanguageSchema } from '../ingest/schema.js';
import { SpanSchema } from '../shared/span.js';

export const AstModeSchema = z.enum(['declarations', 'full']);
export type AstMode = z.infer<typeof AstModeSchema>;

export const SymbolKindSchema = z.enum([
  'function',
  'class',
  'method',
  'constructor',
  'accessor',
  'property',
  'const',
  'let',
  'var',
  'interface',
  'type',
  'enum',
  'namespace',
]);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

const index = z.int().min(0);

export const RawSymbolSchema = z.strictObject({
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  symbolKind: SymbolKindSchema,
  /** Index into `symbols` of the enclosing symbol, or null at module level. */
  parentIndex: index.nullable(),
  /** True when the declaration carries an `export` modifier at module level. */
  exportedByModifier: z.boolean(),
  isDefault: z.boolean(),
  signature: z.string(),
  span: SpanSchema,
});
export type RawSymbol = z.infer<typeof RawSymbolSchema>;

export const ImportKindSchema = z.enum(['static', 'dynamic', 'require', 'reexport', 'import-equals']);
export type ImportKind = z.infer<typeof ImportKindSchema>;

/** `imported` is the name in the source module: an identifier, `default`, or `*` for a namespace. */
export const ImportedNameSchema = z.strictObject({
  imported: z.string().min(1),
  local: z.string().min(1),
});
export type ImportedName = z.infer<typeof ImportedNameSchema>;

export const RawImportSchema = z.strictObject({
  specifier: z.string(),
  importKind: ImportKindSchema,
  typeOnly: z.boolean(),
  names: z.array(ImportedNameSchema),
  span: SpanSchema,
});
export type RawImport = z.infer<typeof RawImportSchema>;

export const ExportKindSchema = z.enum([
  'declaration',
  'default',
  'named',
  'reexport',
  'namespace-reexport',
  'star',
  'assignment',
]);
export type ExportKind = z.infer<typeof ExportKindSchema>;

export const RawExportSchema = z.strictObject({
  /** Name visible to importers: an identifier, `default`, `*` for `export *`, or `export=`. */
  name: z.string().min(1),
  /** Local binding (or, for re-exports, the name in the source module). Null when anonymous. */
  localName: z.string().nullable(),
  exportKind: ExportKindSchema,
  /** Module specifier for re-exports, null otherwise. */
  source: z.string().nullable(),
  typeOnly: z.boolean(),
  span: SpanSchema,
});
export type RawExport = z.infer<typeof RawExportSchema>;

export const RawCallSchema = z.strictObject({
  /** Index into `symbols` of the innermost enclosing symbol, or null for module-level code. */
  callerIndex: index.nullable(),
  /** The callee expression as written, e.g. `upper`, `this.log`, `ops.double`. */
  calleeText: z.string().min(1),
  /** Last identifier of the callee, e.g. `double` for `ops.double`. */
  calleeName: z.string().min(1),
  /** Root of a property-access callee (`this`, `ops`), null for a bare identifier. */
  receiver: z.string().nullable(),
  isNew: z.boolean(),
  span: SpanSchema,
});
export type RawCall = z.infer<typeof RawCallSchema>;

export const RawAstNodeSchema = z.strictObject({
  nodeKind: z.string().min(1),
  name: z.string().nullable(),
  parentIndex: index.nullable(),
  depth: z.int().min(0),
  span: SpanSchema,
});
export type RawAstNode = z.infer<typeof RawAstNodeSchema>;

export const ParsedModuleSchema = z.strictObject({
  relPath: z.string().min(1),
  language: LanguageSchema,
  lineCount: z.int().min(1),
  symbols: z.array(RawSymbolSchema),
  imports: z.array(RawImportSchema),
  exports: z.array(RawExportSchema),
  calls: z.array(RawCallSchema),
  astNodes: z.array(RawAstNodeSchema),
});
export type ParsedModule = z.infer<typeof ParsedModuleSchema>;
