import { create } from 'express-handlebars';
import { describe, expect, it, vi } from 'vitest';

import { createHelpers } from '../helpers.js';

const assets = vi.fn((logicalName: string) => `/assets/${logicalName}`);
const helpers = createHelpers({ assets, timeZone: 'Europe/Berlin' });

/** The trailing options object Handlebars passes to every helper, with the page model as root. */
function optionsWithRoot(root: unknown) {
  return { data: { root } };
}

/** Compiles a template with the real Handlebars of express-handlebars and these helpers. */
function render(template: string, context: Record<string, unknown> = {}): string {
  const { handlebars } = create();
  return handlebars.compile(template, {})(context, { helpers });
}

describe('plural and formatCount', () => {
  it('B-75, F-46: one supporter is singular, every other count plural', () => {
    expect(helpers.plural(1, 'supporter', 'supporters')).toBe('supporter');
    expect(helpers.plural(0, 'supporter', 'supporters')).toBe('supporters');
    expect(helpers.plural(2, 'supporter', 'supporters')).toBe('supporters');
    expect(helpers.plural(1284, 'supporter', 'supporters')).toBe('supporters');
  });

  it('F-46: counts use en-GB grouping', () => {
    expect(helpers.formatCount(0)).toBe('0');
    expect(helpers.formatCount(999)).toBe('999');
    expect(helpers.formatCount(1284)).toBe('1,284');
    expect(helpers.formatCount(1_000_000)).toBe('1,000,000');
  });

  it('B-75: together they print the count line of the thank-you and supporters pages', () => {
    const line = '{{formatCount total}} {{plural total "supporter" "supporters"}}';

    expect(render(line, { total: 1 })).toBe('1 supporter');
    expect(render(line, { total: 1284 })).toBe('1,284 supporters');
  });

  it('F-09: a missing or invalid count is a template bug and throws instead of printing nonsense', () => {
    expect(() => helpers.formatCount(undefined)).toThrow(TypeError);
    expect(() => helpers.formatCount('12')).toThrow(TypeError);
    expect(() => helpers.formatCount(Number.NaN)).toThrow(TypeError);
    expect(() => helpers.plural(-1, 'supporter', 'supporters')).toThrow(TypeError);
    expect(() => helpers.plural(1, '', 'supporters')).toThrow(TypeError);
  });
});

describe('formatDate', () => {
  it('F-52: dates read like 15 Nov 2026', () => {
    expect(helpers.formatDate(new Date('2026-11-15T12:00:00Z'))).toBe('15 Nov 2026');
    expect(helpers.formatDate('2026-01-02T09:00:00.000Z')).toBe('2 Jan 2026');
  });

  it('F-52: every month has its fixed three-letter name, never the ICU "Sept" of en-GB', () => {
    const months = Array.from(
      { length: 12 },
      (_, index) => helpers.formatDate(new Date(Date.UTC(2026, index, 15, 12))).split(' ')[1],
    );

    expect(months).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
    expect(helpers.formatDate(new Date('2026-09-02T12:00:00Z'))).toBe('2 Sep 2026');
  });

  it('F-52: the month and year roll over in APP_TIME_ZONE too', () => {
    const newYearsEve = new Date('2026-12-31T23:30:00Z'); // 00:30 on 1 Jan 2027 in Berlin

    expect(helpers.formatDate(newYearsEve)).toBe('1 Jan 2027');
  });

  it('F-52: the day is the day in APP_TIME_ZONE, not in UTC', () => {
    const lateEvening = new Date('2026-11-15T23:30:00Z'); // 00:30 on 16 Nov in Berlin

    expect(helpers.formatDate(lateEvening)).toBe('16 Nov 2026');
    expect(createHelpers({ assets, timeZone: 'UTC' }).formatDate(lateEvening)).toBe('15 Nov 2026');
  });

  it('F-09: anything that is not a date throws', () => {
    expect(() => helpers.formatDate('not a date')).toThrow(TypeError);
    expect(() => helpers.formatDate(undefined)).toThrow(TypeError);
    expect(() => helpers.formatDate(1_763_200_000_000)).toThrow(TypeError);
  });

  it('F-09: calendar parts that are not plain digits throw instead of printing "NaN Nov 2026"', () => {
    // ICU with another numbering system (here Arabic-Indic digits for the day) must never reach the page.
    const formatToParts = vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
      { type: 'day', value: '١٥' },
      { type: 'literal', value: '/' },
      { type: 'month', value: '11' },
      { type: 'literal', value: '/' },
      { type: 'year', value: '2026' },
    ]);

    try {
      expect(() => helpers.formatDate(new Date('2026-11-15T12:00:00Z'))).toThrow(RangeError);
    } finally {
      formatToParts.mockRestore();
    }
  });
});

describe('cityPath and pagePath', () => {
  it('F-56, B-33: city links encode the city as one path segment', () => {
    expect(helpers.cityPath('Berlin')).toBe('/supporters/city/Berlin');
    expect(helpers.cityPath('Frankfurt/Main')).toBe('/supporters/city/Frankfurt%2FMain');
    expect(helpers.cityPath('St. Gallen?')).toBe('/supporters/city/St.%20Gallen%3F');
    expect(helpers.cityPath('A#B&C')).toBe('/supporters/city/A%23B%26C');
    expect(helpers.cityPath('München')).toBe('/supporters/city/M%C3%BCnchen');
    expect(helpers.cityPath('../admin')).toBe('/supporters/city/..%2Fadmin');
  });

  it('F-56: a missing city throws (the row partial only links a city that is set)', () => {
    expect(() => helpers.cityPath('')).toThrow(TypeError);
    expect(() => helpers.cityPath(null)).toThrow(TypeError);
  });

  it('F-54, F-59: page 1 is the bare path, every other page adds ?page=n', () => {
    expect(helpers.pagePath('/supporters', 1)).toBe('/supporters');
    expect(helpers.pagePath('/supporters', 2)).toBe('/supporters?page=2');
    expect(helpers.pagePath('/supporters/city/Frankfurt%2FMain', 3)).toBe('/supporters/city/Frankfurt%2FMain?page=3');
  });

  it('F-54: rejects page numbers below 1 and anything that is not an app path', () => {
    expect(() => helpers.pagePath('/supporters', 0)).toThrow(TypeError);
    expect(() => helpers.pagePath('/supporters', 1.5)).toThrow(TypeError);
    expect(() => helpers.pagePath('/supporters', '2')).toThrow(TypeError);
    expect(() => helpers.pagePath('//evil.example', 2)).toThrow(TypeError);
    expect(() => helpers.pagePath('https://evil.example', 2)).toThrow(TypeError);
  });
});

describe('currentAttr, eq and fieldId', () => {
  it('F-14: currentAttr marks only the link of the current page', () => {
    expect(helpers.currentAttr('/about', optionsWithRoot({ currentPath: '/about' }))).toBe('page');
    expect(helpers.currentAttr('/', optionsWithRoot({ currentPath: '/about' }))).toBe('');
    expect(helpers.currentAttr('/supporters', optionsWithRoot({ currentPath: '/supporters/city/Berlin' }))).toBe('');
    expect(helpers.currentAttr('/about', optionsWithRoot({}))).toBe('');
    expect(helpers.currentAttr('/about', undefined)).toBe('');
  });

  it('F-14: in a template, aria-current appears only on the current link', () => {
    const link = '<a href="/about"{{#with (currentAttr "/about")}} aria-current="{{this}}"{{/with}}>about</a>';

    expect(render(link, { currentPath: '/about' })).toBe('<a href="/about" aria-current="page">about</a>');
    expect(render(link, { currentPath: '/' })).toBe('<a href="/about">about</a>');
  });

  it('eq compares strictly', () => {
    expect(helpers.eq('drawn', 'drawn')).toBe(true);
    expect(helpers.eq('1', 1)).toBe(false);
    expect(render('{{#if (eq method "typed")}}typed{{else}}drawn{{/if}}', { method: 'typed' })).toBe('typed');
  });

  it('F-21: fieldId builds an id-safe, form-scoped id and refuses anything else', () => {
    expect(helpers.fieldId('typed', 'typedName')).toBe('typed-typedName');
    expect(() => helpers.fieldId('typed', 'x" onfocus="alert(1)')).toThrow(TypeError);
    expect(() => helpers.fieldId('', 'typedName')).toThrow(TypeError);
  });
});

describe('asset', () => {
  it('B-82: resolves logical names through the injected resolver', () => {
    expect(helpers.asset('app.css')).toBe('/assets/app.css');
    expect(assets).toHaveBeenCalledWith('app.css');
    expect(render('<link rel="stylesheet" href="{{asset \'app.css\'}}">')).toBe(
      '<link rel="stylesheet" href="/assets/app.css">',
    );
  });

  it('B-82: rejects a missing name', () => {
    expect(() => helpers.asset(undefined)).toThrow(TypeError);
  });
});

describe('escaping', () => {
  it('B-01: helper output is escaped like any other value; no helper returns HTML', () => {
    expect(render('{{plural 2 "a" "<b>bold</b>"}}')).toBe('&lt;b&gt;bold&lt;/b&gt;');
    expect(render('<a href="{{cityPath city}}">', { city: '"><script>' })).toBe(
      '<a href="/supporters/city/%22%3E%3Cscript%3E">',
    );
  });
});
