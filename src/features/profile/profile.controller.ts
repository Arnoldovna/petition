import type { Request, RequestHandler, Response } from 'express';

import { viewerOf } from '../../shared/auth/guards.js';
import { setFlash } from '../../shared/http/flash.js';
import { formValues, formView, parseForm, type FieldErrors, type FormView } from '../../shared/http/form.js';
import { applyLimiter } from '../../shared/security/security.js';
import { establishSession, type SessionPolicy } from '../../shared/security/session.js';
import { ACCOUNT_MESSAGES } from '../../shared/validation/fields.js';
import { renderPage } from '../../shared/view/render.js';
import { CURRENT_PASSWORD_REQUIRED, EditProfileForm, OnboardingForm } from './profile.schema.js';
import type { ProfileService, UpdateAccountOutcome } from './profile.service.js';

/**
 * HTTP <-> profile service (ROUTES.md section 4, ADR 0008): parse the form, call the service, then 303 (PRG) or a
 * 422 re-render of the same view with the error summary, inline messages and the submitted values (never a
 * password). Every page goes through `renderPage`, which adds the viewer, a fresh CSRF token and the flash.
 */

const ONBOARDING_VIEW = 'pages/profile/onboarding';
const EDIT_VIEW = 'pages/profile/edit';
const ONBOARDING_TITLE = 'About you';
const EDIT_TITLE = 'Edit profile';
/** After onboarding, and the onboarding page's "skip" link (F-33). */
const NEXT_AFTER_ONBOARDING = '/signature';
const EDIT_PATH = '/profile/edit';
/** Where a request goes whose account was deleted while it ran: the visitor is no longer signed in. */
const LOGIN_PATH = '/login';

/** The field errors of a refused edit (ROUTES.md section 4); `not-found` has none, it redirects. */
const EDIT_REFUSALS: Readonly<Record<'current-password-required' | 'wrong-password' | 'email-taken', FieldErrors>> = {
  'current-password-required': { currentPassword: CURRENT_PASSWORD_REQUIRED },
  'wrong-password': { currentPassword: ACCOUNT_MESSAGES.wrongPassword },
  'email-taken': { email: ACCOUNT_MESSAGES.emailTaken },
};

export interface ProfileController {
  showOnboarding: RequestHandler;
  saveOnboarding: RequestHandler;
  showEdit: RequestHandler;
  saveEdit: RequestHandler;
}

export interface ProfileControllerDeps {
  service: ProfileService;
  /** A new password re-establishes the current session (ADR 0002 item 6). */
  sessionPolicy: SessionPolicy;
  /**
   * `rateLimits.reauth` (ADR 0012), keyed by the viewer (the routes run `requireAuth` first). Applied by the service
   * right before it checks the current password, so only an email or password change counts, never a name or profile
   * edit that happens to carry an autofilled current password.
   */
  reauth: RequestHandler;
}

function renderOnboarding(req: Request, res: Response, form: FormView, status = 200): void {
  renderPage(req, res, ONBOARDING_VIEW, { title: ONBOARDING_TITLE, form }, status);
}

/** `showDeleteSignature`: the "delete signature" link only for a viewer who has signed (F-66, B-47). */
function renderEdit(req: Request, res: Response, form: FormView, status = 200): void {
  const viewer = viewerOf(res);
  renderPage(req, res, EDIT_VIEW, { title: EDIT_TITLE, form, showDeleteSignature: viewer.hasSigned }, status);
}

export function createProfileController({ service, sessionPolicy, reauth }: ProfileControllerDeps): ProfileController {
  /** Success of an edit: a new password gets a new session id with the new version (ADR 0002), then the flash. */
  async function finishEdit(req: Request, res: Response, outcome: Extract<UpdateAccountOutcome, { ok: true }>) {
    if (outcome.passwordChanged) {
      await establishSession(req, { id: viewerOf(res).userId, sessionVersion: outcome.sessionVersion }, sessionPolicy);
    }
    // After establishSession: regenerating the session would drop a flash set before it.
    setFlash(req, 'Profile updated');
    res.redirect(303, EDIT_PATH);
  }

  return {
    showOnboarding: async (req, res) => {
      const values = await service.onboardingValues(viewerOf(res).userId);
      renderOnboarding(req, res, formView(values));
    },

    saveOnboarding: async (req, res) => {
      const parsed = parseForm(OnboardingForm, req.body);
      if (!parsed.ok) {
        renderOnboarding(req, res, formView(parsed.values, parsed.errors), 422);
        return;
      }
      const saved = await service.saveOnboarding(viewerOf(res).userId, parsed.data);
      // An account deleted while the request ran (F-31): the visitor is a guest now, so the login page comes next.
      res.redirect(303, saved.ok ? NEXT_AFTER_ONBOARDING : LOGIN_PATH);
    },

    showEdit: async (req, res) => {
      const values = await service.editValues(viewerOf(res).userId);
      if (values === undefined) {
        res.redirect(302, LOGIN_PATH);
        return;
      }
      renderEdit(req, res, formView(values));
    },

    saveEdit: async (req, res) => {
      const parsed = parseForm(EditProfileForm, req.body);
      if (!parsed.ok) {
        renderEdit(req, res, formView(parsed.values, parsed.errors), 422);
        return;
      }

      const outcome = await service.updateAccount(viewerOf(res).userId, parsed.data, {
        // A 429 rejects here and reaches the error handler, before any argon2 work (ADR 0012).
        beforePasswordCheck: () => applyLimiter(reauth, req, res),
      });
      if (outcome.ok) {
        await finishEdit(req, res, outcome);
        return;
      }
      if (outcome.reason === 'not-found') {
        res.redirect(303, LOGIN_PATH);
        return;
      }
      renderEdit(req, res, formView(formValues(req.body), EDIT_REFUSALS[outcome.reason]), 422);
    },
  };
}
