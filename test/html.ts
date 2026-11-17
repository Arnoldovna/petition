import { parse as parseHtml, type HTMLElement } from 'node-html-parser';

/**
 * A parsed HTML response for assertions on rendered pages (ADR 0015). Selectors are CSS selectors as supported by
 * node-html-parser. Text is whitespace-collapsed and trimmed, so assertions do not depend on template indentation.
 */
export interface Html {
  readonly root: HTMLElement;
  /** True when at least one element matches. */
  has(selector: string): boolean;
  /** Text of the first match, or `undefined` when nothing matches. */
  text(selector: string): string | undefined;
  /** Texts of every match, in document order. */
  texts(selector: string): string[];
  /** Attribute `name` of the first match, or `undefined` when nothing matches or the attribute is absent. */
  attr(selector: string, name: string): string | undefined;
}

const collapse = (value: string): string => value.replace(/\s+/g, ' ').trim();

export function parse(html: string): Html {
  const root = parseHtml(html);
  return {
    root,
    has: (selector) => root.querySelector(selector) !== null,
    text: (selector) => {
      const element = root.querySelector(selector);
      return element === null ? undefined : collapse(element.text);
    },
    texts: (selector) => root.querySelectorAll(selector).map((element) => collapse(element.text)),
    attr: (selector, name) => root.querySelector(selector)?.getAttribute(name),
  };
}
