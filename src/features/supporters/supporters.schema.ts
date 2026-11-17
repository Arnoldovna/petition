import { z } from 'zod';

import { cityParam, pageQuery } from '../../shared/validation/fields.js';

/**
 * Request schemas and view types of the supporters module (OVERVIEW.md section 8, ROUTES.md section 6). The field
 * rules come from `shared/validation/fields.ts`; an invalid value is the 404 page, never a form error (ADR 0006,
 * ADR 0007).
 */

/** `GET /supporters?page=` and `GET /supporters/city/:city?page=`; unknown query keys are ignored. */
export const SupportersQuery = z.object({ page: pageQuery });
export type SupportersQuery = z.infer<typeof SupportersQuery>;

/** `:city` as Express decoded it, normalised like the stored city (ADR 0007, B-32). */
export const CityParams = z.object({ city: cityParam });
export type CityParams = z.infer<typeof CityParams>;

/**
 * One row of the supporters list (partial `supporter-row`). Plain values only; the views escape every one of them
 * (F-53, B-01). Optional fields are absent rather than empty, so the row prints no stray separators (F-52, B-17).
 */
export interface SupporterView {
  fullName: string;
  /** An absolute `http:` or `https:` URL, or absent; the name links to it in the same tab (F-52, B-17). */
  homepageUrl?: string;
  age?: number;
  city?: string;
  /** ISO 8601 timestamp of the signature: `<time datetime>` and the `formatDate` helper (F-52). */
  signedAt: string;
}

/** One page of supporters, from one shared base query for rows and total (ADR 0006, F-47). */
export interface SupportersPage {
  /** 1-based, within range. */
  page: number;
  /** Rows per page, for the pagination view model (`buildPagination`). */
  pageSize: number;
  /** All matching supporters, not only this page's rows (F-54). */
  total: number;
  /** The number of the first row on this page, for `<ol start>` (F-54). */
  firstNumber: number;
  supporters: readonly SupporterView[];
}
