import { describe, expect, it } from 'vitest';

import { buildPagination, isPageInRange, pageHref, pageSlice } from '../pagination.js';

const PAGE_SIZE = 50;

/** The page numbers and gaps of a view, e.g. `[1, '…', 4, 5, 6, 7, 8, '…', 20]`. */
function shape(page: number, total: number, pageSize = 1): (number | '…')[] | undefined {
  return buildPagination({ page, pageSize }, total, '/supporters')?.items.map((item) => (item.gap ? '…' : item.page));
}

describe('pageSlice', () => {
  it('F-54: page 1 starts at offset 0 and row 1', () => {
    expect(pageSlice({ page: 1, pageSize: PAGE_SIZE })).toEqual({ limit: 50, offset: 0, firstNumber: 1 });
  });

  it('F-54: page 2 continues the numbering for <ol start>', () => {
    expect(pageSlice({ page: 2, pageSize: PAGE_SIZE })).toEqual({ limit: 50, offset: 50, firstNumber: 51 });
  });

  it('B-31: refuses a page or page size that is not a positive integer', () => {
    for (const page of [0, -1, 1.5, Number.NaN]) {
      expect(() => pageSlice({ page, pageSize: PAGE_SIZE })).toThrow(RangeError);
    }
    expect(() => pageSlice({ page: 1, pageSize: 0 })).toThrow(RangeError);
  });
});

describe('isPageInRange', () => {
  it.each([
    [1, 0, true],
    [2, 0, false],
    [1, 50, true],
    [2, 50, false],
    [2, 51, true],
    [3, 101, true],
    [4, 101, false],
    [0, 101, false],
    [1.5, 101, false],
  ])('F-54, F-59: page %i with %i supporters in range: %s', (page, total, expected) => {
    expect(isPageInRange({ page, pageSize: PAGE_SIZE }, total)).toBe(expected);
  });
});

describe('buildPagination', () => {
  it('F-54: there is no navigation when everything fits on one page', () => {
    expect(buildPagination({ page: 1, pageSize: PAGE_SIZE }, 0, '/supporters')).toBeUndefined();
    expect(buildPagination({ page: 1, pageSize: PAGE_SIZE }, 50, '/supporters')).toBeUndefined();
  });

  it('F-54: marks the current page and links page 1 without ?page=1', () => {
    const view = buildPagination({ page: 2, pageSize: PAGE_SIZE }, 64, '/supporters');

    expect(view).toEqual({
      current: 2,
      last: 2,
      previous: { page: 1, href: '/supporters' },
      next: undefined,
      items: [
        { gap: false, page: 1, href: '/supporters', current: false },
        { gap: false, page: 2, href: '/supporters?page=2', current: true },
      ],
    });
  });

  it('F-59: keeps an already encoded city path', () => {
    const view = buildPagination({ page: 1, pageSize: PAGE_SIZE }, 120, '/supporters/city/Frankfurt%2FMain');

    expect(view?.next).toEqual({ page: 2, href: '/supporters/city/Frankfurt%2FMain?page=2' });
  });

  it('F-54: shows first, last, the current page plus and minus 2, and gaps', () => {
    expect(shape(10, 20)).toEqual([1, '…', 8, 9, 10, 11, 12, '…', 20]);
    expect(shape(1, 20)).toEqual([1, 2, 3, '…', 20]);
    expect(shape(20, 20)).toEqual([1, '…', 18, 19, 20]);
  });

  it('F-54: never hides a single page behind a gap', () => {
    expect(shape(5, 20)).toEqual([1, 2, 3, 4, 5, 6, 7, '…', 20]);
    expect(shape(4, 7)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('F-54: has exactly one current page, and previous/next only where they exist', () => {
    const first = buildPagination({ page: 1, pageSize: 1 }, 3, '/supporters');
    const last = buildPagination({ page: 3, pageSize: 1 }, 3, '/supporters');

    expect(first?.items.filter((item) => !item.gap && item.current)).toHaveLength(1);
    expect(first?.previous).toBeUndefined();
    expect(first?.next).toEqual({ page: 2, href: '/supporters?page=2' });
    expect(last?.next).toBeUndefined();
    expect(last?.previous).toEqual({ page: 2, href: '/supporters?page=2' });
  });

  it('F-54: an out-of-range page gets no view (the controller answers 404)', () => {
    expect(buildPagination({ page: 3, pageSize: PAGE_SIZE }, 64, '/supporters')).toBeUndefined();
  });
});

describe('pageHref', () => {
  it('ADR 0006: page 1 is the bare path, every other page adds ?page=n', () => {
    expect(pageHref('/supporters', 1)).toBe('/supporters');
    expect(pageHref('/supporters/city/Frankfurt%2FMain', 3)).toBe('/supporters/city/Frankfurt%2FMain?page=3');
  });

  it('F-30: a base path that could leave the origin, or a page below 1, is a programming error', () => {
    for (const basePath of ['//evil.example', '/\\evil.example', 'https://evil.example', 'supporters']) {
      expect(() => pageHref(basePath, 2), basePath).toThrow(TypeError);
    }
    expect(() => pageHref('/supporters', 0)).toThrow(TypeError);
    expect(() => pageHref('/supporters', 1.5)).toThrow(TypeError);
  });

  it('ADR 0006: buildPagination links with the same rule, so it rejects the same base paths', () => {
    expect(() => buildPagination({ page: 1, pageSize: PAGE_SIZE }, 120, '//evil.example')).toThrow(TypeError);
  });
});
