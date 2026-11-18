import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { resolvePaths } from '../../../config/paths.js';
import { createStaticRouter } from '../static.js';

/** Well above compression's 1 kB threshold, so size never decides whether a response is compressed. */
const LARGE = 'x'.repeat(4096);

describe('createStaticRouter compression', () => {
  let root: string;
  let app: express.Express;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'static-router-'));
    mkdirSync(join(root, 'built', 'assets'), { recursive: true });
    mkdirSync(join(root, 'built', 'fonts'), { recursive: true });
    mkdirSync(join(root, 'public'), { recursive: true });
    writeFileSync(join(root, 'built', 'assets', 'app.css'), `.page { content: "${LARGE}"; }`);

    // Stands in for the real error handler: an HTML error page as large as a real one with a CSRF token.
    const htmlErrorPage: ErrorRequestHandler = (error: { status?: number }, _req, res, _next) => {
      res
        .status(error.status ?? 500)
        .type('html')
        .send(`<!doctype html><title>Page not found</title><p>${LARGE}</p>`);
    };
    app = express()
      .use(
        createStaticRouter({
          mode: 'production',
          builtPublicDir: join(root, 'built'),
          publicDir: join(root, 'public'),
        }),
      )
      .use(htmlErrorPage);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('ADR 0010: compresses a static asset', async () => {
    const response = await request(app).get('/assets/app.css').set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(200);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('B-59, ADR 0010: the HTML 404 page of a missing asset is never compressed (BREACH)', async () => {
    const response = await request(app).get('/assets/missing.css').set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(404);
    expect(response.headers['content-type']).toMatch(/^text\/html/);
    expect(response.headers['content-encoding']).toBeUndefined();
  });

  it('ADR 0010: the same holds below /fonts', async () => {
    const response = await request(app).get('/fonts/missing.woff2').set('Accept-Encoding', 'gzip');

    expect(response.status).toBe(404);
    expect(response.headers['content-encoding']).toBeUndefined();
  });
});

describe('root icons and manifest', () => {
  const { viewsDir, publicDir } = resolvePaths('development');
  const WebManifest = z.object({ icons: z.array(z.object({ src: z.string() })) });

  /** The root files (`/<name>`) that the layout links as icon or manifest. */
  function linkedRootFiles(): string[] {
    const layout = readFileSync(join(viewsDir, 'layouts', 'main.hbs'), 'utf8');
    return [...layout.matchAll(/<link rel="(?:icon|apple-touch-icon|manifest)" href="\/([^"/]+)"/g)].map(
      ([, file]) => file ?? '',
    );
  }

  it('B-43: every icon and the manifest the layout links exist in public/, so browsers get no 404 for them', () => {
    const manifest = WebManifest.parse(JSON.parse(readFileSync(join(publicDir, 'site.webmanifest'), 'utf8')));
    const files = [...linkedRootFiles(), ...manifest.icons.map(({ src }) => src.replace(/^\//, ''))];

    expect(files).toContain('apple-touch-icon.png');
    for (const file of files) expect(existsSync(join(publicDir, file)), file).toBe(true);
  });

  it('B-43, ROUTES section 7: the root files are served with a one-day cache', async () => {
    const app = express().use(createStaticRouter({ mode: 'production', builtPublicDir: publicDir, publicDir }));

    for (const file of linkedRootFiles()) {
      const response = await request(app).get(`/${file}`);

      expect(response.status, file).toBe(200);
      expect(response.headers['cache-control'], file).toBe('public, max-age=86400');
    }
  });
});
