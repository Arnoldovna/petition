import { isPageInRange, pageSlice } from '../../shared/http/pagination.js';
import type { SupporterFilter, SupporterRow, SupportersRepository } from './supporters.repository.js';
import type { SupporterView, SupportersPage } from './supporters.schema.js';

export interface SupportersServiceDeps {
  repository: SupportersRepository;
  /** Rows per page (ADR 0006: 50). */
  pageSize: number;
}

/**
 * Expected outcomes are values (ADR 0008): a page beyond the last one is `page-not-found`, which the controller
 * answers with the 404 page (ADR 0006). An empty list is page 1 with `total` 0 (the empty state, F-55, F-58).
 */
export type SupportersPageResult = { ok: true; value: SupportersPage } | { ok: false; reason: 'page-not-found' };

export type SupportersService = ReturnType<typeof createSupportersService>;

const LINKABLE_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * The homepage as a link target, or undefined. The profile form and the `profiles_homepage_url_chk` constraint already
 * allow only http(s) URLs (B-18); this second check keeps a `javascript:` or `data:` URL out of an `href` even if a
 * row ever bypassed both (B-01, defence in depth).
 */
function linkableHomepage(value: string | null): string | undefined {
  if (value === null || !URL.canParse(value)) return undefined;
  return LINKABLE_PROTOCOLS.has(new URL(value).protocol) ? value : undefined;
}

/** Row -> view: absent optional fields stay absent, so the row renders no empty slots (F-52, B-17). */
function toSupporterView(row: SupporterRow): SupporterView {
  const homepageUrl = linkableHomepage(row.homepageUrl);
  return {
    fullName: `${row.firstName} ${row.lastName}`,
    ...(homepageUrl === undefined ? {} : { homepageUrl }),
    ...(row.age === null ? {} : { age: row.age }),
    ...(row.city === null ? {} : { city: row.city }),
    signedAt: row.signedAt.toISOString(),
  };
}

/** Read-only rules of the supporters list and the city pages (ADR 0006, ADR 0007). Depends on the interface only. */
export function createSupportersService({ repository, pageSize }: SupportersServiceDeps) {
  async function listPage(page: number, filter: SupporterFilter): Promise<SupportersPageResult> {
    const { limit, offset, firstNumber } = pageSlice({ page, pageSize });
    // Rows and total are independent queries over the same base, so they run concurrently (B-52). A page beyond the
    // last one simply returns no rows; the total decides.
    const [rows, total] = await Promise.all([repository.list({ ...filter, limit, offset }), repository.count(filter)]);
    if (!isPageInRange({ page, pageSize }, total)) return { ok: false, reason: 'page-not-found' };
    return { ok: true, value: { page, pageSize, total, firstNumber, supporters: rows.map(toSupporterView) } };
  }

  return {
    /** `GET /supporters`: every signer, with or without a profile (F-51, B-30). */
    listSupporters: ({ page }: { page: number }): Promise<SupportersPageResult> => listPage(page, {}),

    /** `GET /supporters/city/:city`: signers whose profile city matches case-insensitively (F-56, ADR 0007). */
    listSupportersFromCity: ({ city, page }: { city: string; page: number }): Promise<SupportersPageResult> =>
      listPage(page, { city }),

    /** The total of the unfiltered list, injected into the thank-you page (F-47, ADR 0006). */
    countSupporters: (): Promise<number> => repository.count({}),
  };
}
