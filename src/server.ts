import { createServer } from 'node:http';

import { createApp } from './app.js';
import { loadEnv, type Env } from './config/env.js';
import { createContainer } from './container.js';
import { createLogger } from './shared/logging/logger.js';

let env: Env;
try {
  env = loadEnv();
} catch (error) {
  // No logger exists without a valid configuration; the message names keys only, never values (F-72).
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}

const logger = createLogger(env);
const container = await createContainer(env, logger).catch((error: unknown) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});

let shuttingDown = false;
const app = createApp({ env, logger, ...container, isShuttingDown: () => shuttingDown });

/**
 * Slow-client limits, passed to the constructor because it validates them (`headersTimeout` must not exceed
 * `requestTimeout`; set as properties afterwards, a larger value is silently ineffective): the headers within 15 s,
 * the whole request within 30 s.
 */
const server = createServer({ headersTimeout: 15_000, requestTimeout: 30_000 }, app);
// Longer than the 60 s upstream keep-alive of common reverse proxies, so the proxy closes idle connections first and
// never reuses one the app has just closed (an intermittent 502). Idle sockets do not count against headersTimeout.
server.keepAliveTimeout = 65_000;
server.once('error', (error) => {
  logger.fatal({ err: error }, 'failed to start');
  process.exit(1);
});
server.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, 'listening');
});

/**
 * Graceful shutdown: fail readiness, stop accepting connections, let in-flight requests finish, then close the pools.
 * A hard timeout guarantees the process exits even if something hangs.
 *
 * `exitCode` 1 marks a crash, so a supervisor (`restart: on-failure`, systemd, an orchestrator) sees a failure and
 * restarts the app. A failure that arrives while a signal-initiated shutdown is already running still sets it.
 */
async function shutdown(reason: string, exitCode: 0 | 1): Promise<void> {
  if (exitCode !== 0) process.exitCode = exitCode;
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ reason }, 'shutting down');
  const force = setTimeout(() => {
    logger.error('forced exit after timeout');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.closeIdleConnections();
  await new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
  await container.dispose();
  logger.info('shutdown complete');
  process.exit();
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, (received) => void shutdown(received, 0));
}
process.on('unhandledRejection', (reason) => {
  logger.fatal({ err: reason }, 'unhandled rejection');
  void shutdown('unhandledRejection', 1);
});
// Observe only: Node still prints the error and exits 1, but the crash also reaches the structured log.
process.on('uncaughtExceptionMonitor', (error, origin) => {
  logger.fatal({ err: error, origin }, 'uncaught exception');
});
