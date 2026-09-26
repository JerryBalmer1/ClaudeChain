import { compareStrings } from './compare.js';
import { ChainError } from './errors.js';

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit, no whitespace, finite numbers only.
 * Hashes computed over this form are reproducible from any language that sorts keys the same way.
 */
export function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new ChainError('E_INVALID_INPUT', `canonicalJson: non-finite number ${String(value)}`);
    }
    return JSON.stringify(value);
  }
  if (isJsonArray(value)) {
    return `[${value.map((item: JsonValue): string => canonicalJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value).sort(compareStrings);
  const parts = keys.map((key: string): string => {
    const item = value[key];
    if (item === undefined) {
      throw new ChainError('E_INVALID_INPUT', `canonicalJson: key ${key} is undefined`);
    }
    return `${JSON.stringify(key)}:${canonicalJson(item)}`;
  });
  return `{${parts.join(',')}}`;
}
