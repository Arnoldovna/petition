import type { Request, Response } from 'express';

import { NotFoundError } from '../../shared/errors/app-error.js';
import { buildPagination } from '../../shared/http/pagination.js';
import { cityPath, formatCount, pluralWord } from '../../shared/view/helpers.js';
import { renderPage } from '../../shared/view/render.js';
import { CityParams, SupportersQuery, type SupportersPage } from './supporters.schema.js';
import type { SupportersPageResult, SupportersService } from './supporters.service.js';

const LIST_PATH = '/supporters';

/** Unique per page (F-16): page 1 is the bare title, later pages add their number (ROUTES.md section 6). */
function pageTitle(base: string, page: number): string {
  return page === 1 ? base : `${base}, page ${String(page)}`;
}

/**
 * The page-heading lead, "1 supporter" or "1,284 supporters" (F-54: the total is shown), with the functions behind the
 * `formatCount` and `plural` view helpers (OVERVIEW.md section 15.4). Absent for an empty list, whose empty state says
 * it (F-55, F-58).
 */
function totalLead(total: number): string | undefined {
  if (total === 0) return undefined;
  return `${formatCount(total)} ${pluralWord(total, 'supporter', 'supporters')}`;
}

/** An invalid `page` or `city`, or a page beyond the last one, is the 404 page (ROUTES.md section 6, ADR 0006). */
function pageOrNotFound(result: SupportersPageResult): SupportersPage {
  if (!result.ok) throw new NotFoundError('Supporters page');
  return result.value;
}

/** The list part of both page models: rows, total, `<ol start>` and the pagination view model (F-54, F-59). */
function listModel(value: SupportersPage, basePath: string) {
  return {
    lead: totalLead(value.total),
    total: value.total,
    firstNumber: value.firstNumber,
    supporters: value.supporters,
    pagination: buildPagination({ page: value.page, pageSize: value.pageSize }, value.total, basePath),
  };
}

/** HTTP <-> service only: parse the request, branch on the Result, render the view model. No SQL, no rules. */
export function createSupportersController(service: SupportersService) {
  return {
    /** `GET /supporters` (F-51 to F-55). */
    list: async (req: Request, res: Response): Promise<void> => {
      const query = SupportersQuery.safeParse(req.query);
      if (!query.success) throw new NotFoundError('Supporters page');
      const value = pageOrNotFound(await service.listSupporters(query.data));
      renderPage(req, res, 'pages/supporters/list', {
        title: pageTitle('Supporters', value.page),
        ...listModel(value, LIST_PATH),
      });
    },

    /** `GET /supporters/city/:city` (F-56 to F-59). The heading is the requested city, never a row's (B-33). */
    city: async (req: Request, res: Response): Promise<void> => {
      const params = CityParams.safeParse(req.params);
      const query = SupportersQuery.safeParse(req.query);
      if (!params.success || !query.success) throw new NotFoundError('Supporters page');
      const { city } = params.data;
      const value = pageOrNotFound(await service.listSupportersFromCity({ city, page: query.data.page }));
      const heading = `Supporters from ${city}`;
      renderPage(req, res, 'pages/supporters/city', {
        title: pageTitle(heading, value.page),
        heading,
        emptyTitle: `No supporters from ${city} yet`,
        ...listModel(value, cityPath(city)),
      });
    },
  };
}

export type SupportersController = ReturnType<typeof createSupportersController>;
