import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalJson } from '../../src/shared/canonical-json.js';
import { ChainError, describeError } from '../../src/shared/errors.js';
import { HEX64, normalizeText, sha256Hex } from '../../src/shared/hash.js';
import { createLogger } from '../../src/shared/logger.js';
import { isWithin, toPosix } from '../../src/shared/paths.js';
import { wholeTextSpan } from '../../src/shared/span.js';

describe('hash', (): void => {
  it('sha256Hex matches the known digest of the empty string', (): void => {
    expect(sha256Hex('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('HEX64 rejects uppercase and a trailing newline', (): void => {
    const hex = sha256Hex('x');
    expect(HEX64.test(hex)).toBe(true);
    expect(HEX64.test(hex.toUpperCase())).toBe(false);
    expect(HEX64.test(`${hex}\n`)).toBe(false);
  });

  it('normalizeText folds CRLF and CR to LF and strips a BOM', (): void => {
    expect(normalizeText('\uFEFFa\r\nb\rc\n')).toBe('a\nb\nc\n');
    expect(sha256Hex(normalizeText('x\r\ny'))).toBe(sha256Hex('x\ny'));
  });
});

describe('canonicalJson', (): void => {
  it('sorts keys and emits no whitespace', (): void => {
    expect(canonicalJson({ b: 1, a: [true, null, 'x'], c: { z: 1, y: 2 } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":2,"z":1}}');
  });

  it('is independent of insertion order', (): void => {
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('refuses non-finite numbers', (): void => {
    expect((): unknown => canonicalJson({ n: Number.NaN })).toThrow(ChainError);
  });
});

describe('paths', (): void => {
  it('isWithin accepts the directory itself and its children only', (): void => {
    const root = path.resolve('/tmp/root');
    expect(isWithin(root, root)).toBe(true);
    expect(isWithin(path.join(root, 'a', 'b.ts'), root)).toBe(true);
    expect(isWithin(path.resolve('/tmp/rootling/x.ts'), root)).toBe(false);
    expect(isWithin(path.resolve('/tmp/x.ts'), root)).toBe(false);
  });

  it('toPosix uses forward slashes', (): void => {
    expect(toPosix(['a', 'b', 'c'].join(path.sep))).toBe('a/b/c');
  });
});

describe('span', (): void => {
  it('wholeTextSpan ends after the last character', (): void => {
    expect(wholeTextSpan('ab\ncd')).toEqual({ start: { line: 1, column: 1, offset: 0 }, end: { line: 2, column: 3, offset: 5 } });
  });
});

describe('logger and errors', (): void => {
  it('filters below the level and prefixes every line', (): void => {
    const lines: string[] = [];
    const logger = createLogger('info', (line: string): void => {
      lines.push(line);
    });
    logger.debug('hidden');
    logger.info('one\ntwo');
    expect(lines).toEqual(['[claudechain] info  one\n', '[claudechain] info  two\n']);
  });

  it('describeError keeps the ChainError code', (): void => {
    expect(describeError(new ChainError('E_QUERY', 'bad'))).toBe('E_QUERY: bad');
  });
});
