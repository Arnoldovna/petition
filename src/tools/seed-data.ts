/**
 * The demo content of `pnpm db:seed` (DATA-MODEL.md section 6, F-01, B-60): one unsigned demo account and 64
 * fictional supporters. No real personal data and nothing from the legacy database: every email uses the reserved
 * `.test` TLD and every homepage the reserved `.example` TLD, so no address or link belongs to a real person.
 *
 * Everything here is fixed, so the supporters list, the city pages and the README screenshots look the same on every
 * machine: names, profiles, signing methods and all timestamps are derived from the table below and nothing else.
 */

type SignatureMethod = 'drawn' | 'typed';

interface SeedProfile {
  age: number | null;
  city: string | null;
  homepageUrl: string | null;
}

export interface SeedAccount {
  firstName: string;
  lastName: string;
  /** `<first>.<last>@petition.test`, ASCII-folded and lower-case (`users_email_chk`); `demo@petition.test` for the demo. */
  email: string;
  createdAt: Date;
  /** `null`: no `profiles` row at all (proves B-30, signers without a profile are listed). */
  profile: SeedProfile | null;
  /** `null` for the demo account, which stays unsigned so a reviewer can try the full flow. */
  signature: { method: SignatureMethod; signedAt: Date } | null;
}

/** The only email domain the seed writes; a user outside it makes the seed skip (ADR 0019 §7). */
export const SEED_EMAIL_DOMAIN = 'petition.test';

/**
 * Letters that Unicode decomposition does not reduce to ASCII. Everything else (`ü`, `ś`, `ễ`, `á`, ...) loses its
 * combining marks under NFD.
 */
const ASCII_FOLDS: Readonly<Record<string, string>> = {
  ß: 'ss',
  ı: 'i',
  ł: 'l',
  đ: 'd',
  ø: 'o',
  æ: 'ae',
  œ: 'oe',
  þ: 'th',
};

/**
 * One name part as it appears in a seed email: lower-case ASCII letters only (`Weiß` -> `weiss`, `Şahin` -> `sahin`,
 * `Nguyễn` -> `nguyen`). Throws for a character it cannot fold, so a new seed name can never produce an address the
 * `users_email_chk` constraint or the email field rule would reject.
 */
export function asciiFold(namePart: string): string {
  const folded = Array.from(namePart.toLowerCase().normalize('NFD'))
    .filter((character) => !/\p{M}/u.test(character))
    .map((character) => ASCII_FOLDS[character] ?? character)
    .join('');
  if (!/^[a-z]+$/.test(folded)) throw new Error(`seed-data: cannot fold "${namePart}" to ASCII letters`);
  return folded;
}

function seedEmail(firstName: string, lastName: string): string {
  return `${asciiFold(firstName)}.${asciiFold(lastName)}@${SEED_EMAIL_DOMAIN}`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const FIRST_SIGNATURE = Date.parse('2026-09-02T08:14:00Z');

/**
 * Supporter `index` (0-based) signs at `2026-09-02T08:14:00Z + index * 25 h + ((index * 37) mod 180) min`, which
 * spreads the 64 signatures from 2 Sep to 7 Nov 2026 (the last at 02:05 UTC) at varied times of day.
 */
function signedAt(index: number): Date {
  return new Date(FIRST_SIGNATURE + index * 25 * HOUR_MS + ((index * 37) % 180) * MINUTE_MS);
}

/** The account is created 5 to 40 minutes before its signature, varied but deterministic. */
function accountCreatedAt(index: number): Date {
  const leadMinutes = 5 + ((index * 23) % 36);
  return new Date(signedAt(index).getTime() - leadMinutes * MINUTE_MS);
}

// `[firstName, lastName, profile, method]`; profile `[age, city, homepage]` with `null` for "not set", or `null` for
// "no profile row". The order is the signing order; DATA-MODEL.md section 6 is the source of this table. Every value
// is in the form the app itself stores (the shared field rules return it unchanged), so homepages carry the trailing
// slash of the normalised URL that the profile form saves.
type SupporterRow = readonly [
  firstName: string,
  lastName: string,
  profile: readonly [age: number | null, city: string | null, homepage: string | null] | null,
  method: SignatureMethod,
];

const SUPPORTER_ROWS: readonly SupporterRow[] = [
  ['Lena', 'Hartmann', [34, 'Leipzig', 'https://lena-hartmann.example/'], 'typed'],
  ['Jonas', 'Becker', [41, 'Hamburg', null], 'drawn'],
  ['Aylin', 'Demir', [27, 'Berlin', 'https://aylin-draws.example/'], 'drawn'],
  ['Mateusz', 'Nowak', [null, 'Frankfurt/Main', null], 'typed'],
  ['Giulia', 'Romano', [52, 'München', null], 'drawn'],
  ['Henrik', 'Lindqvist', [38, 'Zürich', 'https://lindqvist.example/'], 'typed'],
  ['Sophie', 'Wagner', null, 'drawn'],
  ['Kwame', 'Mensah', [45, 'Köln', null], 'typed'],
  ['Eleni', 'Papadopoulou', [29, 'Wien', 'https://eleni-p.example/'], 'drawn'],
  ['Thanh', 'Nguyễn', [33, 'Berlin', null], 'typed'],
  ['Marta', 'Kowalczyk', [61, 'Dresden', null], 'drawn'],
  ['Felix', 'Schneider', [23, 'Freiburg im Breisgau', null], 'drawn'],
  ['Inês', 'Carvalho', [36, 'St. Gallen', 'https://ines-carvalho.example/'], 'typed'],
  ['Yusuf', 'Arslan', [48, null, null], 'drawn'],
  ['Clara', 'Fischer', [null, 'Halle (Saale)', null], 'typed'],
  ['Niklas', 'Brandt', [30, 'Rostock', null], 'drawn'],
  ['Amara', 'Okafor', [26, 'Hamburg', 'https://amara-okafor.example/'], 'typed'],
  ['Paul', 'Zimmermann', [72, 'Bremen', null], 'drawn'],
  ['Hanna', 'Weiß', [39, 'Graz', null], 'typed'],
  ['Lukas', 'Hofer', [44, 'Graz', null], 'drawn'],
  ['Mia', 'Schulz', null, 'typed'],
  ['Emre', 'Kaya', [31, 'Berlin', null], 'drawn'],
  ['Ingrid', 'Solberg', [57, 'Leipzig', null], 'typed'],
  ['Tobias', 'Krüger', [28, 'Brandenburg an der Havel', null], 'drawn'],
  ['Zofia', 'Wiśniewska', [35, 'Frankfurt/Main', null], 'typed'],
  ['Daniel', 'Roth', [50, 'Köln', 'https://danielroth.example/'], 'drawn'],
  ['Leonie', 'Vogel', [22, 'München', null], 'typed'],
  ['Marco', 'Bianchi', [46, 'Zürich', null], 'drawn'],
  ['Selin', 'Yıldız', [24, 'Hamburg', null], 'typed'],
  ['Johanna', 'Lehmann', [67, 'Dresden', null], 'drawn'],
  ['Samuel', 'Adeyemi', [37, 'Berlin', 'https://adeyemi.example/'], 'typed'],
  ['Katharina', 'Braun', null, 'drawn'],
  ['Oskar', 'Nilsson', [42, 'Wien', null], 'typed'],
  ['Lea', 'Hoffmann', [31, 'Leipzig', null], 'drawn'],
  ['Ali', 'Haddad', [29, 'Köln', null], 'typed'],
  ['Charlotte', 'Meyer', [55, 'Bremen', null], 'drawn'],
  ['Ben', 'Schäfer', [19, 'Rostock', null], 'typed'],
  ['Nora', 'Lindgren', [40, 'St. Gallen', null], 'drawn'],
  ['Piotr', 'Zieliński', [53, 'Berlin', null], 'typed'],
  ['Valentina', 'Costa', [27, 'München', 'https://valentina-costa.example/'], 'drawn'],
  ['Moritz', 'Kühn', [null, 'Halle (Saale)', null], 'typed'],
  ['Elif', 'Şahin', [34, 'Frankfurt/Main', null], 'drawn'],
  ['Anton', 'Weber', [78, 'Freiburg im Breisgau', null], 'typed'],
  ['Laura', 'Klein', null, 'drawn'],
  ['Fatima', 'Benali', [30, 'Hamburg', null], 'typed'],
  ['Jakob', 'Huber', [36, 'Graz', null], 'drawn'],
  ['Emilia', 'Sommer', [25, 'Leipzig', 'https://emilia-sommer.example/'], 'typed'],
  ['Max', 'Neumann', [47, 'Berlin', null], 'drawn'],
  ['Tereza', 'Horáková', [33, 'Wien', null], 'typed'],
  ['Erik', 'Johansson', [58, 'Zürich', null], 'drawn'],
  ['Pia', 'Lorenz', null, 'typed'],
  ['David', 'Cohen', [39, 'Berlin', null], 'drawn'],
  ['Annika', 'Petersen', [44, 'Bremen', null], 'typed'],
  ['Rafael', 'Moreira', [28, 'Köln', null], 'drawn'],
  ['Greta', 'Albrecht', [63, 'Dresden', null], 'typed'],
  ['Hamza', 'Yilmaz', [35, 'München', null], 'drawn'],
  ['Ida', 'Kristensen', [31, 'Hamburg', null], 'typed'],
  ['Simon', 'Graf', [26, 'St. Gallen', null], 'drawn'],
  ['Marlene', 'Fuchs', [null, 'Leipzig', null], 'typed'],
  ['Viktor', 'Petrov', [49, 'Berlin', null], 'drawn'],
  ['Rosa', 'Martínez', [37, 'Frankfurt/Main', 'https://rosa-martinez.example/'], 'typed'],
  ['Till', 'Hansen', null, 'drawn'],
  ['Hiroshi', 'Tanaka', [54, 'Köln', null], 'typed'],
  ['Alma', 'Berg', [21, 'Rostock', null], 'drawn'],
];

/** The 64 supporters in signing order. */
export const SEED_SUPPORTERS: readonly SeedAccount[] = SUPPORTER_ROWS.map(
  ([firstName, lastName, profile, method], index) => ({
    firstName,
    lastName,
    email: seedEmail(firstName, lastName),
    createdAt: accountCreatedAt(index),
    profile: profile === null ? null : { age: profile[0], city: profile[1], homepageUrl: profile[2] },
    signature: { method, signedAt: signedAt(index) },
  }),
);

/** The address `pnpm demo` prints next to `SEED_DEMO_PASSWORD` (scripts/dev-setup.mjs). */
export const DEMO_EMAIL = `demo@${SEED_EMAIL_DOMAIN}`;

/**
 * The demo account: unsigned, so a reviewer can sign, see the thank-you page and delete again. Created the day before
 * the first signature; after signing it is the sixth Leipzig supporter.
 */
export const DEMO_ACCOUNT: SeedAccount = {
  firstName: 'Mara',
  lastName: 'Lindholm',
  email: DEMO_EMAIL,
  createdAt: new Date('2026-09-01T10:00:00Z'),
  profile: { age: 31, city: 'Leipzig', homepageUrl: null },
  signature: null,
};

/** Every account the seed writes: the demo account first, then the supporters. */
export const SEED_ACCOUNTS: readonly SeedAccount[] = [DEMO_ACCOUNT, ...SEED_SUPPORTERS];
