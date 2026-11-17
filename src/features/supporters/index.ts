import { Router } from 'express';

import type { Database } from '../../db/client.js';

/**
 * Public API of the supporters module (ADR 0001, ADR 0006): the read-only list and city pages, and the supporters
 * total that `app.ts` injects into the signature module's thank-you page (F-47). Frozen since phase 1b: the supporters
 * module replaces this file last in phase 2a (BUILD-ORDER.md rule 6) and keeps `SupportersModuleDeps` and the shape
 * `{ router, countSupporters }` unchanged.
 */
export interface SupportersModuleDeps {
  db: Database;
  /** Rows per page of `/supporters` and `/supporters/city/:city` (ADR 0006: 50). */
  pageSize: number;
}

export interface SupportersModule {
  router: Router;
  /** The number of signatures, the same total the supporters list shows (F-47, ADR 0006). */
  countSupporters: () => Promise<number>;
}

/**
 * Phase-1b stub: an empty router until phase 2a adds `/supporters` and `/supporters/city/:city`; the count is 0 until
 * the module queries it.
 */
export function createSupportersModule(_deps: SupportersModuleDeps): SupportersModule {
  return { router: Router(), countSupporters: () => Promise.resolve(0) };
}
