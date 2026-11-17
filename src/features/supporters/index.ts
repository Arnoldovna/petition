import type { Router } from 'express';

import type { Database } from '../../db/client.js';
import { createSupportersController } from './supporters.controller.js';
import { createSupportersRepository } from './supporters.repository.js';
import { createSupportersRouter } from './supporters.routes.js';
import { createSupportersService } from './supporters.service.js';

/**
 * Public API of the supporters module (ADR 0001, ADR 0006): the read-only list and city pages, and the supporters
 * total that `app.ts` injects into the signature module's thank-you page (F-47). `SupportersModuleDeps` and the shape
 * `{ router, countSupporters }` are frozen since phase 1b.
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

/** Wires repository -> service -> controller -> router. Opens no connection and never throws (BUILD-ORDER rule 6). */
export function createSupportersModule({ db, pageSize }: SupportersModuleDeps): SupportersModule {
  const service = createSupportersService({ repository: createSupportersRepository(db), pageSize });
  return {
    router: createSupportersRouter(createSupportersController(service)),
    countSupporters: service.countSupporters,
  };
}
