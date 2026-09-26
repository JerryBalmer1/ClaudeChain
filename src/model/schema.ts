import { z } from 'zod';
import { LanguageSchema, SkipReasonSchema } from '../ingest/schema.js';
import { ExportKindSchema, ImportedNameSchema, ImportKindSchema, SymbolKindSchema } from '../parse/schema.js';
import { Hex64Schema } from '../shared/hash.js';
import { SpanSchema } from '../shared/span.js';

/** Where an object came from: a POSIX path relative to the repo root, and a span in that file's normalized text. */
export const ProvenanceSchema = z.strictObject({
  file: z.string(),
  span: SpanSchema,
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

const base = {
  /** Stable, human-readable, deterministic across runs over identical content. See ids.ts. */
  id: z.string().min(1),
  /** sha256 of the object's content: its source slice, or canonical JSON for edges. */
  hash: Hex64Schema,
  provenance: ProvenanceSchema,
};

export const RepoSchema = z.strictObject({
  ...base,
  kind: z.literal('Repo'),
  name: z.string().min(1),
  /** Canonical absolute POSIX path at analysis time. Machine-specific by nature. */
  root: z.string().min(1),
  fileCount: z.int().min(0),
  moduleCount: z.int().min(0),
});

export const FileSchema = z.strictObject({
  ...base,
  kind: z.literal('File'),
  repoId: z.string().min(1),
  path: z.string().min(1),
  language: LanguageSchema,
  size: z.int().min(0),
  skipped: SkipReasonSchema.nullable(),
});

export const ModuleSchema = z.strictObject({
  ...base,
  kind: z.literal('Module'),
  fileId: z.string().min(1),
  path: z.string().min(1),
  language: LanguageSchema,
  lineCount: z.int().min(1),
});

export const SymbolSchema = z.strictObject({
  ...base,
  kind: z.literal('Symbol'),
  moduleId: z.string().min(1),
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  symbolKind: SymbolKindSchema,
  parentId: z.string().nullable(),
  exported: z.boolean(),
  isDefault: z.boolean(),
  signature: z.string(),
});

export const ImportSchema = z.strictObject({
  ...base,
  kind: z.literal('Import'),
  moduleId: z.string().min(1),
  specifier: z.string(),
  importKind: ImportKindSchema,
  typeOnly: z.boolean(),
  names: z.array(ImportedNameSchema),
  /** True for bare specifiers (packages, builtins); false for relative or absolute paths. */
  external: z.boolean(),
  /** `lodash`, `@scope/pkg`, `node:fs`; null for internal specifiers. */
  packageName: z.string().nullable(),
  /** Module (or File) id the specifier resolved to inside the repo; null when unresolved or external. */
  resolvedId: z.string().nullable(),
});

export const ExportSchema = z.strictObject({
  ...base,
  kind: z.literal('Export'),
  moduleId: z.string().min(1),
  name: z.string().min(1),
  localName: z.string().nullable(),
  exportKind: ExportKindSchema,
  source: z.string().nullable(),
  typeOnly: z.boolean(),
  /** The symbol this export ultimately names, following re-exports; null when it is not a symbol or unresolved. */
  symbolId: z.string().nullable(),
});

export const CallEdgeSchema = z.strictObject({
  ...base,
  kind: z.literal('CallEdge'),
  moduleId: z.string().min(1),
  /** Calling Symbol id, or the Module id for module-level code. */
  from: z.string().min(1),
  /** Called Symbol id; null when the callee could not be resolved syntactically. */
  to: z.string().nullable(),
  calleeText: z.string().min(1),
  calleeName: z.string().min(1),
  receiver: z.string().nullable(),
  isNew: z.boolean(),
  resolved: z.boolean(),
});

export const DependencyEdgeSchema = z.strictObject({
  ...base,
  kind: z.literal('DependencyEdge'),
  /** Importing Module id. */
  from: z.string().min(1),
  /** Module or File id inside the repo, or `pkg:<name>` for an external package. */
  to: z.string().min(1),
  external: z.boolean(),
  /** Every specifier that produced this edge, sorted. */
  specifiers: z.array(z.string()),
  importIds: z.array(z.string()),
  /** True when every contributing import is type-only. */
  typeOnly: z.boolean(),
});

export const AstNodeSchema = z.strictObject({
  ...base,
  kind: z.literal('AstNode'),
  moduleId: z.string().min(1),
  /** TypeScript SyntaxKind name, e.g. FunctionDeclaration. */
  nodeKind: z.string().min(1),
  name: z.string().nullable(),
  parentId: z.string().nullable(),
  depth: z.int().min(0),
});

export const OBJECT_KINDS = [
  'Repo',
  'File',
  'Module',
  'Symbol',
  'Import',
  'Export',
  'CallEdge',
  'DependencyEdge',
  'AstNode',
] as const;

export const ObjectKindSchema = z.enum(OBJECT_KINDS);
export type ObjectKind = z.infer<typeof ObjectKindSchema>;

export const ChainObjectSchema = z.discriminatedUnion('kind', [
  RepoSchema,
  FileSchema,
  ModuleSchema,
  SymbolSchema,
  ImportSchema,
  ExportSchema,
  CallEdgeSchema,
  DependencyEdgeSchema,
  AstNodeSchema,
]);

export const SCHEMA_BY_KIND = {
  Repo: RepoSchema,
  File: FileSchema,
  Module: ModuleSchema,
  Symbol: SymbolSchema,
  Import: ImportSchema,
  Export: ExportSchema,
  CallEdge: CallEdgeSchema,
  DependencyEdge: DependencyEdgeSchema,
  AstNode: AstNodeSchema,
} as const satisfies Record<ObjectKind, z.ZodType>;

export type RepoObject = z.infer<typeof RepoSchema>;
export type FileObject = z.infer<typeof FileSchema>;
export type ModuleObject = z.infer<typeof ModuleSchema>;
export type SymbolObject = z.infer<typeof SymbolSchema>;
export type ImportObject = z.infer<typeof ImportSchema>;
export type ExportObject = z.infer<typeof ExportSchema>;
export type CallEdgeObject = z.infer<typeof CallEdgeSchema>;
export type DependencyEdgeObject = z.infer<typeof DependencyEdgeSchema>;
export type AstNodeObject = z.infer<typeof AstNodeSchema>;
export type ChainObject = z.infer<typeof ChainObjectSchema>;

export type ObjectOfKind<K extends ObjectKind> = Extract<ChainObject, { kind: K }>;
