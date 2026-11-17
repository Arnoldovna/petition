import { existsSync } from 'node:fs';

import { defineConfig } from 'drizzle-kit';

// `generate` works offline; `migrate`, `push` and `studio` need DATABASE_URL.
if (!process.env['DATABASE_URL'] && existsSync('./.env')) process.loadEnvFile('./.env');
const url = process.env['DATABASE_URL'];

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/index.ts',
  out: './drizzle',
  casing: 'snake_case',
  ...(url ? { dbCredentials: { url } } : {}),
  strict: true,
  verbose: true,
});
