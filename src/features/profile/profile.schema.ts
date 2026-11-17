import { z } from 'zod';

import type { FormValues } from '../../shared/http/form.js';
import {
  email,
  firstName,
  lastName,
  optionalAge,
  optionalCity,
  optionalCurrentPassword,
  optionalHomepage,
  optionalNewPassword,
} from '../../shared/validation/fields.js';

/**
 * Form schemas and view types of the profile module (OVERVIEW.md section 8, ROUTES.md section 4). Field rules and
 * messages come from `shared/validation/fields.ts`; the field names are the single source of truth for the markup,
 * the schemas and the tests (B-53). Unknown fields (a crafted `userId`, for example) are stripped by `z.object`, so
 * ownership can only ever come from the session (ADR 0002).
 */

/** `POST /profile` (F-33 to F-36): every field optional, empty -> `null` (B-26, B-27, B-18). */
export const OnboardingForm = z.object({
  age: optionalAge,
  city: optionalCity,
  homepage: optionalHomepage,
});
export type OnboardingInput = z.infer<typeof OnboardingForm>;

/**
 * `POST /profile/edit` (F-60 to F-65): names and email as at registration (F-19), the optional fields as at
 * onboarding (F-35). An empty `newPassword` keeps the password (`null`, F-63); `currentPassword` may be empty here,
 * the service requires it only when the email or the password changes (ADR 0009).
 */
export const EditProfileForm = z.object({
  firstName,
  lastName,
  email,
  age: optionalAge,
  city: optionalCity,
  homepage: optionalHomepage,
  newPassword: optionalNewPassword,
  currentPassword: optionalCurrentPassword,
});
export type EditProfileInput = z.infer<typeof EditProfileForm>;

/** The optional profile fields as stored (`profiles` row, DATA-MODEL.md section 2.3); `null` means not set. */
export interface ProfileFields {
  age: number | null;
  city: string | null;
  homepageUrl: string | null;
}

/**
 * The one business-rule message only the edit form has (ROUTES.md section 4); field-rule messages live in `fields.ts`,
 * and the two refusals the edit shares with registration and account deletion are `ACCOUNT_MESSAGES` there.
 */
export const CURRENT_PASSWORD_REQUIRED = 'Enter your current password to change your email or password';

/** The onboarding form's prefill (F-36): the stored values as form strings, empty when not set. */
export type OnboardingValues = FormValues & { age: string; city: string; homepage: string };

/** The edit form's prefill (F-60): names, email and the optional fields; the password fields always start empty. */
export type EditValues = OnboardingValues & { firstName: string; lastName: string; email: string };
