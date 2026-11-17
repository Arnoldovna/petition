import type { Request, RequestHandler, Response } from 'express';

import { homeOf, viewerOf } from '../../shared/auth/guards.js';
import {
  FORM_ERROR_KEY,
  formValues,
  formView,
  parseForm,
  type FieldErrors,
  type FormValues,
} from '../../shared/http/form.js';
import { safeReturnTo } from '../../shared/http/redirect.js';
import { bindAnonymousSession } from '../../shared/security/csrf.js';
import { endSession, establishSession, type SessionPolicy } from '../../shared/security/session.js';
import { ACCOUNT_MESSAGES } from '../../shared/validation/fields.js';
import { renderPage } from '../../shared/view/render.js';
import {
  DeleteAccountForm,
  LoginForm,
  LoginQuery,
  RegisterForm,
  type DeleteAccountView,
  type LoginView,
  type RegisterView,
} from './auth.schema.js';
import type { AuthService } from './auth.service.js';

/**
 * HTTP <-> auth service (ROUTES.md section 3, ADR 0008): parse the form, call the service, then either `303 See
 * Other` (PRG) or re-render the same view with 422 (validation, business rule) or 401 (failed login). Every page goes
 * through `renderPage`, which adds the viewer, a fresh CSRF token and the flash, so a corrected form can be resubmitted
 * (ADR 0003). No SQL and no rules here.
 */

const VIEWS = {
  register: 'pages/auth/register',
  login: 'pages/auth/login',
  deleteAccount: 'pages/auth/account-delete',
} as const;

/** The exact user-facing string of a failed login (ROUTES.md section 3); the shared refusals are `ACCOUNT_MESSAGES`. */
const LOGIN_FAILED = 'Email or password is incorrect';

/** What `GET /account/delete` lists before the password field (F-67, ADR 0013). */
const ACCOUNT_DELETE_CONSEQUENCES: readonly string[] = [
  'Your account: your name, your email address and your password.',
  'Your profile: age, city and homepage, if you added them.',
  'Your signature, if you signed. The supporter count goes down by one.',
];

/** After registration the visitor continues with the optional profile details (F-18, F-33). */
const AFTER_REGISTER = '/profile';
/** After logout and account deletion (F-25, F-68). */
const AFTER_SESSION_END = '/';

export interface AuthControllerDeps {
  service: AuthService;
  /** Register and login sign the visitor in with it (ADR 0002 item 6). */
  sessionPolicy: SessionPolicy;
}

export interface AuthController {
  showRegister: RequestHandler;
  register: RequestHandler;
  showLogin: RequestHandler;
  login: RequestHandler;
  logout: RequestHandler;
  showDeleteAccount: RequestHandler;
  deleteAccount: RequestHandler;
}

function renderRegister(
  req: Request,
  res: Response,
  {
    values,
    errors,
    status,
    emailTaken = false,
  }: { values?: FormValues; errors?: FieldErrors; status?: number; emailTaken?: boolean } = {},
): void {
  const model: RegisterView = { title: 'Register', form: formView(values, errors), emailTaken };
  renderPage(req, res, VIEWS.register, model, status);
}

function renderLogin(
  req: Request,
  res: Response,
  returnTo: string | undefined,
  { values, errors, status }: { values?: FormValues; errors?: FieldErrors; status?: number } = {},
): void {
  const model: LoginView = { title: 'Log in', form: formView(values, errors), returnTo };
  renderPage(req, res, VIEWS.login, model, status);
}

function renderDeleteAccount(
  req: Request,
  res: Response,
  { errors, status }: { errors?: FieldErrors; status?: number } = {},
): void {
  const model: DeleteAccountView = {
    title: 'Delete account',
    // The only field is the current password, which is never echoed back (ROUTES.md section 1).
    form: formView({}, errors),
    consequences: ACCOUNT_DELETE_CONSEQUENCES,
  };
  renderPage(req, res, VIEWS.deleteAccount, model, status);
}

/** The safe `returnTo` of a submitted login form, kept on every re-render; anything unsafe is dropped (F-30). */
function returnToOf(body: unknown): string | undefined {
  return safeReturnTo(formValues(body)['returnTo']);
}

export function createAuthController({ service, sessionPolicy }: AuthControllerDeps): AuthController {
  return {
    // GET /register (requireGuest): bind the anonymous session, so the token stays valid until the POST (ADR 0003).
    showRegister: async (req, res) => {
      await bindAnonymousSession(req);
      renderRegister(req, res);
    },

    // POST /register (requireGuest, auth-ip, register-email; CSRF app-wide)
    register: async (req, res) => {
      const parsed = parseForm(RegisterForm, req.body);
      if (!parsed.ok) {
        // F-19, F-21, B-24: every field message at once, the values kept except the password.
        renderRegister(req, res, { values: parsed.values, errors: parsed.errors, status: 422 });
        return;
      }

      const result = await service.register(parsed.data);
      if (!result.ok) {
        // F-20: whatever the password, an existing email is never a login (ADR 0009).
        renderRegister(req, res, {
          values: formValues(req.body),
          errors: { email: ACCOUNT_MESSAGES.emailTaken },
          status: 422,
          // Only this refusal adds the "log in instead" link, never a field-rule message about the email.
          emailTaken: true,
        });
        return;
      }

      await establishSession(req, result.user, sessionPolicy);
      req.log.info({ userId: result.user.id }, 'account.registered');
      res.redirect(303, AFTER_REGISTER);
    },

    // GET /login?returnTo= (requireGuest)
    showLogin: async (req, res) => {
      const query = LoginQuery.safeParse(req.query);
      await bindAnonymousSession(req);
      renderLogin(req, res, query.success ? query.data.returnTo : undefined);
    },

    // POST /login (requireGuest, auth-ip, login-email-subnet, login-email; CSRF app-wide)
    login: async (req, res) => {
      const parsed = parseForm(LoginForm, req.body);
      if (!parsed.ok) {
        renderLogin(req, res, returnToOf(req.body), { values: parsed.values, errors: parsed.errors, status: 422 });
        return;
      }

      const { email, password, returnTo } = parsed.data;
      const result = await service.login({ email, password });
      if (!result.ok) {
        // F-24, B-09, B-23: one status, one message, the email kept; nothing tells which part was wrong.
        req.log.info('auth.login_failed');
        renderLogin(req, res, returnTo, {
          values: formValues(req.body),
          // A form-level error, so neither field is marked as the wrong one (F-24).
          errors: { [FORM_ERROR_KEY]: LOGIN_FAILED },
          status: 401,
        });
        return;
      }

      // F-23: a new session id against fixation; the old CSRF token dies with the old id (ADR 0002, ADR 0003).
      await establishSession(req, result.session, sessionPolicy);
      req.log.info({ userId: result.session.id }, 'auth.login');
      res.redirect(303, returnTo ?? homeOf(result.viewer));
    },

    // POST /logout (requireAuth; CSRF app-wide). F-25, B-08: a POST only; GET /logout is the 404 page.
    logout: async (req, res) => {
      const { userId } = viewerOf(res);
      await endSession(req, 'You are logged out');
      req.log.info({ userId }, 'auth.logout');
      res.redirect(303, AFTER_SESSION_END);
    },

    // GET /account/delete (requireAuth)
    showDeleteAccount: (req, res) => {
      renderDeleteAccount(req, res);
    },

    // POST /account/delete (requireAuth, reauth; CSRF app-wide)
    deleteAccount: async (req, res) => {
      const { userId } = viewerOf(res);
      const parsed = parseForm(DeleteAccountForm, req.body);
      if (!parsed.ok) {
        renderDeleteAccount(req, res, { errors: parsed.errors, status: 422 });
        return;
      }

      const result = await service.deleteAccount(userId, parsed.data);
      if (!result.ok) {
        renderDeleteAccount(req, res, { errors: { currentPassword: ACCOUNT_MESSAGES.wrongPassword }, status: 422 });
        return;
      }

      // F-68: the old session entry is deleted, the new anonymous one only carries the confirmation.
      await endSession(req, 'Your account was deleted');
      if (result.deleted) req.log.info({ userId }, 'account.deleted');
      res.redirect(303, AFTER_SESSION_END);
    },
  };
}
