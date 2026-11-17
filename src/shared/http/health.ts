import { setTimeout as delay } from 'node:timers/promises';

import { Router } from 'express';

export type ReadinessCheck = () => Promise<boolean>;

interface HealthOptions {
  /**
   * A check that has not answered within this time counts as failed. Below the 3 s timeout of the compose
   * healthcheck, so the probe always gets a 503 instead of timing out itself.
   */
  checkTimeoutMs?: number;
}

const DEFAULT_CHECK_TIMEOUT_MS = 2_000;

/** True only when the check resolves true in time. A throw, a rejection or a hang counts as failed. */
async function passesWithin(check: ReadinessCheck, timeoutMs: number): Promise<boolean> {
  const timer = new AbortController();
  try {
    return await Promise.race([
      Promise.try(check).catch(() => false),
      delay(timeoutMs, false, { signal: timer.signal }),
    ]);
  } finally {
    // Promise.race already subscribed to the timer, so the AbortError it rejects with here is handled.
    timer.abort();
  }
}

/**
 * F-74 (amended to /health/ready, ADR 0011). Mounted before helmet, sessions and limits; the bodies never name a
 * dependency.
 *
 * - `/health/live`: the process is up.
 * - `/health/ready`: every check passes in time (database `select 1`, Redis `isReady`); 503 while shutting down, so
 *   the compose healthcheck and a load balancer stop sending traffic before the pools close.
 */
export function createHealthRouter(
  checks: Readonly<Record<string, ReadinessCheck>>,
  isShuttingDown: () => boolean,
  { checkTimeoutMs = DEFAULT_CHECK_TIMEOUT_MS }: HealthOptions = {},
) {
  const router = Router();
  router.get('/live', (_req, res) => {
    res.json({ status: 'ok' });
  });
  router.get('/ready', async (_req, res) => {
    if (isShuttingDown()) {
      res.status(503).json({ status: 'shutting-down' });
      return;
    }
    // A failed check answers 503, never 500 or a hanging request.
    const results = await Promise.all(Object.values(checks).map((check) => passesWithin(check, checkTimeoutMs)));
    const ok = results.every(Boolean);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable' });
  });
  return router;
}
