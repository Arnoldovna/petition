import { z } from 'zod';

import type { FormView } from '../../shared/http/form.js';
import type { PageModel } from '../../shared/view/render.js';
import { typedName } from '../../shared/validation/fields.js';
import { SIGNATURE_GLYPHS, SIGNATURE_REJECTIONS } from './image/index.js';

/**
 * Form schemas and view models of the signature pages (OVERVIEW.md section 8, ROUTES.md section 5). Field names are
 * the single source of truth for markup, schemas and tests: `method`, `signature`, `typedName`, `_csrf`.
 */

/**
 * The two forms of the sign page post to the same route and say which one they are with a hidden `method` field.
 * The browser always sends it, so a body without a known method is malformed (400), not a form error.
 */
export const SignMethodBody = z.object({ method: z.enum(['drawn', 'typed']) });

/**
 * The drawn form. An empty `signature` is an empty pad (no JavaScript blank check ran): "Please sign before
 * submitting" (F-41). Everything else about the value is decided by the image pipeline (ADR 0004), which returns its
 * own messages.
 */
const DrawnSignForm = z.object({
  method: z.literal('drawn'),
  signature: z.string({ error: SIGNATURE_REJECTIONS.blank }).min(1, { error: SIGNATURE_REJECTIONS.blank }),
});

/** The typed form (F-45, ADR 0005): the name must be drawable with the shipped fonts. */
const TypedSignForm = z.object({
  method: z.literal('typed'),
  typedName: typedName(SIGNATURE_GLYPHS),
});

/** `POST /signature` (ROUTES.md section 5): a discriminated union on `method`. */
export const SignForm = z.discriminatedUnion('method', [DrawnSignForm, TypedSignForm]);

export type SignInput = z.infer<typeof SignForm>;

/** `pages/signature/sign`: the greeting, both forms and the export size the pad needs (ADR 0004 item 1). */
export interface SignPageView extends PageModel {
  heading: string;
  scripts: readonly string[];
  /** Values and errors of the typed form, and the error summary for both forms (F-21). */
  form: FormView;
  /** The drawn form's message next to the pad, when a drawn submission was rejected (F-41, F-42). */
  padError: string | undefined;
  exportWidth: number;
  exportHeight: number;
}

/** `pages/signature/thank-you` (F-46). */
export interface ThankYouView extends PageModel {
  supporterCount: number;
  imageSrc: string;
}

/** `pages/signature/delete` (F-50, ADR 0013). */
export interface DeleteSignatureView extends PageModel {
  consequences: readonly string[];
}
