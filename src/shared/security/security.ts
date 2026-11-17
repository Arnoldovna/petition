import type { RequestHandler } from 'express';
import helmet from 'helmet';

const SELF = "'self'";
const NONE = "'none'";

/**
 * Security headers (ADR 0011, F-71, B-10). An explicit CSP instead of helmet's defaults: no inline scripts or styles,
 * no third-party origins (F-86), forms only post to the app, no framing.
 *
 * `https` is `isHttps(env)`: HSTS and `upgrade-insecure-requests` are sent only when the app is served over https.
 * Otherwise WebKit applies UIR to 127.0.0.1 and the local production stack loses its styles.
 * Phase 1b adds the rate limiters to this file.
 */
export function securityHeaders({ https }: { https: boolean }): RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: [SELF],
        scriptSrc: [SELF],
        styleSrc: [SELF],
        imgSrc: [SELF],
        fontSrc: [SELF],
        connectSrc: [SELF],
        formAction: [SELF],
        frameAncestors: [NONE],
        baseUri: [NONE],
        objectSrc: [NONE],
        manifestSrc: [SELF],
        ...(https ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: https,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: { action: 'deny' },
  });
}
