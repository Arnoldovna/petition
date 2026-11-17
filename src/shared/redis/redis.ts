import type { Logger } from 'pino';
import { createClient } from 'redis';

/** Failed connection attempts after which startup gives up (about 3 s of backoff): a missing Redis fails fast. */
const STARTUP_RETRIES = 5;
const FIRST_DELAY_MS = 100;
const MAX_DELAY_MS = 3_000;
/** Per attempt; node-redis' default, stated so the startup budget above is visible in one place. */
const CONNECT_TIMEOUT_MS = 5_000;
/**
 * Per command, from the moment it is queued (node-redis 6 default, stated so the bound is visible): a command on a
 * connection that has stopped answering rejects after this time instead of holding its request indefinitely.
 */
const COMMAND_TIMEOUT_MS = 5_000;

/**
 * node-redis `reconnectStrategy`. The default strategy retries forever, so `connect()` never rejects and a missing
 * Redis hangs startup with an endless stream of error logs. Until the client has been ready once, this one gives up
 * after STARTUP_RETRIES (`connect()` then rejects and the process exits 1). Afterwards it retries forever with capped
 * exponential backoff: a Redis restart only fails readiness (`isReady` is false) until the client reconnects.
 *
 * @param retries 0 for the first failure of the current connection attempt
 * @returns the delay in ms before the next attempt, or an Error to stop
 */
export function reconnectDelay(retries: number, everReady: boolean, cause: Error): number | Error {
  if (!everReady && retries >= STARTUP_RETRIES) {
    return new Error(`redis: no connection after ${String(retries + 1)} attempts`, { cause });
  }
  return Math.min(FIRST_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
}

interface RedisClientOptions {
  url: string;
  /** Receives every connection error. Without an `error` listener, node-redis' first socket error ends the process. */
  logger: Pick<Logger, 'error'>;
}

/**
 * Created only by the composition root and the test harness; the caller connects and closes it.
 *
 * Every request touches Redis (the session store, the global limiter), so an outage must fail requests fast instead
 * of holding them: with `disableOfflineQueue`, a command sent while the client is reconnecting rejects at once, the
 * request ends on the 500 page and `/health/ready` reports 503. Without it, node-redis would queue the command until
 * the reconnect or the command timeout, one wait per Redis command of the request.
 */
export function createRedisClient({ url, logger }: RedisClientOptions) {
  let everReady = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    commandOptions: { timeout: COMMAND_TIMEOUT_MS },
    socket: {
      connectTimeout: CONNECT_TIMEOUT_MS,
      reconnectStrategy: (retries, cause) => reconnectDelay(retries, everReady, cause),
    },
  });
  client.on('ready', () => {
    everReady = true;
  });
  client.on('error', (error: unknown) => {
    logger.error({ err: error }, 'redis error');
  });
  return client;
}

/** The client type every consumer (session store, rate-limit stores, test harness) receives. */
export type RedisClient = ReturnType<typeof createRedisClient>;
