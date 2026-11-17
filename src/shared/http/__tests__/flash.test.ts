import type { Request } from 'express';
import type { Session, SessionData } from 'express-session';
import { describe, expect, it } from 'vitest';

import { setFlash, takeFlash } from '../flash.js';

/** A request with a plain session object; the real store round trip is covered by session.int.test.ts. */
const withSession = (data: Partial<SessionData> = {}) =>
  ({ session: { ...data } as Session & Partial<SessionData> }) as Request;

describe('flash', () => {
  it('F-17: a flash set by one request is taken once by the next render', () => {
    const req = withSession();

    setFlash(req, 'Profile updated');

    expect(req.session.flash).toEqual({ message: 'Profile updated' });
    expect(takeFlash(req)).toEqual({ message: 'Profile updated' });
    expect(takeFlash(req)).toBeUndefined();
    expect(req.session).not.toHaveProperty('flash');
  });

  it('F-17: a newer flash replaces an older one that was never shown', () => {
    const req = withSession();

    setFlash(req, 'Thank you, your signature was saved');
    setFlash(req, 'Your signature was removed');

    expect(takeFlash(req)).toEqual({ message: 'Your signature was removed' });
  });

  it('F-17: nothing pending means nothing shown', () => {
    expect(takeFlash(withSession())).toBeUndefined();
  });

  it('F-09: works without a session (an error inside the session middleware)', () => {
    expect(takeFlash({} as Request)).toBeUndefined();
  });

  it('F-17: unexpected store content is dropped instead of rendered', () => {
    const req = withSession({ flash: { message: 42 } as unknown as SessionData['flash'] });

    expect(takeFlash(req)).toBeUndefined();
    expect(req.session).not.toHaveProperty('flash');
  });
});
