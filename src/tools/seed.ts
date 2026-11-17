/**
 * Demo data entry point (`pnpm db:seed`, compose service `seed`; DATA-MODEL.md section 6, ADR 0016, ADR 0019 §7).
 *
 * Phase-1a stub: it already enforces the guard and exits 0, so `pnpm dev:setup`, `pnpm demo`, the CI
 * `dev-setup-smoke` job and the e2e stack work before there is anything to seed. Phase 2 fills it in.
 */
import { createLogger } from '../shared/logging/logger.js';

/**
 * Seeding needs `SEED_ALLOW=true` set explicitly for the invocation, whatever NODE_ENV is (conventions §8): the
 * production image runs the seed with NODE_ENV=production, so NODE_ENV can never be the switch. `SEED_ALLOW` is never
 * an .env key. The message names the variable, never a value.
 */
export function assertSeedAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (env['SEED_ALLOW'] !== 'true') {
    throw new Error('seeding is disabled: set SEED_ALLOW=true for this invocation (pnpm db:seed does)');
  }
}

if (import.meta.main) {
  try {
    assertSeedAllowed(process.env);
    // JSON lines whatever NODE_ENV is: the stub needs no configuration beyond the guard.
    const logger = createLogger({ LOG_LEVEL: 'info', NODE_ENV: 'production' });
    logger.info('nothing to seed yet');
  } catch (error) {
    process.stderr.write(`seed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
