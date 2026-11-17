import type { Request, Response } from 'express';

import { renderPage } from '../../shared/view/render.js';

/**
 * Controller of the public pages (ROUTES.md section 2). The pages read no input and own no data, so there is no
 * schema, service or repository: each handler renders a fixed view model through `renderPage`, which adds the viewer,
 * the flash and a CSRF token only for a signed-in viewer or a bound session (ADR 0003), so a guest's visit never
 * creates a session. Footer and privacy data (`contactUrl`, `imprintUrl`, `year`) come from `viewLocals`.
 */

/** One maw list row (`list-row` partial, OVERVIEW.md section 15.2): title left, meta right. */
interface RowModel {
  readonly title: string;
  readonly meta: string;
  /** Internal path; without it the row is plain text (the about page's stack list). */
  readonly href?: string;
}

/**
 * The home page rows (F-12): every step of the petition, each pointing to its own route (B-42: the legacy page linked
 * to a route that never existed). Signed-in viewers see the same rows; the guards of the targets send them where
 * they belong (ROUTES.md section 1). The titles are actions, so they are lowercase like nav links and buttons
 * (OVERVIEW.md section 15.4), the same as the thank-you and edit rows.
 */
const HOME_ROWS: readonly RowModel[] = [
  { href: '/register', title: 'register', meta: 'new here' },
  { href: '/login', title: 'log in', meta: 'have an account' },
  { href: '/profile', title: 'tell us about yourself', meta: 'optional details' },
  { href: '/signature', title: 'sign the petition', meta: 'draw or type' },
  { href: '/supporters', title: 'see all supporters', meta: 'registered users' },
  { href: '/account/delete', title: 'delete your account', meta: 'removes everything' },
];

/** The rebuild stack (F-13, B-62), in the order of ROUTES.md section 2: technology left, its role right. */
const STACK_ROWS: readonly RowModel[] = [
  { title: 'Node 26', meta: 'runtime' },
  { title: 'Express 5', meta: 'web framework' },
  { title: 'TypeScript 6', meta: 'strict types' },
  { title: 'express-handlebars', meta: 'server-rendered views' },
  { title: 'PostgreSQL 18 + Drizzle ORM', meta: 'data and migrations' },
  { title: 'Redis sessions', meta: 'login state' },
  { title: 'Zod', meta: 'input validation' },
  { title: 'argon2id', meta: 'password hashing' },
  { title: 'Tailwind CSS 4', meta: 'tokens and modular CSS' },
  { title: 'Schibsted Grotesk', meta: 'typeface' },
  { title: 'Vitest', meta: 'unit and integration tests' },
  { title: 'Playwright + axe', meta: 'end-to-end and accessibility tests' },
  { title: 'Docker', meta: 'images and local stack' },
  { title: 'GitHub Actions', meta: 'continuous integration' },
];

type PageHandler = (req: Request, res: Response) => void;

/** Handlers as properties, not methods, so the router can take them unbound. */
export interface PagesController {
  readonly home: PageHandler;
  readonly about: PageHandler;
  readonly privacy: PageHandler;
}

export function createPagesController(): PagesController {
  return {
    home: (req, res) => {
      renderPage(req, res, 'pages/home', { title: 'Home', rows: HOME_ROWS });
    },
    about: (req, res) => {
      renderPage(req, res, 'pages/about', { title: 'About', stack: STACK_ROWS });
    },
    privacy: (req, res) => {
      renderPage(req, res, 'pages/privacy', { title: 'Privacy' });
    },
  };
}
