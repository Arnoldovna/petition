import { describe, expect, it } from 'vitest';

import type { SupporterRow, SupportersRepository } from '../supporters.repository.js';
import { createSupportersService, type SupportersPageResult } from '../supporters.service.js';
import { createFakeSupportersRepository, fakeSupporter, type FakeSupporter } from './fakes.js';

const PAGE_SIZE = 3;

function serviceWith(rows: readonly FakeSupporter[] = []) {
  const repository = createFakeSupportersRepository(rows);
  return { repository, service: createSupportersService({ repository, pageSize: PAGE_SIZE }) };
}

function many(count: number, overrides: Partial<FakeSupporter> = {}): FakeSupporter[] {
  return Array.from({ length: count }, () => fakeSupporter(overrides));
}

/** The page of an ok result; fails the test with the reason otherwise. */
function pageOf(result: SupportersPageResult) {
  if (!result.ok) throw new Error(`expected a page, got ${result.reason}`);
  return result.value;
}

describe('supporters service: rows to views', () => {
  it('F-51, B-30: a signer without a profile is a supporter with name and date only, no empty fields', async () => {
    const signedAt = new Date('2026-11-15T09:30:00.000Z');
    const { service } = serviceWith([fakeSupporter({ firstName: 'Grace', lastName: 'Hopper', signedAt })]);

    const page = pageOf(await service.listSupporters({ page: 1 }));

    expect(page.supporters).toEqual([{ fullName: 'Grace Hopper', signedAt: '2026-11-15T09:30:00.000Z' }]);
    expect(page.supporters[0]).not.toHaveProperty('age');
    expect(page.supporters[0]).not.toHaveProperty('city');
    expect(page.supporters[0]).not.toHaveProperty('homepageUrl');
  });

  it('F-52: age, city and homepage are passed through when set', async () => {
    const { service } = serviceWith([
      fakeSupporter({ age: 36, city: 'Frankfurt/Main', homepageUrl: 'https://ada.example.com/notes?x=1' }),
    ]);

    const [supporter] = pageOf(await service.listSupporters({ page: 1 })).supporters;

    expect(supporter).toMatchObject({
      fullName: 'Ada Lovelace',
      age: 36,
      city: 'Frankfurt/Main',
      homepageUrl: 'https://ada.example.com/notes?x=1',
    });
  });

  it('F-53, B-01: names and city are kept verbatim as text (the view escapes them), never altered', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    const { service } = serviceWith([fakeSupporter({ firstName: payload, lastName: '"><script>', city: payload })]);

    const [supporter] = pageOf(await service.listSupporters({ page: 1 })).supporters;

    expect(supporter?.fullName).toBe(`${payload} "><script>`);
    expect(supporter?.city).toBe(payload);
  });

  it.each([
    ['javascript:alert(1)'],
    ['data:text/html,<script>alert(1)</script>'],
    ['vbscript:msgbox(1)'],
    ['not a url'],
    ['//evil.example.com'],
  ])('B-01, B-18: a homepage %j that is not an http(s) URL is never a link target', async (homepageUrl) => {
    const { service } = serviceWith([fakeSupporter({ homepageUrl })]);

    const [supporter] = pageOf(await service.listSupporters({ page: 1 })).supporters;

    expect(supporter).not.toHaveProperty('homepageUrl');
  });

  it('B-18: http and https homepages are both links', async () => {
    const { service } = serviceWith([
      fakeSupporter({ homepageUrl: 'http://old.example.com/' }),
      fakeSupporter({ homepageUrl: 'https://new.example.com/' }),
    ]);

    const { supporters } = pageOf(await service.listSupporters({ page: 1 }));

    expect(supporters.map((supporter) => supporter.homepageUrl)).toEqual([
      'http://old.example.com/',
      'https://new.example.com/',
    ]);
  });
});

describe('supporters service: pages (ADR 0006)', () => {
  it('F-54, B-31: page 1 asks for the first slice and numbers from 1', async () => {
    const { service, repository } = serviceWith(many(7));

    const page = pageOf(await service.listSupporters({ page: 1 }));

    expect(page).toMatchObject({ page: 1, pageSize: PAGE_SIZE, total: 7, firstNumber: 1 });
    expect(page.supporters).toHaveLength(3);
    expect(repository.calls).toContainEqual({ method: 'list', limit: PAGE_SIZE, offset: 0 });
  });

  it('F-54: a later page asks for its slice and numbers on from the previous pages', async () => {
    const { service, repository } = serviceWith(many(7));

    const page = pageOf(await service.listSupporters({ page: 3 }));

    expect(page).toMatchObject({ page: 3, total: 7, firstNumber: 7 });
    expect(page.supporters).toHaveLength(1);
    expect(repository.calls).toContainEqual({ method: 'list', limit: PAGE_SIZE, offset: 6 });
  });

  it('F-54: the last page is in range when the total fills it exactly; the next one is not', async () => {
    const { service } = serviceWith(many(2 * PAGE_SIZE));

    expect(pageOf(await service.listSupporters({ page: 2 })).supporters).toHaveLength(PAGE_SIZE);
    expect(await service.listSupporters({ page: 3 })).toEqual({ ok: false, reason: 'page-not-found' });
  });

  it('ADR 0006: a page beyond the last one is page-not-found', async () => {
    const { service } = serviceWith(many(4));

    expect(await service.listSupporters({ page: 3 })).toEqual({ ok: false, reason: 'page-not-found' });
  });

  it('F-55: an empty list is page 1 with total 0 (the empty state), and page 2 does not exist', async () => {
    const { service } = serviceWith();

    expect(pageOf(await service.listSupporters({ page: 1 }))).toEqual({
      page: 1,
      pageSize: PAGE_SIZE,
      total: 0,
      firstNumber: 1,
      supporters: [],
    });
    expect(await service.listSupporters({ page: 2 })).toEqual({ ok: false, reason: 'page-not-found' });
  });

  it('B-52: rows and total are queried concurrently, not one after the other', async () => {
    const started: string[] = [];
    const pending: (() => void)[] = [];
    const deferred = <T>(name: string, value: T): Promise<T> => {
      started.push(name);
      return new Promise((resolve) => {
        pending.push(() => {
          resolve(value);
        });
      });
    };
    const repository: SupportersRepository = {
      list: () => deferred<SupporterRow[]>('list', []),
      count: () => deferred('count', 0),
    };
    const service = createSupportersService({ repository, pageSize: PAGE_SIZE });

    const result = service.listSupporters({ page: 1 });
    // Both queries have started before either has answered.
    expect(started.sort()).toEqual(['count', 'list']);
    for (const resolve of pending) resolve();

    expect((await result).ok).toBe(true);
  });
});

describe('supporters service: city pages (ADR 0007)', () => {
  it('F-56: rows and total are filtered by the same city', async () => {
    const { service, repository } = serviceWith([
      fakeSupporter({ firstName: 'Berta', city: 'München' }),
      fakeSupporter({ firstName: 'Carl', city: 'Berlin' }),
      fakeSupporter({ firstName: 'Dora', city: 'MÜNCHEN' }),
      fakeSupporter({ firstName: 'Emil' }),
    ]);

    const page = pageOf(await service.listSupportersFromCity({ city: 'münchen', page: 1 }));

    expect(page.total).toBe(2);
    expect(page.supporters.map((supporter) => supporter.fullName)).toEqual(['Berta Lovelace', 'Dora Lovelace']);
    // Each supporter keeps the spelling of their own profile.
    expect(page.supporters.map((supporter) => supporter.city)).toEqual(['München', 'MÜNCHEN']);
    expect(repository.calls).toEqual(
      expect.arrayContaining([
        { method: 'list', city: 'münchen', limit: PAGE_SIZE, offset: 0 },
        { method: 'count', city: 'münchen' },
      ]),
    );
  });

  it('F-58: a city without supporters is page 1 with total 0, never an error', async () => {
    const { service } = serviceWith([fakeSupporter({ city: 'Berlin' })]);

    expect(pageOf(await service.listSupportersFromCity({ city: 'Atlantis', page: 1 }))).toMatchObject({
      total: 0,
      supporters: [],
    });
  });

  it('F-59: the city page is paginated by its own total', async () => {
    const { service } = serviceWith([...many(4, { city: 'Halle (Saale)' }), ...many(5, { city: 'Berlin' })]);

    const second = pageOf(await service.listSupportersFromCity({ city: 'Halle (Saale)', page: 2 }));

    expect(second).toMatchObject({ total: 4, firstNumber: 4 });
    expect(second.supporters).toHaveLength(1);
    expect(await service.listSupportersFromCity({ city: 'Halle (Saale)', page: 3 })).toEqual({
      ok: false,
      reason: 'page-not-found',
    });
  });
});

describe('supporters service: count', () => {
  it('F-47: countSupporters is the unfiltered total of the list', async () => {
    const { service, repository } = serviceWith([...many(4, { city: 'Berlin' }), ...many(2)]);

    const count = await service.countSupporters();

    expect(count).toBe(6);
    expect(count).toBe(pageOf(await service.listSupporters({ page: 1 })).total);
    expect(repository.calls[0]).toEqual({ method: 'count' });
  });
});
