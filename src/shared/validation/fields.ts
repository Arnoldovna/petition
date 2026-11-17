import { z } from 'zod';

import { safeReturnTo as toSafeReturnTo } from '../http/redirect.js';

/**
 * One Zod schema per form field concept (OVERVIEW.md section 8). Rules and messages are ROUTES.md section 1; the
 * messages are the exact user-facing strings. Feature schemas compose these into form schemas
 * (`z.object({ email, password: newPassword })`); `parseForm` reports the first message per field (ADR 0008).
 *
 * Every field reports exactly one issue: the rule is a pure `parse` function that returns the normalised value or the
 * first failing message, wrapped by `field()`. A value that is not a string (missing, or an array from a repeated
 * field) gets the field's "missing" message.
 *
 * Lengths are counted in Unicode code points, like PostgreSQL's `char_length` in the CHECK constraints
 * (DATA-MODEL.md section 3), so `'é'` and `'😀'` are one character each.
 */

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (message: string): Parsed<never> => ({ ok: false, message });

/** Code points on purpose (not grapheme clusters): that is what PostgreSQL's `char_length` counts. */
function codePoints(value: string): string[] {
  return Array.from(value);
}

function codePointLength(value: string): number {
  return codePoints(value).length;
}

/** The value of `parsed`, or its message as the field's one issue. */
function unwrap<T>(parsed: Parsed<T>, ctx: z.RefinementCtx, input: unknown): T {
  if (parsed.ok) return parsed.value;
  ctx.issues.push({ code: 'custom', message: parsed.message, input });
  return z.NEVER;
}

/** A required string field: not a string -> `missing`; otherwise `parse` decides. */
function field<T>(missing: string, parse: (raw: string) => Parsed<T>) {
  return z.string({ error: missing }).transform((raw, ctx) => unwrap(parse(raw), ctx, raw));
}

/** An optional form field: absent counts as empty, so a crafted request without the field cannot fail differently. */
function optionalField<T>(invalid: string, parse: (raw: string) => Parsed<T>) {
  return z
    .string({ error: invalid })
    .optional()
    .transform((raw, ctx) => unwrap(parse(raw ?? ''), ctx, raw));
}

/** Control characters that are not whitespace (NUL, BEL, ESC, DEL, C1). Whitespace ones are collapsed instead. */
const NON_WHITESPACE_CONTROL = /(?!\s)\p{Cc}/gu;
/**
 * Invisible format characters (Unicode category Cf): bidi overrides, embeddings and isolates (U+202A to U+202E,
 * U+2066 to U+2069), direction marks (U+200E, U+200F, U+061C), zero-width space and word joiner (U+200B, U+2060), the
 * byte order mark (U+FEFF), the soft hyphen and the tag characters. Zero-width non-joiner and joiner (U+200C, U+200D)
 * stay, because Persian and Indic spellings need them.
 */
const INVISIBLE_FORMAT = /[\p{Cf}--[\u200C\u200D]]/gv;
const WHITESPACE_RUN = /\s+/gu;

/**
 * NFC, control characters removed, whitespace runs collapsed to one space, trimmed (ROUTES.md section 1, ADR 0007).
 * Control characters cannot be typed into a form field; they only arrive in crafted requests. Removing them keeps the
 * stored text inside the DB CHECKs (`!~ '[[:cntrl:]]'`) and keeps NUL away from PostgreSQL, which rejects it in
 * `text` with an error instead of a constraint violation.
 *
 * The typed name uses this form directly: its character rule rejects every invisible character anyway.
 */
function normaliseText(value: string): string {
  return value.normalize('NFC').replace(NON_WHITESPACE_CONTROL, '').replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * `normaliseText` for text that is shown as text to other visitors (names, cities), with the invisible format
 * characters removed as well. They arrive in pasted or crafted input: a bidi override inside a name would reorder the
 * rest of its row on the public supporters list (spoofing), and a zero-width character would make `Berl<U+200B>in` a
 * second city that looks exactly like `Berlin`.
 */
function normaliseShownText(value: string): string {
  return normaliseText(value.replace(INVISIBLE_FORMAT, ''));
}

// ---------------------------------------------------------------------------------------------------------------
// Names and email (F-19, B-24, ADR 0007)
// ---------------------------------------------------------------------------------------------------------------

const NAME_MAX = 100;

function name(missing: string, tooLong: string) {
  return field(missing, (raw) => {
    const value = normaliseShownText(raw);
    if (value.length === 0) return fail(missing);
    if (codePointLength(value) > NAME_MAX) return fail(tooLong);
    return ok(value);
  });
}

export const firstName = name('Enter your first name', 'First name must be 100 characters or fewer');
export const lastName = name('Enter your last name', 'Last name must be 100 characters or fewer');

const EMAIL_MISSING = 'Enter an email address';
const EMAIL_INVALID = 'Enter a valid email address, like name@example.com';

/**
 * Normalise **before** the format check (ADR 0007): in Zod 4 a format schema checks first, so
 * `z.email().trim().toLowerCase()` would reject `' Ada@Example.com '`. Zod's default email pattern is ASCII, so the
 * JavaScript and PostgreSQL lower-casing agree for every accepted address.
 */
export const email = z
  .string({ error: EMAIL_MISSING })
  .trim()
  .toLowerCase()
  .min(1, { error: EMAIL_MISSING, abort: true })
  .max(254, { error: EMAIL_INVALID, abort: true })
  .pipe(z.email({ error: EMAIL_INVALID }));

// ---------------------------------------------------------------------------------------------------------------
// Passwords (F-19, F-27, ADR 0009): never trimmed, no composition rules
// ---------------------------------------------------------------------------------------------------------------

const PASSWORD_MIN = 12;
const PASSWORD_MAX = 128;
const PASSWORD_MISSING = 'Enter a password';
const CURRENT_PASSWORD_MISSING = 'Enter your current password';

function parseNewPassword(raw: string): Parsed<string> {
  if (raw.length === 0) return fail(PASSWORD_MISSING);
  const length = codePointLength(raw);
  if (length < PASSWORD_MIN) return fail('Password must be at least 12 characters');
  if (length > PASSWORD_MAX) return fail('Password must be 128 characters or fewer');
  return ok(raw);
}

/** A password that will be hashed and stored: register `password`, profile edit `newPassword`. */
export const newPassword = field(PASSWORD_MISSING, parseNewPassword);

/** Profile edit `newPassword`: empty keeps the current password (`null`), anything else follows `newPassword`. */
export const optionalNewPassword = optionalField(PASSWORD_MISSING, (raw) =>
  raw.length === 0 ? ok(null) : parseNewPassword(raw),
);

/**
 * The login `password`: only "present" is checked. Length rules are not applied, so an old or mistyped password
 * gets the one generic 401 message (F-24), never a hint about the policy.
 */
export const loginPassword = field(PASSWORD_MISSING, (raw) => (raw.length === 0 ? fail(PASSWORD_MISSING) : ok(raw)));

/** Re-authentication (`POST /account/delete`, F-67): the current password is required. */
export const currentPassword = field(CURRENT_PASSWORD_MISSING, (raw) =>
  raw.length === 0 ? fail(CURRENT_PASSWORD_MISSING) : ok(raw),
);

/**
 * Profile edit `currentPassword`: may be empty (`null`); the service requires it only when the email or the password
 * changes (F-63) and then reports "Enter your current password to change your email or password".
 */
export const optionalCurrentPassword = optionalField(CURRENT_PASSWORD_MISSING, (raw) =>
  ok(raw.length === 0 ? null : raw),
);

// ---------------------------------------------------------------------------------------------------------------
// Optional profile fields (F-34, F-35, B-18, B-26, B-27): empty -> null
// ---------------------------------------------------------------------------------------------------------------

const AGE_INVALID = 'Age must be a whole number between 1 and 120';
const AGE_PATTERN = /^\d{1,3}$/;

/**
 * `''` -> `null`; otherwise one to three ASCII digits, 1..120. Surrounding spaces are ignored (a pasted `' 42'`), but
 * decimals, signs, exponents and words are rejected rather than coerced (B-27).
 */
export const optionalAge = optionalField(AGE_INVALID, (raw) => {
  const value = raw.trim();
  if (value.length === 0) return ok(null);
  if (!AGE_PATTERN.test(value)) return fail(AGE_INVALID);
  const age = Number.parseInt(value, 10);
  return age >= 1 && age <= 120 ? ok(age) : fail(AGE_INVALID);
});

const CITY_MAX = 100;
const CITY_TOO_LONG = 'City must be 100 characters or fewer';

/** `''` (also whitespace only) -> `null`; otherwise normalised text of at most 100 characters (ADR 0007). */
export const optionalCity = optionalField(CITY_TOO_LONG, (raw) => {
  const value = normaliseShownText(raw);
  if (value.length === 0) return ok(null);
  return codePointLength(value) <= CITY_MAX ? ok(value) : fail(CITY_TOO_LONG);
});

const HOMEPAGE_INVALID = 'Enter a web address like https://example.com';
const HOMEPAGE_MAX = 300;
/**
 * A `scheme:` prefix (RFC 3986 scheme characters without the dot). The dot is left out so `example.com:8080` counts as
 * a host with a port, not as the scheme `example.com`; every scheme with a dot would be rejected anyway.
 */
const SCHEME_PREFIX = /^[a-z][a-z\d+-]*:/i;

/**
 * `''` -> `null`; trim; prepend `https://` only when no scheme is present, so `https://example.com` never becomes
 * `https://https://example.com` (B-18); parse with the WHATWG URL parser; only `http:`/`https:`, a host with a dot, no
 * credentials, and the normalised `href` at most 300 characters. The stored value is that `href`.
 */
export const optionalHomepage = optionalField(HOMEPAGE_INVALID, (raw) => {
  const value = raw.trim();
  if (value.length === 0) return ok(null);

  let url: URL;
  try {
    url = new URL(SCHEME_PREFIX.test(value) ? value : `https://${value}`);
  } catch {
    return fail(HOMEPAGE_INVALID);
  }
  const valid =
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.hostname.includes('.') &&
    url.username === '' &&
    url.password === '' &&
    url.href.length <= HOMEPAGE_MAX;
  return valid ? ok(url.href) : fail(HOMEPAGE_INVALID);
});

// ---------------------------------------------------------------------------------------------------------------
// Typed signature name (F-45, ADR 0005)
// ---------------------------------------------------------------------------------------------------------------

/** An inclusive code-point range `[first, last]`, the format of `glyphs.generated.ts` (ADR 0005). */
export type CodePointRange = readonly [first: number, last: number];

/** The code points the signature fonts can draw. `typedName` only asks whether one is in it. */
export interface GlyphSet {
  has(codePoint: number): boolean;
}

function inRanges(ranges: readonly CodePointRange[], codePoint: number): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (range === undefined) return false;
    if (codePoint < range[0]) high = middle - 1;
    else if (codePoint > range[1]) low = middle + 1;
    else return true;
  }
  return false;
}

/**
 * The union of sorted, non-overlapping range lists, e.g. `glyphSetFromRanges(PRIMARY, FALLBACK)` from
 * `glyphs.generated.ts`. Each lookup is a binary search per list.
 */
export function glyphSetFromRanges(...lists: readonly (readonly CodePointRange[])[]): GlyphSet {
  return { has: (codePoint) => lists.some((ranges) => inRanges(ranges, codePoint)) };
}

const TYPED_NAME_MISSING = 'Type your full name';
const TYPED_NAME_CHARACTERS = 'Use letters, spaces, hyphens, apostrophes and full stops only';
const TYPED_NAME_GLYPHS =
  'We cannot draw some letters of this name yet. Type it in Latin, Greek or Cyrillic letters, or draw your signature.';
const TYPED_NAME_MIN = 2;
const TYPED_NAME_MAX = 60;
/** Typographic apostrophes (U+2019, U+02BC) become `'`, so `O’Brien` and `O'Brien` are the same name. */
const TYPOGRAPHIC_APOSTROPHES = /[’ʼ]/gu;
const PUNCTUATION = new Set([' ', '.', "'", '-']);
const LETTER = /^\p{L}$/u;
const LETTER_OR_MARK = /^[\p{L}\p{M}]$/u;

/**
 * Schema factory for the typed name (ROUTES.md section 1, ADR 0005). The glyph set is a parameter because it belongs
 * to the signature feature (`glyphs.generated.ts`); `shared` never imports features (OVERVIEW.md section 8).
 *
 * After normalisation the name has 2..60 characters, starts with a letter, and contains only spaces, `.`, `'`, `-` and
 * letters or combining marks; every letter and mark must be drawable with the shipped fonts. Checks run in that order,
 * so a name with an emoji gets the character message, a Chinese name the glyph message.
 *
 * The 60-character limit has no message of its own in ROUTES.md; a longer name gets "Type your full name".
 */
export function typedName(glyphs: GlyphSet) {
  return field(TYPED_NAME_MISSING, (raw) => {
    const value = normaliseText(raw.replace(TYPOGRAPHIC_APOSTROPHES, "'"));
    const characters = codePoints(value);
    if (characters.length < TYPED_NAME_MIN || characters.length > TYPED_NAME_MAX) return fail(TYPED_NAME_MISSING);
    if (!LETTER.test(characters[0] ?? '')) return fail(TYPED_NAME_CHARACTERS);

    const drawn = characters.filter((character) => !PUNCTUATION.has(character));
    if (!drawn.every((character) => LETTER_OR_MARK.test(character))) return fail(TYPED_NAME_CHARACTERS);
    const drawable = drawn.every((character) => {
      const codePoint = character.codePointAt(0);
      return codePoint !== undefined && glyphs.has(codePoint);
    });
    return drawable ? ok(value) : fail(TYPED_NAME_GLYPHS);
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Query, params and hidden fields
// ---------------------------------------------------------------------------------------------------------------

/**
 * `returnTo` (query on `GET /login`, hidden field on `POST /login`): never fails. A safe same-origin path is kept, any
 * other value becomes `undefined`, so it can never become an open redirect (F-30, `safeReturnTo` in
 * `shared/http/redirect.ts`).
 */
export const safeReturnTo = z.unknown().transform((value) => toSafeReturnTo(value));

const PAGE_PATTERN = /^\d{1,5}$/;
const PAGE_MAX = 10_000;
const PAGE_INVALID = 'Page not found';

/**
 * `?page=`: absent -> 1; otherwise 1..10000 written as one to five digits. Anything else (empty, `0`, `1.5`, a repeated
 * parameter) fails; the controller turns that into the 404 page (ROUTES.md section 1, ADR 0006).
 */
export const pageQuery = z
  .string({ error: PAGE_INVALID })
  .optional()
  .transform((raw, ctx) => {
    if (raw === undefined) return 1;
    const page = PAGE_PATTERN.test(raw) ? Number.parseInt(raw, 10) : 0;
    return unwrap(page >= 1 && page <= PAGE_MAX ? ok(page) : fail(PAGE_INVALID), ctx, raw);
  });

/**
 * `/supporters/city/:city` (decoded by Express): normalised like `optionalCity`; empty or longer than 100 characters
 * fails, which the controller turns into the 404 page (ADR 0007, B-33).
 */
export const cityParam = field(PAGE_INVALID, (raw) => {
  const value = normaliseShownText(raw);
  return value.length > 0 && codePointLength(value) <= CITY_MAX ? ok(value) : fail(PAGE_INVALID);
});
