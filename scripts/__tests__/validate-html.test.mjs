import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { listHtmlFiles, parseArgs, readValidatorImage, unreportedFiles } from '../validate-html.mjs';

const DOCKERFILE = readFileSync(resolve(import.meta.dirname, '../../docker/nu-validator.Dockerfile'), 'utf8');

describe('validate-html', () => {
  it('F-87, B-73: reads the digest-pinned validator image from docker/nu-validator.Dockerfile', () => {
    expect(readValidatorImage(DOCKERFILE)).toMatch(/^ghcr\.io\/validator\/validator:[\w.-]+@sha256:[a-f0-9]{64}$/);
    expect(DOCKERFILE.split('\n').filter((line) => line.trim() !== '' && !line.startsWith('#'))).toHaveLength(1);
  });

  it('F-87: refuses an image reference without a digest', () => {
    expect(() => readValidatorImage('FROM ghcr.io/validator/validator:latest\n')).toThrow('@sha256:<digest>');
  });

  it('F-87: lists .html files recursively with forward slashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'validate-html-'));
    try {
      mkdirSync(join(dir, 'nested'));
      writeFileSync(join(dir, 'desktop-home-guest.html'), '');
      writeFileSync(join(dir, 'nested', 'mobile-login-error.html'), '');
      writeFileSync(join(dir, 'notes.txt'), '');

      expect(listHtmlFiles(dir)).toEqual(['desktop-home-guest.html', 'nested/mobile-login-error.html']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('F-87: detects files the validator never reported (it exits 0 for paths it cannot read)', () => {
    const stdout = '/html/a.html\n/html/b.html\n';

    expect(unreportedFiles(['/html/a.html', '/html/b.html'], stdout)).toEqual([]);
    expect(unreportedFiles(['/html/a.html', '/html/c.html'], stdout)).toEqual(['/html/c.html']);
    expect(unreportedFiles(['/html/a.html'], '')).toEqual(['/html/a.html']);
  });

  it('F-87: defaults to test-results/html and accepts one folder', () => {
    expect(parseArgs([])).toEqual({ dir: 'test-results/html', ifPresent: false });
    expect(parseArgs(['test-results/5d/html', '--if-present'])).toEqual({
      dir: 'test-results/5d/html',
      ifPresent: true,
    });
    expect(() => parseArgs(['a', 'b'])).toThrow('usage');
  });
});
