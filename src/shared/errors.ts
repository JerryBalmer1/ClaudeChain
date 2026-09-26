/** Every failure ClaudeChain raises carries one of these codes. Nothing is thrown bare. */
export type ChainErrorCode =
  | 'E_TARGET_NOT_FOUND'
  | 'E_NOT_A_DIRECTORY'
  | 'E_FINGERPRINT'
  | 'E_IO'
  | 'E_INVALID_INPUT'
  | 'E_DUPLICATE_ID'
  | 'E_UNKNOWN_ID'
  | 'E_QUERY'
  | 'E_SNAPSHOT'
  | 'E_USAGE';

export class ChainError extends Error {
  public readonly code: ChainErrorCode;

  public constructor(code: ChainErrorCode, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'ChainError';
    this.code = code;
  }
}

export function isChainError(value: unknown): value is ChainError {
  return value instanceof ChainError;
}

/** Render any thrown value as one line, without losing the ChainError code. */
export function describeError(value: unknown): string {
  if (value instanceof ChainError) {
    return `${value.code}: ${value.message}`;
  }
  if (value instanceof Error) {
    return `${value.name}: ${value.message}`;
  }
  return String(value);
}
