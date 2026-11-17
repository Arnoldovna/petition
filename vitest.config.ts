import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    restoreMocks: true,
    coverage: {
      // `pnpm test:coverage` (unit project only, not part of `verify`, ADR 0019 section 3)
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/**/*.d.ts'],
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'unit',
          environment: 'node',
          // scripts/__tests__ holds the tests of the build and dev scripts (.mjs, Node built-ins only).
          include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
          exclude: ['src/**/*.int.test.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          environment: 'node',
          include: ['src/**/*.int.test.ts'],
          // One Postgres + Redis per run and a migrated template database (global setup); every test file then
          // gets its own database cloned from that template (setup file), so files run in parallel without sharing
          // rows (conventions §7, ADR 0017).
          globalSetup: ['./test/global-setup.ts'],
          setupFiles: ['./test/setup-database.ts'],
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
