import { randomUUID } from 'node:crypto';

import * as argon2 from 'argon2';

import { TooManyRequestsError } from '../errors/app-error.js';

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(hash: string, plain: string): Promise<boolean>;
  /** True when the stored hash was made with other parameters than the pinned ones (rehash on success, ADR 0009). */
  needsRehash(hash: string): boolean;
}

/**
 * argon2id with pinned parameters (ADR 0009, identical in all three projects): m=64 MiB, t=3, p=4, above the OWASP
 * minimum (m=19 MiB, t=2, p=1). Pinned explicitly so a library upgrade never silently changes the hashes.
 */
const ARGON2_OPTIONS = { type: argon2.argon2id, memoryCost: 65_536, timeCost: 3, parallelism: 4 } as const;

/** The unbounded argon2id backend. Use `createHasher()`, which bounds its concurrency, everywhere in the app. */
export const argon2Hasher: PasswordHasher = {
  hash: (plain) => argon2.hash(plain, ARGON2_OPTIONS),
  verify: (hash, plain) => argon2.verify(hash, plain),
  needsRehash: (hash) => argon2.needsRehash(hash, ARGON2_OPTIONS),
};

export interface HasherLimits {
  /** Hashes running at the same time. Each argon2 call holds 64 MiB, so 2 caps hashing memory at 128 MiB. */
  maxConcurrent: number;
  /** Calls that may wait for a slot; one more is rejected with the 429 page instead of piling up. */
  maxQueue: number;
}

/** ADR 0009: at most two hashes at once and 64 waiting; the container needs at least 384 MiB. */
const DEFAULT_LIMITS: HasherLimits = { maxConcurrent: 2, maxQueue: 64 };

/**
 * `Retry-After` of the 429 when the queue is full. A full queue drains within seconds (64 hashes at two at a time,
 * a few hundred milliseconds each), unlike a rate-limit window.
 */
const QUEUE_FULL_RETRY_AFTER_SECONDS = 5;

type Semaphore = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A counting semaphore with a bounded FIFO queue. A finishing task hands its slot directly to the next waiter, so
 * `active` never drops below the real number of running tasks and a newcomer can never overtake the queue.
 */
function createSemaphore({ maxConcurrent, maxQueue }: HasherLimits): Semaphore {
  let active = 0;
  const waiting: (() => void)[] = [];

  return async (task) => {
    if (active < maxConcurrent) {
      active++;
    } else if (waiting.length < maxQueue) {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
      });
    } else {
      throw new TooManyRequestsError({ retryAfterSeconds: QUEUE_FULL_RETRY_AFTER_SECONDS });
    }

    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next === undefined) active--;
      else next();
    }
  };
}

function assertLimits({ maxConcurrent, maxQueue }: HasherLimits): void {
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new RangeError('maxConcurrent must be a positive integer');
  }
  if (!Number.isSafeInteger(maxQueue) || maxQueue < 0) {
    throw new RangeError('maxQueue must be a non-negative integer');
  }
}

/**
 * The bounded hasher (ADR 0009): `hash` and `verify` (including the dummy-hash verify for unknown emails) share one
 * semaphore, so parallel auth requests from many IPs cannot push the container out of memory. A call that finds
 * `maxQueue` others waiting throws `TooManyRequestsError` (the 429 page). `needsRehash` only parses the hash string
 * and is not limited.
 *
 * Created once in `container.ts`; the backend is a parameter so the unit test can use a controllable fake.
 */
export function createHasher(
  limits: HasherLimits = DEFAULT_LIMITS,
  backend: PasswordHasher = argon2Hasher,
): PasswordHasher {
  assertLimits(limits);
  const limited = createSemaphore(limits);
  return {
    hash: (plain) => limited(() => backend.hash(plain)),
    verify: (hash, plain) => limited(() => backend.verify(hash, plain)),
    needsRehash: (hash) => backend.needsRehash(hash),
  };
}

/**
 * A hash of a random secret that nobody knows. Login verifies against it when the email is unknown, so "unknown
 * email" and "wrong password" take the same code path and time (F-24, B-09, B-23). Created once at startup.
 */
export function createTimingDummy(hasher: PasswordHasher): Promise<string> {
  return hasher.hash(randomUUID());
}
