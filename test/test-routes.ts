import cookieParser from 'cookie-parser';
import express, { Router, type RequestHandler } from 'express';
import { z } from 'zod';

import type { FindViewer } from '../src/shared/auth/viewer.js';
import type { Csrf } from '../src/shared/security/csrf.js';
import type { RateLimiters } from '../src/shared/security/security.js';
import { establishSession, type SessionPolicy } from '../src/shared/security/session.js';
import { renderPage } from '../src/shared/view/render.js';

/**
 * Test-only routes (ADR 0017, ADR 0019 §5). Only `createTestApp` mounts them, through `AppDeps.testRoutes`, after the
 * body parsers and before CSRF (OVERVIEW.md section 5.1, step 12); `container.ts` never does, so the production app
 * answers every `/__test/*` path with the 404 page (asserted in step 2b's route matrix).
 */

interface TestRoutesDeps {
  /** The app's viewer lookup (auth's `createViewerRepository(db).findViewer`). */
  findViewer: FindViewer;
  sessionPolicy: SessionPolicy;
  /** The same limiter instances the app mounts, so the probes share their counters. */
  rateLimits: RateLimiters;
  /** `createAppCsrf(env)`: the app's CSRF configuration (secret, cookie, session binding). */
  csrf: Csrf;
}

const SignInBody = z.object({ userId: z.number().int().min(1).max(2_147_483_647) });

/** Statuses a limiter probe may answer with: success, and the two "failed" ones the login limiters count. */
const PROBE_STATUSES = new Set([204, 401, 422]);

/**
 * `POST /__test/sign-in` with the JSON body `{ userId }`: signs the agent in exactly like a login does
 * (`establishSession`: new session id, user id, session version, issue time from the policy's clock). 204, 404 for an
 * unknown user, 400 for anything else. The app has no JSON parser, so this route brings its own (1 kb).
 */
function signInRoute({ findViewer, sessionPolicy }: TestRoutesDeps): RequestHandler {
  return async (req, res) => {
    const body = SignInBody.safeParse(req.body);
    if (!body.success) {
      res.sendStatus(400);
      return;
    }
    const user = await findViewer(body.data.userId);
    if (user === undefined) {
      res.sendStatus(404);
      return;
    }
    await establishSession(req, { id: user.id, sessionVersion: user.sessionVersion }, sessionPolicy);
    res.sendStatus(204);
  };
}

/**
 * `POST /__test/rate-limit/<limiter>` behind one of the app's limiters (ADR 0012, ADR 0019 §9): answers the status
 * from `?status=` (204, 401 or 422; default 204), so a test can drive the limiter mechanics with production limits
 * before any real route exists, including the "failed only" login limiters. Email keys read `email` from the
 * urlencoded body like the real forms.
 */
const limiterProbe: RequestHandler = (req, res) => {
  const requested = Number(req.query['status'] ?? 204);
  res.sendStatus(PROBE_STATUSES.has(requested) ? requested : 204);
};

/**
 * `POST /__test/form`: a CSRF-protected form endpoint for the resubmit round trip (ADR 0003) that phase 1 has no real
 * form for. It runs the app's CSRF configuration itself, because test routes are mounted before the app's CSRF step.
 * `outcome=valid` is the success redirect (303 `/`); anything else re-renders with 422 through `renderPage`, which
 * puts a fresh token into the page as every real form's 422 does.
 */
function formRoute(): RequestHandler {
  return (req, res) => {
    const body: unknown = req.body;
    const valid = typeof body === 'object' && body !== null && 'outcome' in body && body.outcome === 'valid';
    if (valid) {
      res.redirect(303, '/');
      return;
    }
    renderPage(
      req,
      res,
      'pages/error',
      {
        title: 'Check the form',
        heading: 'Check the form',
        text: 'The test form was not valid.',
        nextHref: '/',
        nextLabel: 'go to the home page',
      },
      422,
    );
  };
}

export function createTestRoutes(deps: TestRoutesDeps): Router {
  const router = Router();
  router.post('/__test/sign-in', express.json({ limit: '1kb' }), signInRoute(deps));
  for (const [name, limiter] of Object.entries(deps.rateLimits)) {
    router.post(`/__test/rate-limit/${name}`, limiter, limiterProbe);
  }
  router.post('/__test/form', cookieParser(), deps.csrf.protection, formRoute());
  return router;
}
