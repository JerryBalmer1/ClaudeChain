import { z } from 'zod';

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);
export type LogLevel = z.infer<typeof LogLevelSchema>;
export type EmittingLevel = Exclude<LogLevel, 'silent'>;

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export interface LogRecord {
  readonly level: EmittingLevel;
  readonly message: string;
}

const RANK: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/** Human-readable lines to a sink (stderr in the CLI). Multi-line messages are prefixed per line. */
export function createLogger(level: LogLevel, write: (line: string) => void): Logger {
  const emit = (at: EmittingLevel, message: string): void => {
    if (RANK[at] < RANK[level]) {
      return;
    }
    const tag = `[claudechain] ${at.padEnd(5)} `;
    for (const line of message.split('\n')) {
      write(`${tag}${line}\n`);
    }
  };
  return {
    debug: (message: string): void => {
      emit('debug', message);
    },
    info: (message: string): void => {
      emit('info', message);
    },
    warn: (message: string): void => {
      emit('warn', message);
    },
    error: (message: string): void => {
      emit('error', message);
    },
  };
}

export const silentLogger: Logger = createLogger('silent', (): void => undefined);

/** A logger that keeps every record in memory. Used by tests to assert on exact output. */
export function createRecordingLogger(): Logger & { readonly records: LogRecord[] } {
  const records: LogRecord[] = [];
  return {
    records,
    debug: (message: string): void => {
      records.push({ level: 'debug', message });
    },
    info: (message: string): void => {
      records.push({ level: 'info', message });
    },
    warn: (message: string): void => {
      records.push({ level: 'warn', message });
    },
    error: (message: string): void => {
      records.push({ level: 'error', message });
    },
  };
}
