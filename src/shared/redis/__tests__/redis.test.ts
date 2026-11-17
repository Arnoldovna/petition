import { createServer } from 'node:net';

import { describe, expect, it, vi } from 'vitest';

import { createRedisClient, reconnectDelay } from '../redis.js';

/** A local port nothing listens on: bind an ephemeral port, then release it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  if (address === null || typeof address === 'string') throw new Error('expected a TCP address');
  return address.port;
}

describe('reconnectDelay', () => {
  const cause = new Error('ECONNREFUSED');

  it('F-74: backs off exponentially from 100 ms and caps at 3 s', () => {
    expect([0, 1, 2, 3, 4].map((retries) => reconnectDelay(retries, true, cause))).toEqual([100, 200, 400, 800, 1600]);
    expect(reconnectDelay(5, true, cause)).toBe(3_000);
    expect(reconnectDelay(50, true, cause)).toBe(3_000);
  });

  it('F-74: gives up during startup after five retries and keeps the cause', () => {
    expect(reconnectDelay(4, false, cause)).toBe(1600);

    const stop = reconnectDelay(5, false, cause);

    expect(stop).toBeInstanceOf(Error);
    expect(stop).toHaveProperty('cause', cause);
  });

  it('F-74: never gives up once the client has been ready (a Redis restart only fails readiness)', () => {
    expect(reconnectDelay(1_000, true, cause)).toBe(3_000);
  });
});

describe('createRedisClient', () => {
  it('F-74: connect() rejects when Redis is unreachable instead of retrying forever, and logs each error', async () => {
    const logger = { error: vi.fn() };
    const client = createRedisClient({ url: `redis://127.0.0.1:${String(await closedPort())}`, logger });

    await expect(client.connect()).rejects.toThrow();

    expect(client.isOpen).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  }, 15_000);
});
