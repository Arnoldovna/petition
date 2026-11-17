import type { HTMLElement } from 'node-html-parser';
import type request from 'supertest';

import { parse } from './html.js';

/** A Supertest agent: keeps cookies between requests like a browser (`request.agent(app)`). */
export type Agent = ReturnType<typeof request.agent>;

/** What a rendered form gives the next request: the CSRF token and the current field values. */
export interface FormState {
  /** `_csrf` of the form, or of any form on the page (one token per session, ADR 0003). */
  csrf: string;
  /** Named fields of the form except `_csrf`: inputs (checked boxes only), textareas and selected options. */
  values: Record<string, string>;
}

const CSRF_FIELD = 'input[name="_csrf"]';

function fieldValues(form: HTMLElement | null): Record<string, string> {
  if (form === null) return {};
  const values: Record<string, string> = {};
  for (const field of form.querySelectorAll('input[name], textarea[name], select[name]')) {
    const name = field.getAttribute('name') ?? '';
    const type = (field.getAttribute('type') ?? '').toLowerCase();
    if (name === '_csrf' || ((type === 'checkbox' || type === 'radio') && !field.hasAttribute('checked'))) continue;
    if (field.tagName === 'TEXTAREA') values[name] = field.text;
    else if (field.tagName === 'SELECT') {
      const option = field.querySelector('option[selected]') ?? field.querySelector('option');
      values[name] = option?.getAttribute('value') ?? option?.text ?? '';
    } else values[name] = field.getAttribute('value') ?? '';
  }
  return values;
}

/**
 * Reads a form out of an HTML body, e.g. the 422 re-render for the resubmit round trip (ADR 0003). `selector` picks
 * the form (default: the first form in `<main>`); its values are returned, and its token, or else the page's token
 * from another form such as the header's logout form. Throws when the page carries no token at all.
 */
export function readForm(html: string, selector = 'main form'): FormState {
  const page = parse(html);
  const form = page.root.querySelector(selector);
  const csrf = form?.querySelector(CSRF_FIELD)?.getAttribute('value') ?? page.attr(CSRF_FIELD, 'value');
  if (csrf === undefined || csrf === '') {
    throw new Error(`test/forms.ts: the page has no CSRF token (form "${selector}")`);
  }
  return { csrf, values: fieldValues(form) };
}

/** `GET path` with the agent's cookies; expects 200 and returns the form state (see `readForm`). */
export async function getForm(agent: Agent, path: string, selector?: string): Promise<FormState> {
  const response = await agent.get(path);
  if (response.status !== 200) {
    throw new Error(`test/forms.ts: GET ${path} answered ${String(response.status)}, expected 200`);
  }
  return readForm(response.text, selector);
}

/**
 * Submits `fields` as `application/x-www-form-urlencoded`, as a browser form does. Include `_csrf` yourself (or leave
 * it out on purpose). Returns the Supertest request, so callers chain `.expect(...)` or await the response.
 */
export function postForm(agent: Agent, path: string, fields: Readonly<Record<string, string>>) {
  return agent
    .post(path)
    .type('form')
    .send({ ...fields });
}
