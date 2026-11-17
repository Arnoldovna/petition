import { pageHref } from '../http/pagination.js';
import type { AssetResolver } from './assets.js';

interface HelperDeps {
  assets: AssetResolver;
  /** `APP_TIME_ZONE` (IANA, validated by config/env.ts): the zone dates are shown in. */
  timeZone: string;
}

/**
 * The trailing argument Handlebars passes to every helper. Only `data.root` (the page model merged with `res.locals`)
 * is read; the shape is checked at runtime, so the helpers need no import from the handlebars package.
 */
interface HelperOptions {
  data?: { root?: unknown };
}

/** HTML ids and field names of this app: an ASCII letter, then letters, digits, `_` and `-` (form.ts field names). */
const ID_PART = /^[A-Za-z][\w-]*$/;

function requireCount(helper: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${helper}: expects a non-negative number`);
  }
  return value;
}

function requireText(helper: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${helper}: expects a non-empty string`);
  return value;
}

function requireIdPart(helper: string, value: unknown): string {
  if (typeof value !== 'string' || !ID_PART.test(value)) throw new TypeError(`${helper}: expects an id-safe name`);
  return value;
}

function toDate(value: unknown): Date {
  const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : undefined;
  if (date === undefined || Number.isNaN(date.getTime()))
    throw new TypeError('formatDate: expects a Date or ISO string');
  return date;
}

function currentPathOf(options: unknown): string | undefined {
  const root = (options as HelperOptions | undefined)?.data?.root;
  if (typeof root !== 'object' || root === null || !('currentPath' in root)) return undefined;
  return typeof root.currentPath === 'string' ? root.currentPath : undefined;
}

const countFormat = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const pluralRules = new Intl.PluralRules('en-GB');

/** A count in the en-GB format of OVERVIEW.md section 15.4: `1284` -> `1,284`. The `formatCount` helper uses it. */
export function formatCount(count: number): string {
  return countFormat.format(count);
}

/** `singular` for a count of one, else `pluralForm` (en-GB plural rules, B-75). The `plural` helper uses it. */
export function pluralWord(count: number, singular: string, pluralForm: string): string {
  return pluralRules.select(count) === 'one' ? singular : pluralForm;
}

/**
 * The supporters-by-city page of `city` (ADR 0007): `Frankfurt/Main` -> `/supporters/city/Frankfurt%2FMain`, which
 * Express matches as one segment and decodes back. The city is user input; encoding keeps it inside the path segment.
 * The one place that builds this path: the `cityPath` helper (row links) and the city page's pagination both use it.
 */
export function cityPath(city: string): string {
  return `/supporters/city/${encodeURIComponent(city)}`;
}

/**
 * Handlebars helpers (ADR 0014), registered once in `engine.ts`. Every helper returns a plain value that Handlebars
 * escapes; none returns HTML (`{{{ }}}` is banned in every view, B-01). A helper called with the wrong kind of value
 * throws: that is a template bug, and `renderPage` turns it into the plain 500 page instead of printing nonsense.
 *
 * Formats are en-GB (OVERVIEW.md section 15.4): counts `1,284`, dates `15 Nov 2026` in `APP_TIME_ZONE`.
 */
export function createHelpers({ assets, timeZone }: HelperDeps) {
  const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone });

  return {
    /** `{{asset "app.css"}}` -> `/assets/app-<hash>.css` (production) or `/assets/app.css` (development). */
    asset: (logicalName: unknown): string => assets(requireText('asset', logicalName)),

    /** `{{#if (eq method "drawn")}}`: strict equality. */
    eq: (left: unknown, right: unknown): boolean => left === right,

    /**
     * `{{formatCount total}} {{plural total "supporter" "supporters"}}` -> "1 supporter", "0 supporters",
     * "1,284 supporters" (B-75: the legacy copy had no singular). Returns the word only.
     */
    plural: (count: unknown, singular: unknown, pluralForm: unknown): string =>
      pluralWord(requireCount('plural', count), requireText('plural', singular), requireText('plural', pluralForm)),

    /** `1284` -> `1,284`. */
    formatCount: (count: unknown): string => formatCount(requireCount('formatCount', count)),

    /** A signing date as `15 Nov 2026` in `APP_TIME_ZONE`, so a signature at 23:30 UTC shows the local day. */
    formatDate: (value: unknown): string => dateFormat.format(toDate(value)),

    /** The supporters-by-city link of a row (`cityPath` above). */
    cityPath: (city: unknown): string => cityPath(requireText('cityPath', city)),

    /**
     * The canonical URL of a list page (ADR 0006), built by `pageHref` like the pagination links: page 1 is the bare
     * path, every other page adds `?page=n`. `basePath` is an app path that is already encoded (`cityPath` output or
     * `/supporters`).
     */
    pagePath: (basePath: unknown, page: unknown): string => {
      if (typeof page !== 'number') throw new TypeError('pagePath: expects a page number of at least 1');
      return pageHref(requireText('pagePath', basePath), page);
    },

    /**
     * A field id that is unique on a page with two forms sharing a field name: `{{fieldId "typed" "typedName"}}` ->
     * `typed-typedName`. The single-form partials use the bare field name, which the error summary links to.
     */
    fieldId: (form: unknown, name: unknown): string =>
      `${requireIdPart('fieldId', form)}-${requireIdPart('fieldId', name)}`,

    /**
     * `{{#with (currentAttr "/about")}} aria-current="{{this}}"{{/with}}`: `page` when the link points to the current
     * page (`currentPath` from viewLocals), else an empty string, so the attribute is printed only there (F-14).
     */
    currentAttr: (path: unknown, options?: unknown): string =>
      requireText('currentAttr', path) === currentPathOf(options) ? 'page' : '',
  };
}
