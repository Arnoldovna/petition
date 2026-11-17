import { describe, expect, it } from 'vitest';

import { checkDatabaseUrl, checkTools, composeValue, isAtLeast, parseVersion } from '../dev-setup.mjs';

const OK_PROBES = {
  pnpm: '10.34.9\n',
  git: 'git version 2.52.0\n',
  docker: '29.5.2\n',
  compose: 'v5.5.0\n',
};

function tools(overrides = {}, mode = 'dev', nodeVersion = 'v26.13.1') {
  const probes = { ...OK_PROBES, ...overrides };
  return checkTools({
    mode,
    nodeVersion,
    requiredNode: '26',
    requiredPnpm: '10.34.9',
    probe: (tool) => probes[tool] ?? null,
  });
}

const ENV = new Map([
  ['DATABASE_URL', 'postgres://petition:local-only@127.0.0.1:5432/petition'],
  ['POSTGRES_USER', 'petition'],
  ['POSTGRES_PASSWORD', 'local-only'],
  ['POSTGRES_DB', 'petition'],
  ['POSTGRES_PORT', '5432'],
]);

describe('dev-setup', () => {
  it('B-59: parses and compares tool versions', () => {
    expect(parseVersion('git version 2.50.1 (Apple Git-155)')).toEqual([2, 50, 1]);
    expect(parseVersion('v5.5')).toEqual([5, 5, 0]);
    expect(parseVersion('unknown')).toBeNull();
    expect(isAtLeast('2.24.4', '2.24.4')).toBe(true);
    expect(isAtLeast('v2.24.3', '2.24.4')).toBe(false);
    expect(isAtLeast('2.30.9', '2.31.0')).toBe(false);
    expect(isAtLeast('10.0.0', '2.31.0')).toBe(true);
  });

  it('B-59: accepts the Phase-0 toolchain', () => {
    expect(tools()).toEqual([]);
  });

  it('B-59: reports every missing or outdated tool at once', () => {
    const problems = tools({ pnpm: '9.15.0', git: 'git version 2.23.0', compose: '2.20.0' }, 'dev', 'v22.20.0');

    expect(problems).toHaveLength(4);
    expect(problems.join('\n')).toMatch(/Node 26 .*v22\.20\.0/);
    expect(problems.join('\n')).toMatch(/pnpm 10\.34\.9 .*9\.15\.0/);
    expect(problems.join('\n')).toMatch(/git 2\.31\.0 or later/);
    expect(problems.join('\n')).toMatch(/Compose 2\.24\.4 or later/);
  });

  it('B-59: reports a stopped Docker daemon and skips the Compose probe', () => {
    expect(tools({ docker: undefined, compose: undefined })).toEqual([
      'Docker is required and its daemon must be running (`docker info` failed).',
    ]);
  });

  it('B-59: the demo path does not need git (reviewers only run pnpm install and pnpm demo)', () => {
    expect(tools({ git: undefined }, 'demo')).toEqual([]);
    expect(tools({ git: undefined }, 'dev')).toHaveLength(1);
  });

  it('F-01, B-60: accepts a DATABASE_URL that matches POSTGRES_*', () => {
    expect(checkDatabaseUrl(ENV)).toEqual([]);
    const defaults = new Map(ENV);
    defaults.delete('POSTGRES_PORT');
    defaults.set('DATABASE_URL', 'postgresql://petition:local-only@localhost/petition');
    expect(checkDatabaseUrl(defaults)).toEqual([]);
  });

  it('F-01, F-72: names the mismatching keys, never their values', () => {
    const env = new Map(ENV);
    env.set('DATABASE_URL', 'postgres://someone:hunter2-secret@127.0.0.1:5433/other');

    const [problem] = checkDatabaseUrl(env);

    expect(problem).toBe(
      'DATABASE_URL in .env does not match POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DB, POSTGRES_PORT. Make them name the same values.',
    );
    expect(problem).not.toContain('hunter2');
  });

  it('F-72: rejects a missing or non-Postgres DATABASE_URL', () => {
    const missing = new Map(ENV);
    missing.delete('DATABASE_URL');
    expect(checkDatabaseUrl(missing)).toEqual(['DATABASE_URL in .env is missing or not a URL.']);
    const redis = new Map(ENV);
    redis.set('DATABASE_URL', 'redis://127.0.0.1:6379');
    expect(checkDatabaseUrl(redis)).toEqual(['DATABASE_URL in .env must start with postgres:// or postgresql://.']);
  });

  it('F-01: resolves values like compose interpolation (shell, then .env, then fallback)', () => {
    const dotenv = new Map([['APP_PORT', '3100']]);
    expect(composeValue('APP_PORT', { APP_PORT: '3200' }, dotenv, '3000')).toBe('3200');
    expect(composeValue('APP_PORT', { APP_PORT: '' }, dotenv, '3000')).toBe('3100');
    expect(composeValue('APP_PORT', {}, new Map(), '3000')).toBe('3000');
  });
});
