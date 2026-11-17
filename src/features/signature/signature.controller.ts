import type { Request, Response } from 'express';

import { viewerOf } from '../../shared/auth/guards.js';
import { NotFoundError, ValidationError } from '../../shared/errors/app-error.js';
import { setFlash } from '../../shared/http/flash.js';
import { formValues, formView, parseForm, type FieldErrors, type FormView } from '../../shared/http/form.js';
import { renderPage } from '../../shared/view/render.js';
import { SIGNATURE_HEIGHT, SIGNATURE_WIDTH } from './image/index.js';
import {
  SignForm,
  SignMethodBody,
  type DeleteSignatureView,
  type SignPageView,
  type ThankYouView,
} from './signature.schema.js';
import type { SignatureService } from './signature.service.js';

const SIGN_VIEW = 'pages/signature/sign';
const THANK_YOU_VIEW = 'pages/signature/thank-you';
const DELETE_VIEW = 'pages/signature/delete';

/** The only route that serves the image; the thank-you page links to it (ADR 0004 item 6). */
const IMAGE_PATH = '/signature/image.png';
/** Where a request goes whose account was deleted while it ran: the visitor is no longer signed in. */
const LOGIN_PATH = '/login';

/** What the confirmation page says will happen (ADR 0013, F-49, F-50). */
const DELETE_CONSEQUENCES: readonly string[] = [
  'Your signature image is deleted.',
  'Your name is removed from the supporters list.',
  'The supporter count goes down by one.',
  'You can sign again at any time.',
];

/** The sign page for a first visit (empty form) or a 422 re-render (values, errors and the pad's message). */
function renderSign(req: Request, res: Response, form: FormView, status = 200): void {
  const model: SignPageView = {
    title: 'Sign the petition',
    heading: `Hey ${viewerOf(res).firstName}`,
    scripts: ['signature-pad.js'],
    form,
    padError: form.errors['signature'],
    exportWidth: SIGNATURE_WIDTH,
    exportHeight: SIGNATURE_HEIGHT,
  };
  renderPage(req, res, SIGN_VIEW, model, status);
}

/**
 * HTTP <-> service translation for the signature pages (ROUTES.md section 5): parse the form, branch on the service
 * Result, PRG with a flash on success, 422 re-render on failure (ADR 0008). Every handler runs behind `requireAuth`
 * and the signed-state guard of its route, and acts on the viewer's own user id only.
 */
export function createSignatureController(service: SignatureService) {
  function rejectSign(req: Request, res: Response, errors: FieldErrors): void {
    // formValues never echoes the signature payload or the token (form.ts), so only the typed name comes back.
    renderSign(req, res, formView(formValues(req.body), errors), 422);
  }

  return {
    /** `GET /signature` (F-37, F-45). */
    showSign: (req: Request, res: Response): void => {
      renderSign(req, res, formView());
    },

    /** `POST /signature` (F-41 to F-45, B-19, B-49). */
    sign: async (req: Request, res: Response): Promise<void> => {
      const viewer = viewerOf(res);
      // Both forms carry a hidden `method`; a body without a known one did not come from them.
      if (!SignMethodBody.safeParse(req.body).success) {
        throw new ValidationError([{ location: 'body', path: 'method', message: 'Unknown signature method' }]);
      }
      const parsed = parseForm(SignForm, req.body);
      if (!parsed.ok) {
        rejectSign(req, res, parsed.errors);
        return;
      }

      const result = await service.sign(viewer.userId, parsed.data);
      if (!result.ok && result.reason === 'not-found') {
        // Like the profile edit: the next request is a guest's, so the login page is the next step (F-31).
        res.redirect(303, LOGIN_PATH);
        return;
      }
      if (!result.ok) {
        req.log.info({ userId: viewer.userId, reason: result.reason }, 'signature.rejected');
        rejectSign(req, res, { signature: result.message });
        return;
      }
      if (result.inserted) req.log.info({ userId: viewer.userId, method: parsed.data.method }, 'signature.created');
      setFlash(req, 'Thank you, your signature was saved');
      res.redirect(303, '/thank-you');
    },

    /**
     * `GET /signature/image.png` (ADR 0004 item 6, F-71): the viewer's own bytes only. A viewer without a signature
     * gets the 404 page, never a redirect, because an image URL must not answer with HTML that pretends to succeed.
     */
    image: async (_req: Request, res: Response): Promise<void> => {
      const viewer = viewerOf(res);
      const png = viewer.hasSigned ? await service.imageOf(viewer.userId) : undefined;
      if (png === undefined) throw new NotFoundError('Signature image');
      res.status(200);
      res.setHeader('Content-Type', 'image/png');
      res.setHeader('Content-Length', String(png.length));
      res.setHeader('Cache-Control', 'private, no-store');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      // `end`, not `send`: no ETag for a private, uncacheable image.
      res.end(png);
    },

    /** `GET /thank-you` (F-46 to F-48, B-07). */
    thankYou: async (req: Request, res: Response): Promise<void> => {
      const model: ThankYouView = {
        title: 'Thank you',
        supporterCount: await service.supporterCount(),
        imageSrc: IMAGE_PATH,
      };
      renderPage(req, res, THANK_YOU_VIEW, model);
    },

    /** `GET /signature/delete`: the confirmation page (F-50, B-47, ADR 0013). */
    showDelete: (req: Request, res: Response): void => {
      const model: DeleteSignatureView = { title: 'Delete signature', consequences: DELETE_CONSEQUENCES };
      renderPage(req, res, DELETE_VIEW, model);
    },

    /** `POST /signature/delete` (F-49): the viewer's own row only, then back to the sign page. */
    remove: async (req: Request, res: Response): Promise<void> => {
      const viewer = viewerOf(res);
      if (await service.remove(viewer.userId)) req.log.info({ userId: viewer.userId }, 'signature.deleted');
      setFlash(req, 'Your signature was removed');
      res.redirect(303, '/signature');
    },
  };
}

export type SignatureController = ReturnType<typeof createSignatureController>;
