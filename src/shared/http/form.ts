import type { z } from 'zod';

/** Field name -> the first message for that field (ADR 0008). */
export type FieldErrors = Readonly<Record<string, string>>;

/** The submitted strings, for re-rendering a form after a 422/401. */
export type FormValues = Readonly<Record<string, string>>;

/** One entry of the error summary: a link to the field (partial `error-summary`, parameter `errorList`, F-21). */
interface ErrorListItem {
  field: string;
  message: string;
  href: string;
}

/** What a form view receives as `form` (partial `form-field`) and `errorList` (partial `error-summary`). */
export interface FormView {
  values: FormValues;
  errors: FieldErrors;
  errorList: readonly ErrorListItem[];
}

export type FormResult<T> = { ok: true; data: T } | { ok: false; errors: FieldErrors; values: FormValues };

/** Errors that belong to no single field (a root-level refinement) are reported under this key. */
const FORM_ERROR_KEY = '_form';

/**
 * Never echoed back into a form: passwords (ROUTES.md section 1, F-20, B-11), the CSRF token (renderPage adds a fresh
 * one, ADR 0003) and the drawn signature payload (up to 128 kB; the pad starts empty after a 422).
 */
const NOT_ECHOED: ReadonlySet<string> = new Set(['password', 'newPassword', 'currentPassword', '_csrf', 'signature']);

/**
 * The submitted values that may be rendered again: string fields only (a repeated field arrives as an array and is
 * dropped), without the fields in NOT_ECHOED. The views escape every value.
 */
export function formValues(body: unknown): FormValues {
  if (typeof body !== 'object' || body === null) return {};
  return Object.fromEntries(
    Object.entries(body).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && !NOT_ECHOED.has(entry[0]),
    ),
  );
}

function fieldErrors(issues: readonly z.core.$ZodIssue[]): FieldErrors {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const field = issue.path.length === 0 ? FORM_ERROR_KEY : String(issue.path[0]);
    // The first issue per field wins: the schemas order their checks from "missing" to "too long".
    errors[field] ??= issue.message;
  }
  return errors;
}

/**
 * Validates a urlencoded form body (ADR 0008). Expected invalid input is a value, not an exception: the controller
 * re-renders the same view with 422, `errors` and `values`.
 */
export function parseForm<T>(schema: z.ZodType<T>, body: unknown): FormResult<T> {
  const result = schema.safeParse(body);
  if (result.success) return { ok: true, data: result.data };
  return { ok: false, errors: fieldErrors(result.error.issues), values: formValues(body) };
}

/**
 * The error summary links to `#<field name>`: the `form-field` partial uses the field name as the input id. A
 * form-level error links to the form's heading area (`#main`).
 */
function errorList(errors: FieldErrors): ErrorListItem[] {
  return Object.entries(errors).map(([field, message]) => ({
    field,
    message,
    href: field === FORM_ERROR_KEY ? '#main' : `#${field}`,
  }));
}

/**
 * The view model of a form: empty for the first GET, prefilled for an edit page, or the values and errors of a failed
 * submission. Business-rule failures (email taken, wrong password) add their message with `{ ...errors, email: ... }`.
 */
export function formView(values: FormValues = {}, errors: FieldErrors = {}): FormView {
  return { values, errors, errorList: errorList(errors) };
}
