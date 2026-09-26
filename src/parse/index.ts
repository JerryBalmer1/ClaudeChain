import type { IngestedFile } from '../ingest/schema.js';
import type { ParsedModule } from './schema.js';
import { parseSource, type ParseSourceOptions } from './typescript.js';

export { isParsableLanguage, parseSource, syntaxKindName, type ParseSourceOptions } from './typescript.js';
export * from './schema.js';

/** Parse an ingested file, or return null when it has no text or is not a JS/TS language. */
export function parseIngestedFile(file: IngestedFile, options: ParseSourceOptions): ParsedModule | null {
  if (file.text === null) {
    return null;
  }
  return parseSource(file.relPath, file.text, file.language, options);
}
