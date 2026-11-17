import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isSecretKey, mergeEnv, parseEnv, setupEnv } from '../setup-env.mjs';

const EXAMPLE = readFileSync(resolve(import.meta.dirname, '../../.env.example'), 'utf8');

let counter = 0;
const fakeSecret = () => `generated-${String((counter += 1))}`;

describe('setup-env', () => {
  it('F-72, B-03: treats only SECRET and PASSWORD as whole words as secrets', () => {
    expect(
      ['SESSION_SECRET', 'CSRF_SECRET', 'SEED_DEMO_PASSWORD', 'POSTGRES_PASSWORD', 'SECRET'].map(isSecretKey),
    ).toEqual([true, true, true, true, true]);
    expect(['SECRETARY', 'PASSWORDLESS_MODE', 'DATABASE_URL', 'MY_SECRETS'].map(isSecretKey)).toEqual([
      false,
      false,
      false,
      false,
    ]);
  });

  it('F-72, B-03: a new .env generates exactly SESSION_SECRET, CSRF_SECRET and SEED_DEMO_PASSWORD', () => {
    const result = mergeEnv({ current: null, example: EXAMPLE, generate: fakeSecret });

    expect(result.created).toBe(true);
    expect(result.generated).toEqual(['SESSION_SECRET', 'CSRF_SECRET', 'SEED_DEMO_PASSWORD']);
    const env = parseEnv(result.text);
    for (const key of result.generated) expect(env.get(key)).toMatch(/^generated-\d+$/);
    // fixed local value, never generated (ADR 0019 section 7)
    expect(env.get('POSTGRES_PASSWORD')).toBe('local-only');
    // comments and order of the example survive
    expect(result.text.split('\n').filter((line) => line.startsWith('#'))).toEqual(
      EXAMPLE.split('\n').filter((line) => line.startsWith('#')),
    );
  });

  it('F-72: never overwrites a value, adds missing keys with their comment and fills empty secrets only', () => {
    const example = ['# the port', 'PORT=3000', '', '# signs cookies', 'SESSION_SECRET=', 'CSRF_SECRET=', ''].join(
      '\n',
    );
    const current = ['PORT=4000', 'SESSION_SECRET=keep-me', 'CSRF_SECRET=""', ''].join('\n');

    const result = mergeEnv({ current, example, generate: () => 'new-secret' });

    expect(result.created).toBe(false);
    expect(result.added).toEqual([]);
    expect(result.generated).toEqual(['CSRF_SECRET']);
    expect(result.text).toBe(['PORT=4000', 'SESSION_SECRET=keep-me', 'CSRF_SECRET=new-secret', ''].join('\n'));

    const partial = mergeEnv({ current: 'PORT=4000\n', example, generate: () => 'new-secret' });
    expect(partial.added).toEqual(['SESSION_SECRET', 'CSRF_SECRET']);
    expect(partial.text).toBe(
      ['PORT=4000', '', '# signs cookies', 'SESSION_SECRET=new-secret', 'CSRF_SECRET=new-secret', ''].join('\n'),
    );
  });

  it('F-72: a second merge changes nothing', () => {
    const first = mergeEnv({ current: null, example: EXAMPLE, generate: fakeSecret });
    const second = mergeEnv({ current: first.text, example: EXAMPLE, generate: fakeSecret });

    expect(second.text).toBe(first.text);
    expect(second.added).toEqual([]);
    expect(second.generated).toEqual([]);
  });

  it('F-72: parses quoted values, export prefixes and trailing comments', () => {
    const env = parseEnv(
      ['export A=1', 'B="two words"', "C='x # y'", 'D=plain # note', '# E=ignored', 'not a line'].join('\n'),
    );

    expect(Object.fromEntries(env)).toEqual({ A: '1', B: 'two words', C: 'x # y', D: 'plain' });
  });

  describe('on disk', () => {
    let dir = '';
    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('F-72, B-02: writes .env with mode 600, logs key names only and is byte-identical on a second run', () => {
      dir = mkdtempSync(join(tmpdir(), 'setup-env-'));
      writeFileSync(join(dir, '.env.example'), EXAMPLE);
      const logs = [];

      setupEnv({ cwd: dir, log: (message) => logs.push(message) });
      const first = readFileSync(join(dir, '.env'), 'utf8');
      setupEnv({ cwd: dir, log: (message) => logs.push(message) });

      expect(readFileSync(join(dir, '.env'), 'utf8')).toBe(first);
      expect(statSync(join(dir, '.env')).mode & 0o777).toBe(0o600);
      const secrets = ['SESSION_SECRET', 'CSRF_SECRET', 'SEED_DEMO_PASSWORD'].map(
        (key) => parseEnv(first).get(key) ?? '',
      );
      for (const secret of secrets) {
        expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
        expect(logs.join('\n')).not.toContain(secret);
      }
      expect(new Set(secrets).size).toBe(3);
      expect(logs.at(-1)).toBe('setup:env: .env is complete, nothing changed');
    });

    it('F-72: fails clearly without .env.example', () => {
      dir = mkdtempSync(join(tmpdir(), 'setup-env-'));
      expect(() => setupEnv({ cwd: dir, log: () => undefined })).toThrow('.env.example not found');
    });
  });
});
