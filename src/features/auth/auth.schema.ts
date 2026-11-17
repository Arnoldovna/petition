import { z } from 'zod';

import type { FormView } from '../../shared/http/form.js';
import type { PageModel } from '../../shared/view/render.js';
import {
  currentPassword,
  email,
  firstName,
  lastName,
  loginPassword,
  newPassword,
  safeReturnTo,
} from '../../shared/validation/fields.js';

/**
 * The forms and the query of the auth module (ROUTES.md section 3, OVERVIEW.md section 8), composed from the shared
 * field rules (`shared/validation/fields.ts`), so every message is the exact user-facing string of ROUTES.md
 * section 1. `z.object` strips unknown keys, so `_csrf` and anything a crafted request adds never reach a service.
 * Field names are the single source of truth for markup, schemas and tests (B-53).
 */

/** `POST /register` (F-18, F-19, B-24): names and email normalised, the password checked against the 12..128 rule. */
export const RegisterForm = z.object({ firstName, lastName, email, password: newPassword });
export type RegisterInput = z.infer<typeof RegisterForm>;

/**
 * `POST /login` (F-23, F-24, F-30): the password is only checked for presence (`loginPassword`), so a failed login
 * never hints at the policy; an unsafe `returnTo` silently becomes `undefined` (no open redirect).
 */
export const LoginForm = z.object({ email, password: loginPassword, returnTo: safeReturnTo });
export type LoginInput = z.infer<typeof LoginForm>;

/** `GET /login?returnTo=` (F-30): never fails; an unsafe or repeated value is dropped. */
export const LoginQuery = z.object({ returnTo: safeReturnTo });

/** `POST /account/delete` (F-67, ADR 0013): re-authentication with the current password. */
export const DeleteAccountForm = z.object({ currentPassword });
export type DeleteAccountInput = z.infer<typeof DeleteAccountForm>;

// ---------------------------------------------------------------------------------------------------------------
// View models (what the templates in src/views/pages/auth/ receive; renderPage adds viewer, csrfToken and flash)
// ---------------------------------------------------------------------------------------------------------------

/** `pages/auth/register`. `emailTaken` adds the "log in instead" link next to the email error (F-20). */
export interface RegisterView extends PageModel {
  title: 'Register';
  form: FormView;
  emailTaken: boolean;
}

/** `pages/auth/login`. `returnTo` is rendered as a hidden field only when it is a safe same-origin path (F-30). */
export interface LoginView extends PageModel {
  title: 'Log in';
  form: FormView;
  returnTo: string | undefined;
}

/** `pages/auth/account-delete` (F-67): what is deleted, as plain strings for the confirm panel. */
export interface DeleteAccountView extends PageModel {
  title: 'Delete account';
  form: FormView;
  consequences: readonly string[];
}
