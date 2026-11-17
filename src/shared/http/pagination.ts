/**
 * Numbered offset pagination for the supporters list and city pages (ADR 0006, F-54, F-59). Pure functions: the
 * repository receives `limit`/`offset`, the controller decides 404 with `isPageInRange` and passes the view model to
 * the `pagination` partial.
 */

/** Pages shown on each side of the current one (ADR 0006: "current plus and minus 2"). */
const WINDOW = 2;

interface PageSlice {
  limit: number;
  offset: number;
  /** The number of the first row on this page, for `<ol start="...">` (F-54). */
  firstNumber: number;
}

/** A link to one page, or a gap (ellipsis) between two non-adjacent page numbers. */
type PaginationItem = { gap: false; page: number; href: string; current: boolean } | { gap: true };

interface PaginationLink {
  page: number;
  href: string;
}

/** The `pagination` partial's view model (OVERVIEW.md section 15.2). */
export interface PaginationView {
  current: number;
  last: number;
  previous: PaginationLink | undefined;
  next: PaginationLink | undefined;
  items: readonly PaginationItem[];
}

interface PageRequest {
  /** 1-based, already validated as an integer of at least 1 (`pageQuery`, ROUTES.md section 1). */
  page: number;
  pageSize: number;
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
}

export function pageSlice({ page, pageSize }: PageRequest): PageSlice {
  assertPositiveInteger('page', page);
  assertPositiveInteger('pageSize', pageSize);
  const offset = (page - 1) * pageSize;
  return { limit: pageSize, offset, firstNumber: offset + 1 };
}

/** The number of the last page; an empty list still has page 1 (it shows the empty state, F-55, F-58). */
function lastPage(total: number, pageSize: number): number {
  assertPositiveInteger('pageSize', pageSize);
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize));
}

/** False for a page beyond the last one, which the controller answers with the 404 page (ADR 0006). */
export function isPageInRange({ page, pageSize }: PageRequest, total: number): boolean {
  return Number.isInteger(page) && page >= 1 && page <= lastPage(total, pageSize);
}

/**
 * The canonical URL of a list page (ADR 0006): page 1 is the bare path (no `?page=1` duplicate), every other page adds
 * `?page=n`. `basePath` is an app path that is already encoded (`/supporters`, `/supporters/city/Frankfurt%2FMain`).
 * The one place that builds these URLs: `buildPagination` and the `pagePath` view helper both call it. A base path
 * that could leave the origin (`//host`, a backslash after the slash, an absolute URL) or a page below 1 is a
 * programming error and throws.
 */
export function pageHref(basePath: string, page: number): string {
  if (!basePath.startsWith('/') || basePath.startsWith('//') || basePath.startsWith('/\\')) {
    throw new TypeError('pageHref: expects an app path');
  }
  if (!Number.isSafeInteger(page) || page < 1) throw new TypeError('pageHref: expects a page number of at least 1');
  return page === 1 ? basePath : `${basePath}?page=${String(page)}`;
}

/** First, last, and the window around the current page; a gap of exactly one page shows that page instead. */
function visiblePages(current: number, last: number): number[] {
  const pages = new Set([1, last]);
  for (let page = current - WINDOW; page <= current + WINDOW; page++) {
    if (page >= 1 && page <= last) pages.add(page);
  }
  const sorted = [...pages].sort((a, b) => a - b);
  // An ellipsis is never shorter than the single number it would hide.
  for (let index = 1; index < sorted.length; index++) {
    const before = sorted[index - 1];
    const after = sorted[index];
    if (before !== undefined && after !== undefined && after - before === 2) pages.add(before + 1);
  }
  return [...pages].sort((a, b) => a - b);
}

/**
 * The pagination view model (ADR 0006): numbered links with `current` for `aria-current="page"`, gaps, and
 * previous/next links. `undefined` when everything fits on one page, so the partial renders no navigation at all.
 */
export function buildPagination(
  { page, pageSize }: PageRequest,
  total: number,
  basePath: string,
): PaginationView | undefined {
  const last = lastPage(total, pageSize);
  if (last === 1 || !isPageInRange({ page, pageSize }, total)) return undefined;

  const link = (target: number): PaginationLink => ({ page: target, href: pageHref(basePath, target) });
  const items: PaginationItem[] = [];
  let previousShown = 0;
  for (const shown of visiblePages(page, last)) {
    if (shown - previousShown > 1) items.push({ gap: true });
    items.push({ gap: false, ...link(shown), current: shown === page });
    previousShown = shown;
  }
  return {
    current: page,
    last,
    previous: page > 1 ? link(page - 1) : undefined,
    next: page < last ? link(page + 1) : undefined,
    items,
  };
}
