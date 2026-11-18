import * as argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { TooManyRequestsError } from '../../errors/app-error.js';
import { argon2Hasher, createHasher, createTimingDummy, type PasswordHasher } from '../password.js';

/** A backend whose calls stay pending until the test releases them, so concurrency is observable. */
function createControlledBackend() {
  const pending: { label: string; release: () => void; fail: (error: Error) => void }[] = [];
  let running = 0;
  let maxRunning = 0;

  function call<T>(label: string, value: T): Promise<T> {
    running++;
    maxRunning = Math.max(maxRunning, running);
    return new Promise<T>((resolve, reject) => {
      pending.push({
        label,
        release: () => {
          running--;
          resolve(value);
        },
        fail: (error) => {
          running--;
          reject(error);
        },
      });
    });
  }

  const backend: PasswordHasher = {
    hash: (plain) => call(`hash:${plain}`, `hashed:${plain}`),
    verify: (hash, plain) => call(`verify:${plain}`, hash === `hashed:${plain}`),
    needsRehash: (hash) => !hash.startsWith('hashed:'),
  };

  return {
    backend,
    started: () => pending.map((entry) => entry.label),
    get running() {
      return running;
    },
    get maxRunning() {
      return maxRunning;
    },
    /** Settles the oldest started call. */
    releaseNext(): void {
      const entry = pending.shift();
      if (entry === undefined) throw new Error('nothing is running');
      entry.release();
    },
    failNext(error: Error): void {
      const entry = pending.shift();
      if (entry === undefined) throw new Error('nothing is running');
      entry.fail(error);
    },
  };
}

/** Lets pending promise callbacks (slot hand-over) run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('argon2Hasher (pinned parameters)', () => {
  it('F-27, ADR 0009: hashes with argon2id m=65536, t=3, p=4 and verifies only the right password', async () => {
    const hash = await argon2Hasher.hash('correct horse battery');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    expect(hash).not.toContain('correct horse battery');
    await expect(argon2Hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    await expect(argon2Hasher.verify(hash, 'correct horse batter')).resolves.toBe(false);
    expect(argon2Hasher.needsRehash(hash)).toBe(false);
  });

  it('ADR 0009: a hash made with weaker parameters needs a rehash', async () => {
    const weak = await argon2.hash('correct horse battery', {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });

    expect(argon2Hasher.needsRehash(weak)).toBe(true);
    await expect(argon2Hasher.verify(weak, 'correct horse battery')).resolves.toBe(true);
  });

  it('F-24, B-23: the timing dummy is a real argon2id hash that no submitted password matches', async () => {
    const dummy = await createTimingDummy(argon2Hasher);

    expect(dummy).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=4\$/);
    await expect(argon2Hasher.verify(dummy, '')).resolves.toBe(false);
    await expect(argon2Hasher.verify(dummy, 'password1234')).resolves.toBe(false);
  });
});

describe('createHasher (bounded concurrency)', () => {
  it('ADR 0009: a third concurrent call waits until one of the first two finishes', async () => {
    const control = createControlledBackend();
    const hasher = createHasher({ maxConcurrent: 2, maxQueue: 64 }, control.backend);

    const first = hasher.hash('a');
    const second = hasher.verify('hashed:b', 'b');
    const third = hasher.hash('c');
    await flush();

    expect(control.started()).toEqual(['hash:a', 'verify:b']);
    expect(control.running).toBe(2);

    control.releaseNext();
    await expect(first).resolves.toBe('hashed:a');
    await flush();
    expect(control.started()).toEqual(['verify:b', 'hash:c']);

    control.releaseNext();
    control.releaseNext();
    await expect(second).resolves.toBe(true);
    await expect(third).resolves.toBe('hashed:c');
    expect(control.maxRunning).toBe(2);
  });

  it('F-26, ADR 0009: with two running and 64 queued, the 65th queued call is rejected with a 429', async () => {
    const control = createControlledBackend();
    const hasher = createHasher({ maxConcurrent: 2, maxQueue: 64 }, control.backend);

    const accepted = Array.from({ length: 2 + 64 }, (_, index) => hasher.verify('hashed:x', String(index)));
    const rejected = hasher.verify('hashed:x', 'one too many');

    await expect(rejected).rejects.toBeInstanceOf(TooManyRequestsError);
    await expect(rejected).rejects.toMatchObject({ status: 429, retryAfterSeconds: 5 });

    // Draining the queue runs every accepted call, never more than two at a time.
    for (const _ of accepted) {
      await flush();
      control.releaseNext();
    }
    await expect(Promise.all(accepted)).resolves.toHaveLength(66);
    expect(control.maxRunning).toBe(2);
  });

  it('ADR 0009: queued calls run in arrival order (FIFO); a free slot is never taken by a newcomer', async () => {
    const control = createControlledBackend();
    const hasher = createHasher({ maxConcurrent: 1, maxQueue: 2 }, control.backend);

    const calls = [hasher.hash('1'), hasher.hash('2'), hasher.hash('3')];
    await flush();
    control.releaseNext(); // 1 finishes, its slot goes to 2
    await flush();
    const late = hasher.hash('4'); // arrives while 2 runs and 3 waits, so it queues behind 3
    await flush();
    control.releaseNext(); // 2
    await flush();
    control.releaseNext(); // 3
    await flush();

    expect(control.started()).toEqual(['hash:4']);
    control.releaseNext();
    await expect(Promise.all([...calls, late])).resolves.toEqual(['hashed:1', 'hashed:2', 'hashed:3', 'hashed:4']);
  });

  it('ADR 0009: a failing hash releases its slot for the next waiter and the error reaches the caller', async () => {
    const control = createControlledBackend();
    const hasher = createHasher({ maxConcurrent: 1, maxQueue: 1 }, control.backend);

    const failing = hasher.hash('broken');
    const waiting = hasher.hash('next');
    await flush();
    control.failNext(new Error('backend failed'));

    await expect(failing).rejects.toThrow('backend failed');
    await flush();
    expect(control.started()).toEqual(['hash:next']);
    control.releaseNext();
    await expect(waiting).resolves.toBe('hashed:next');
  });

  it('ADR 0009: a rejected call does not occupy a slot', async () => {
    const control = createControlledBackend();
    const hasher = createHasher({ maxConcurrent: 1, maxQueue: 0 }, control.backend);

    const running = hasher.hash('a');
    await expect(hasher.hash('b')).rejects.toBeInstanceOf(TooManyRequestsError);
    await flush();
    control.releaseNext();
    await expect(running).resolves.toBe('hashed:a');

    const after = hasher.hash('c');
    await flush();
    expect(control.started()).toEqual(['hash:c']);
    control.releaseNext();
    await expect(after).resolves.toBe('hashed:c');
  });

  it('ADR 0009: needsRehash is passed through without waiting for a slot', async () => {
    const control = createControlledBackend();
    const hasher = createHasher({ maxConcurrent: 1, maxQueue: 0 }, control.backend);

    const running = hasher.hash('a');
    expect(hasher.needsRehash('hashed:a')).toBe(false);
    expect(hasher.needsRehash('$argon2i$old')).toBe(true);
    await flush();
    control.releaseNext();
    await running;
  });

  it('ADR 0009: the default limits wrap the real argon2id backend', async () => {
    const hasher = createHasher();
    const hash = await hasher.hash('correct horse battery');

    await expect(hasher.verify(hash, 'correct horse battery')).resolves.toBe(true);
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it('rejects limits that would deadlock or make no sense', () => {
    expect(() => createHasher({ maxConcurrent: 0, maxQueue: 1 })).toThrow(RangeError);
    expect(() => createHasher({ maxConcurrent: 1.5, maxQueue: 1 })).toThrow(RangeError);
    expect(() => createHasher({ maxConcurrent: 1, maxQueue: -1 })).toThrow(RangeError);
  });
});
