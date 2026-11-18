import { Writable } from 'node:stream';

import type { Logger } from 'pino';

import { createLogger } from '../src/shared/logging/logger.js';

type LogEntry = Record<string, unknown>;

export interface CapturedLog {
  /** An `info` logger that writes JSON lines into memory instead of stdout. */
  logger: Logger;
  /** Every parsed line with this `msg`, e.g. `user.logged_in`. */
  events(msg: string): LogEntry[];
  /** The raw output, to assert that no personal data appears anywhere. */
  raw(): string;
  /** Forgets the lines so far, so a test asserts only on what its own requests logged. */
  clear(): void;
}

/** A logger for tests that assert on log events (ADR 0011, B-12). */
export function captureLog(): CapturedLog {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      lines.push(...chunk.toString('utf8').split('\n').filter(Boolean));
      callback();
    },
  });
  return {
    logger: createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'test' }, destination),
    events: (msg) => lines.map((line) => JSON.parse(line) as LogEntry).filter((entry) => entry['msg'] === msg),
    raw: () => lines.join('\n'),
    clear: () => {
      lines.length = 0;
    },
  };
}
