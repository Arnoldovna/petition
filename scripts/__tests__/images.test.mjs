import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(import.meta.dirname, '../..');
const read = (file) => readFileSync(resolve(ROOT, file), 'utf8');
const DIGEST = /@sha256:[a-f0-9]{64}$/;

describe('container images', () => {
  it('B-59: every compose image is pinned by digest', () => {
    const images = [...read('docker-compose.yml').matchAll(/^\s*image:\s*(\S+)\s*$/gm)].map((match) => match[1] ?? '');

    expect(images.map((image) => image.split('@')[0])).toEqual(['postgres:18-alpine', 'redis:8-alpine']);
    for (const image of images) expect(image).toMatch(DIGEST);
  });

  it('B-59: every Dockerfile base image and the syntax frontend are pinned by digest', () => {
    for (const file of ['Dockerfile', 'docker/nu-validator.Dockerfile']) {
      const text = read(file);
      const references = [...text.matchAll(/^FROM\s+(\S+)/gm)].map((match) => match[1] ?? '');
      const external = references.filter((reference) => reference.includes(':') || reference.includes('/'));
      expect(external.length, file).toBeGreaterThan(0);
      for (const reference of external) expect(reference, file).toMatch(DIGEST);
      const syntax = /^# syntax=(\S+)/m.exec(text)?.[1];
      if (syntax) expect(syntax).toMatch(DIGEST);
    }
  });

  it('B-59: the e2e override publishes only the app, on 127.0.0.1 and E2E_PORT', () => {
    const override = read('docker-compose.e2e.yml');

    expect(override).toContain("ports: !override ['127.0.0.1:${E2E_PORT:-8182}:3000']");
    expect(override.match(/ports: !reset \[\]/g)).toHaveLength(2);
    expect(override).toContain("tmpfs: ['/var/lib/postgresql']");
  });

  it('the migrate, seed and app containers drop every capability and run on a read-only root filesystem', () => {
    const compose = read('docker-compose.yml');
    const anchor = /^x-hardening: &hardening\n((?: {2}.+\n)+)/m.exec(compose)?.[1] ?? '';

    expect(anchor.split('\n').filter(Boolean)).toEqual([
      '  cap_drop: [ALL]',
      "  security_opt: ['no-new-privileges:true']",
      '  read_only: true',
      "  tmpfs: ['/tmp']",
    ]);
    // Service names may contain hyphens (`nu-validator`), so `\w` alone would silently miss one.
    const services = [...compose.matchAll(/^ {2}([\w-]+):\n((?: {4}.*\n|\n)+)/gm)];
    const hardened = services.filter(([, , body]) => body?.includes('<<: *hardening')).map(([, name]) => name);
    expect(hardened).toEqual(['migrate', 'seed', 'app']);
  });

  it('B-59: every published port of the base stack binds to 127.0.0.1', () => {
    const ports = [...read('docker-compose.yml').matchAll(/^\s*ports:\s*(.+)$/gm)].map((match) => match[1] ?? '');

    expect(ports).toEqual([
      "['127.0.0.1:${POSTGRES_PORT:-5432}:5432']",
      "['127.0.0.1:${REDIS_PORT:-6379}:6379']",
      "['127.0.0.1:${APP_PORT:-3000}:3000']",
    ]);
  });
});
