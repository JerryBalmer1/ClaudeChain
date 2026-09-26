import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * 64 lowercase hex characters and nothing else. In JavaScript `$` without the `m` flag
 * matches only at the true end of input, so a trailing newline cannot sneak through.
 */
export const HEX64 = /^[0-9a-f]{64}$/;

export const Hex64Schema = z.string().regex(HEX64, 'expected 64 lowercase hex characters');

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * The text form every content hash is computed over: BOM stripped, CRLF and lone CR
 * folded to LF. A file checked out with autocrlf hashes the same as the committed bytes.
 */
export function normalizeText(text: string): string {
  const withoutBom = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return withoutBom.replace(/\r\n?/g, '\n');
}
