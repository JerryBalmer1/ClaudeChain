/** Public API. Everything a library consumer needs; the CLI is a thin layer over the same surface. */
export {
  RABBIT_HOLE_MESSAGE,
  createSelfDetector,
  SelfReferenceMatchSchema,
  type DetectionMethod,
  type SelfDetector,
  type SelfReferenceMatch,
} from './ingest/detector.js';
export {
  computeSelfFingerprint,
  locateSelfRoot,
  MIN_CONTENT_MATCH_BYTES,
  SELF_PACKAGE_NAME,
  SelfFingerprintSchema,
  type SelfFingerprint,
} from './ingest/fingerprint.js';
export { DEFAULT_IGNORES, IngestedFileSchema, LanguageSchema, type IngestedFile, type Language } from './ingest/schema.js';
export { CodeGraph, type TraversalOptions, type TraversalResult, type TraversalStep } from './graph/graph.js';
export { linkGraph, type LinkStats } from './graph/link.js';
export * from './model/schema.js';
export { ids } from './model/ids.js';
export { ObjectStore } from './model/store.js';
export { parseSource, AstModeSchema, ParsedModuleSchema, type AstMode, type ParsedModule } from './parse/index.js';
export * from './query/index.js';
export { ChainError, type ChainErrorCode } from './shared/errors.js';
export { createLogger, createRecordingLogger, silentLogger, type Logger, type LogLevel } from './shared/logger.js';
export { SpanSchema, type Span } from './shared/span.js';
