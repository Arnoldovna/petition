import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { checkDatabaseUrl } from '../dev-setup.mjs';
import { isSecretKey, parseEnv } from '../setup-env.mjs';

const TEXT = readFileSync(resolve(import.meta.dirname, '../../.env.example'), 'utf8');
const ENV = parseEnv(TEXT);

/** OVERVIEW.md section 16 without SEED_ALLOW and E2E_BASE_URL (ADR 0019 section 7). */
const DOCUMENTED_KEYS = [
  'NODE_ENV',
  'PORT',
  'LOG_LEVEL',
  'TRUST_PROXY',
  'DATABASE_URL',
  'REDIS_URL',
  'COOKIE_SECURE',
  'SESSION_SECRET',
  'CSRF_SECRET',
  'SESSION_IDLE_MINUTES',
  'SESSION_ABSOLUTE_HOURS',
  'RATE_LIMIT_GLOBAL_MAX',
  'RATE_LIMIT_AUTH_MAX',
  'CONTACT_URL',
  'IMPRINT_URL',
  'APP_TIME_ZONE',
  'SEED_DEMO_PASSWORD',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DB',
  'POSTGRES_PORT',
  'REDIS_PORT',
  'APP_PORT',
  'E2E_PORT',
];

describe('.env.example', () => {
  it('F-72: documents every configuration key and nothing else', () => {
    expect([...ENV.keys()].sort()).toEqual([...DOCUMENTED_KEYS].sort());
    expect(ENV.has('SEED_ALLOW')).toBe(false);
    expect(ENV.has('E2E_BASE_URL')).toBe(false);
  });

  it('F-72: every key has a comment directly above it or above its group', () => {
    const lines = TEXT.split('\n');
    lines.forEach((line, index) => {
      if (!/^[A-Z_]+=/.test(line)) return;
      let above = index - 1;
      while (above >= 0 && /^[A-Z_]+=/.test(lines[above] ?? '')) above -= 1;
      expect(lines[above], `comment above ${line.split('=')[0] ?? ''}`).toMatch(/^# /);
    });
  });

  it('F-72, B-02, B-03: contains no secret values; only the fixed local Postgres password is set', () => {
    const filledSecrets = [...ENV].filter(([key, value]) => isSecretKey(key) && value !== '').map(([key]) => key);
    expect(filledSecrets).toEqual(['POSTGRES_PASSWORD']);
    expect(ENV.get('POSTGRES_PASSWORD')).toBe('local-only');
  });

  it('F-72: DATABASE_URL names the same user, password, database and port as POSTGRES_*', () => {
    expect(checkDatabaseUrl(ENV)).toEqual([]);
  });
});
