import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  cityParam,
  currentPassword,
  email,
  firstName,
  glyphSetFromRanges,
  lastName,
  loginPassword,
  newPassword,
  optionalAge,
  optionalCity,
  optionalCurrentPassword,
  optionalHomepage,
  optionalNewPassword,
  pageQuery,
  safeReturnTo,
  typedName,
  type CodePointRange,
} from '../fields.js';

/** The parsed value, failing the test with the issues when the schema rejects the input. */
function valueOf<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new Error(`expected success, got ${JSON.stringify(result.error.issues)}`);
  return result.data;
}

/** Every message the schema reports for the input; each field reports exactly one. */
function messagesOf(schema: z.ZodType, input: unknown): string[] {
  const result = schema.safeParse(input);
  if (result.success) throw new Error(`expected failure, got ${JSON.stringify(result.data)}`);
  return result.error.issues.map((issue) => issue.message);
}

describe('firstName and lastName', () => {
  it('F-19, B-24: trims, collapses inner whitespace and applies NFC', () => {
    expect(valueOf(firstName, '  Ada \t  Mary\n ')).toBe('Ada Mary');
    // "e" + U+0301 combining acute -> precomposed U+00E9
    expect(valueOf(lastName, 'Renée')).toBe('Renée');
  });

  it('F-19, B-24: empty and whitespace-only names are rejected with the field message', () => {
    expect(messagesOf(firstName, '')).toEqual(['Enter your first name']);
    expect(messagesOf(firstName, '   \t ')).toEqual(['Enter your first name']);
    expect(messagesOf(lastName, ' ')).toEqual(['Enter your last name']);
  });

  it('F-19: a missing field or a repeated field (array) gets the "enter" message', () => {
    expect(messagesOf(firstName, undefined)).toEqual(['Enter your first name']);
    expect(messagesOf(lastName, ['Ada', 'Eve'])).toEqual(['Enter your last name']);
  });

  it('F-19: 100 characters pass, 101 fail; length counts code points, not UTF-16 units', () => {
    expect(valueOf(firstName, 'a'.repeat(100))).toHaveLength(100);
    expect(messagesOf(firstName, 'a'.repeat(101))).toEqual(['First name must be 100 characters or fewer']);
    expect(messagesOf(lastName, 'b'.repeat(101))).toEqual(['Last name must be 100 characters or fewer']);
    // 100 astral characters are 200 UTF-16 units but 100 characters for PostgreSQL's char_length
    expect(valueOf(firstName, '\u{1D49C}'.repeat(100))).toBe('\u{1D49C}'.repeat(100));
  });

  it('B-56: control characters never reach the database (removed, whitespace ones collapsed)', () => {
    expect(valueOf(firstName, 'A\u0000da\u0007')).toBe('Ada');
    expect(valueOf(firstName, 'Ada\r\nLovelace\u0085')).toBe('Ada Lovelace');
    expect(messagesOf(firstName, '\u0000\u001b')).toEqual(['Enter your first name']);
  });

  it('B-56: invisible format characters are removed, so a name cannot reorder its row on the supporters list', () => {
    // Right-to-left override, left-to-right isolate and pop, zero-width space, word joiner, byte order mark.
    expect(valueOf(firstName, 'Ada\u202Eevil')).toBe('Adaevil');
    expect(valueOf(lastName, '\u2066Love\u200Blace\u2069')).toBe('Lovelace');
    expect(valueOf(firstName, '\uFEFFAda\u2060')).toBe('Ada');
    expect(messagesOf(firstName, '\u202E\u200F\u00AD')).toEqual(['Enter your first name']);
  });

  it('B-56: zero-width non-joiner and joiner stay, because real spellings need them', () => {
    // Persian "Mehrnaz" style names use U+200C between letters that must not join.
    expect(valueOf(firstName, 'مهر\u200Cناز')).toBe('مهر\u200Cناز');
    expect(valueOf(lastName, 'क्\u200Dष')).toBe('क्\u200Dष');
  });
});

describe('email', () => {
  it('F-19, ADR 0007: trims and lower-cases before the format check', () => {
    expect(valueOf(email, '  Ada@Example.COM  ')).toBe('ada@example.com');
    expect(valueOf(email, ' ada@example.com')).toBe('ada@example.com');
    expect(valueOf(email, 'ADA@EXAMPLE.COM')).toBe('ada@example.com');
  });

  it('F-19: empty, whitespace-only and missing give "Enter an email address"', () => {
    expect(messagesOf(email, '')).toEqual(['Enter an email address']);
    expect(messagesOf(email, '   ')).toEqual(['Enter an email address']);
    expect(messagesOf(email, undefined)).toEqual(['Enter an email address']);
  });

  it('F-19: malformed addresses give the format message', () => {
    const invalid = 'Enter a valid email address, like name@example.com';
    for (const input of ['ada', 'ada@', '@example.com', 'ada@example', 'a da@example.com', 'ada@@example.com']) {
      expect(messagesOf(email, input)).toEqual([invalid]);
    }
  });

  it('F-19: at most 254 characters after trimming', () => {
    const local = 'a'.repeat(64);
    const domain = `${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`; // 63*3 + 3 dots + 3 = 195
    const address = `${local}@${domain}`; // 64 + 1 + 195 = 260
    expect(address.length).toBeGreaterThan(254);
    expect(messagesOf(email, address)).toEqual(['Enter a valid email address, like name@example.com']);
    expect(valueOf(email, `   ${'a'.repeat(242)}@example.com   `)).toHaveLength(254);
  });
});

describe('passwords', () => {
  it('F-19, ADR 0009: a new password has 12..128 characters and is never trimmed', () => {
    expect(valueOf(newPassword, ' twelve chars')).toBe(' twelve chars');
    expect(valueOf(newPassword, 'x'.repeat(128))).toHaveLength(128);
    expect(messagesOf(newPassword, '')).toEqual(['Enter a password']);
    expect(messagesOf(newPassword, undefined)).toEqual(['Enter a password']);
    expect(messagesOf(newPassword, 'x'.repeat(11))).toEqual(['Password must be at least 12 characters']);
    expect(messagesOf(newPassword, 'x'.repeat(129))).toEqual(['Password must be 128 characters or fewer']);
  });

  it('F-19: password length counts code points (12 emoji are 12 characters)', () => {
    expect(valueOf(newPassword, '\u{1F600}'.repeat(12))).toBe('\u{1F600}'.repeat(12));
    expect(messagesOf(newPassword, '\u{1F600}'.repeat(11))).toEqual(['Password must be at least 12 characters']);
  });

  it('F-60: an empty optional new password keeps the current one (null); anything else follows the policy', () => {
    expect(valueOf(optionalNewPassword, '')).toBeNull();
    expect(valueOf(optionalNewPassword, undefined)).toBeNull();
    expect(valueOf(optionalNewPassword, 'a new passphrase')).toBe('a new passphrase');
    expect(messagesOf(optionalNewPassword, 'short')).toEqual(['Password must be at least 12 characters']);
  });

  it('F-24: the login password is only required, so policy hints never leak through login', () => {
    expect(valueOf(loginPassword, 'short')).toBe('short');
    expect(valueOf(loginPassword, ' padded ')).toBe(' padded ');
    expect(messagesOf(loginPassword, '')).toEqual(['Enter a password']);
  });

  it('F-67: the current password is required for re-authentication', () => {
    expect(valueOf(currentPassword, 'anything')).toBe('anything');
    expect(messagesOf(currentPassword, '')).toEqual(['Enter your current password']);
    expect(messagesOf(currentPassword, undefined)).toEqual(['Enter your current password']);
  });

  it('F-63: the optional current password of the edit form is null when empty and never trimmed', () => {
    expect(valueOf(optionalCurrentPassword, '')).toBeNull();
    expect(valueOf(optionalCurrentPassword, undefined)).toBeNull();
    expect(valueOf(optionalCurrentPassword, ' secret ')).toBe(' secret ');
  });
});

describe('optionalAge', () => {
  const invalid = ['Age must be a whole number between 1 and 120'];

  it('F-34, B-26: empty or missing age is null', () => {
    expect(valueOf(optionalAge, '')).toBeNull();
    expect(valueOf(optionalAge, '   ')).toBeNull();
    expect(valueOf(optionalAge, undefined)).toBeNull();
  });

  it('F-35, B-27: whole numbers 1..120 are accepted as integers', () => {
    expect(valueOf(optionalAge, '1')).toBe(1);
    expect(valueOf(optionalAge, '42')).toBe(42);
    expect(valueOf(optionalAge, '120')).toBe(120);
    expect(valueOf(optionalAge, '007')).toBe(7);
    expect(valueOf(optionalAge, ' 42 ')).toBe(42);
  });

  it('F-35, B-27: decimals, text, signs, out-of-range and long values are rejected', () => {
    for (const input of ['0', '121', '999', '1000', '1.5', '...', '4e1', '-5', '+5', 'forty', '0x2A', '٤٢', ['4']]) {
      expect(messagesOf(optionalAge, input)).toEqual(invalid);
    }
  });
});

describe('optionalCity', () => {
  it('F-34: empty or whitespace-only city is null', () => {
    expect(valueOf(optionalCity, '')).toBeNull();
    expect(valueOf(optionalCity, '  \t ')).toBeNull();
    expect(valueOf(optionalCity, undefined)).toBeNull();
  });

  it('F-35, ADR 0007: NFC, trimmed, inner whitespace collapsed; real names keep their punctuation', () => {
    expect(valueOf(optionalCity, '  Halle   (Saale) ')).toBe('Halle (Saale)');
    expect(valueOf(optionalCity, 'München')).toBe('München');
    expect(valueOf(optionalCity, 'Frankfurt/Main')).toBe('Frankfurt/Main');
    expect(valueOf(optionalCity, 'St. Gallen?')).toBe('St. Gallen?');
    expect(valueOf(optionalCity, 'A#B&C')).toBe('A#B&C');
  });

  it('ADR 0007, B-56: a zero-width or bidi character never creates a second city that looks like an existing one', () => {
    expect(valueOf(optionalCity, 'Berl\u200Bin')).toBe('Berlin');
    expect(valueOf(optionalCity, '\u202DBerlin\u202C')).toBe('Berlin');
    expect(valueOf(cityParam, 'Berl\u2060in')).toBe('Berlin');
    expect(valueOf(optionalCity, '\u200B\uFEFF')).toBeNull();
  });

  it('F-35: at most 100 characters', () => {
    expect(valueOf(optionalCity, 'c'.repeat(100))).toHaveLength(100);
    expect(messagesOf(optionalCity, 'c'.repeat(101))).toEqual(['City must be 100 characters or fewer']);
  });
});

describe('optionalHomepage', () => {
  const invalid = ['Enter a web address like https://example.com'];

  it('F-34: empty homepage is null', () => {
    expect(valueOf(optionalHomepage, '')).toBeNull();
    expect(valueOf(optionalHomepage, '   ')).toBeNull();
    expect(valueOf(optionalHomepage, undefined)).toBeNull();
  });

  it('F-35, B-18: https:// is prepended only when no scheme is present, never twice', () => {
    expect(valueOf(optionalHomepage, 'example.com')).toBe('https://example.com/');
    expect(valueOf(optionalHomepage, '  www.example.com/about  ')).toBe('https://www.example.com/about');
    expect(valueOf(optionalHomepage, 'https://example.com')).toBe('https://example.com/');
    expect(valueOf(optionalHomepage, 'http://example.com/a?b=c#d')).toBe('http://example.com/a?b=c#d');
    expect(valueOf(optionalHomepage, 'HTTPS://Example.COM/Path')).toBe('https://example.com/Path');
    expect(valueOf(optionalHomepage, 'example.com:8080/x')).toBe('https://example.com:8080/x');
  });

  it('B-18: "https://https://example.com" is rejected, not stored doubled', () => {
    expect(messagesOf(optionalHomepage, 'https://https://example.com')).toEqual(invalid);
  });

  it('F-35, B-18, B-01: other schemes, hosts without a dot, credentials and garbage are rejected', () => {
    for (const input of [
      'javascript:alert(1)',
      'JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'mailto:ada@example.com',
      'ftp://example.com',
      'localhost',
      'http://localhost:3000',
      'https://user:pass@example.com',
      'ada@example.com',
      'exa mple.com',
      '"><script>alert(1)</script>',
      'https://',
    ]) {
      expect(messagesOf(optionalHomepage, input), input).toEqual(invalid);
    }
  });

  it('F-35, B-18: the stored href has at most 300 characters and no raw whitespace', () => {
    const base = 'https://example.com/';
    expect(valueOf(optionalHomepage, base + 'p'.repeat(300 - base.length))).toHaveLength(300);
    expect(messagesOf(optionalHomepage, base + 'p'.repeat(301 - base.length))).toEqual(invalid);
    expect(valueOf(optionalHomepage, 'example.com/a b')).toBe('https://example.com/a%20b');
  });
});

describe('typedName', () => {
  // Stand-in for glyphs.generated.ts: Latin incl. Vietnamese, combining marks, Greek and Cyrillic, nothing else.
  const LATIN: CodePointRange[] = [
    [0x41, 0x5a],
    [0x61, 0x7a],
    [0xc0, 0x24f],
    [0x1e00, 0x1eff],
  ];
  const EXTRA: CodePointRange[] = [
    [0x300, 0x36f],
    [0x370, 0x3ff],
    [0x400, 0x4ff],
  ];
  const schema = typedName(glyphSetFromRanges(LATIN, EXTRA));
  const characters = ['Use letters, spaces, hyphens, apostrophes and full stops only'];
  const glyphs = [
    'We cannot draw some letters of this name yet. Type it in Latin, Greek or Cyrillic letters, or draw your signature.',
  ];

  it('F-45, ADR 0005: typographic apostrophes become straight ones; NFC, trim and collapse apply', () => {
    expect(valueOf(schema, '  Seán   O’Brien ')).toBe("Seán O'Brien");
    expect(valueOf(schema, 'Miʼa')).toBe("Mi'a");
    expect(valueOf(schema, 'José Ma. Pérez-López')).toBe('José Ma. Pérez-López');
  });

  it('F-45, ADR 0005: Vietnamese, Greek and Cyrillic names are accepted', () => {
    expect(valueOf(schema, 'Nguyễn Thị Minh Khai')).toBe('Nguyễn Thị Minh Khai');
    expect(valueOf(schema, 'Ελένη Παπαδοπούλου')).toBe('Ελένη Παπαδοπούλου');
    expect(valueOf(schema, 'Анна Ахматова')).toBe('Анна Ахматова');
    expect(valueOf(schema, 'Łukasz Żółć')).toBe('Łukasz Żółć');
  });

  it('F-45: fewer than 2 or more than 60 characters, or missing, gives "Type your full name"', () => {
    expect(messagesOf(schema, '')).toEqual(['Type your full name']);
    expect(messagesOf(schema, '  A  ')).toEqual(['Type your full name']);
    expect(messagesOf(schema, undefined)).toEqual(['Type your full name']);
    expect(valueOf(schema, 'Al')).toBe('Al');
    expect(valueOf(schema, 'a'.repeat(60))).toHaveLength(60);
    expect(messagesOf(schema, 'a'.repeat(61))).toEqual(['Type your full name']);
  });

  it("F-45: must start with a letter and contain only letters, marks, spaces, ., ' and -", () => {
    for (const input of ['-Anna', '.Anna', "'Anna", 'Anna 2', 'Anna_B', 'Anna 😀', 'Anna <b>', 'Anna!', 'Á \u200BB']) {
      expect(messagesOf(schema, input), input).toEqual(characters);
    }
  });

  it('F-45, B-56: invisible format characters are not removed from the typed name but rejected like any non-letter', () => {
    const rightToLeftOverride = String.fromCodePoint(0x202e);
    const zeroWidthNonJoiner = String.fromCodePoint(0x200c);

    expect(messagesOf(schema, `Anna${rightToLeftOverride}B`)).toEqual(characters);
    expect(messagesOf(schema, `Anna${zeroWidthNonJoiner}B`)).toEqual(characters);
  });

  it('F-45, ADR 0005: letters outside the glyph set (CJK, Arabic) get the glyph message', () => {
    expect(messagesOf(schema, '李小龍')).toEqual(glyphs);
    expect(messagesOf(schema, 'Anna 李')).toEqual(glyphs);
    expect(messagesOf(schema, 'محمد علي')).toEqual(glyphs);
  });

  it('ADR 0005: the glyph set is a parameter, so an empty set rejects every letter', () => {
    expect(messagesOf(typedName(glyphSetFromRanges()), 'Anna')).toEqual(glyphs);
  });
});

describe('glyphSetFromRanges', () => {
  it('ADR 0005: looks code points up in any of the sorted inclusive range lists', () => {
    const set = glyphSetFromRanges(
      [
        [10, 20],
        [30, 30],
        [40, 50],
      ],
      [[100, 200]],
    );
    for (const hit of [10, 15, 20, 30, 40, 50, 100, 200]) expect(set.has(hit), String(hit)).toBe(true);
    for (const miss of [0, 9, 21, 29, 31, 39, 51, 99, 201]) expect(set.has(miss), String(miss)).toBe(false);
  });
});

describe('safeReturnTo', () => {
  it('F-30: keeps same-origin paths and silently drops everything else (no open redirect)', () => {
    expect(valueOf(safeReturnTo, '/supporters?page=2')).toBe('/supporters?page=2');
    expect(valueOf(safeReturnTo, undefined)).toBeUndefined();
    for (const input of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example',
      'javascript:alert(1)',
      '',
      ['/a'],
    ]) {
      expect(valueOf(safeReturnTo, input)).toBeUndefined();
    }
    expect(valueOf(safeReturnTo, `/${'a'.repeat(512)}`)).toBeUndefined();
  });
});

describe('pageQuery', () => {
  it('F-54: absent is page 1; one to five digits within 1..10000 are accepted', () => {
    expect(valueOf(pageQuery, undefined)).toBe(1);
    expect(valueOf(pageQuery, '1')).toBe(1);
    expect(valueOf(pageQuery, '2')).toBe(2);
    expect(valueOf(pageQuery, '10000')).toBe(10_000);
  });

  it('F-54: empty, zero, too large, non-digits and repeated parameters fail (404 in the controller)', () => {
    for (const input of ['', '0', '00000', '10001', '99999', '123456', '1.5', '-1', 'two', ' 2', ['1', '2']]) {
      expect(pageQuery.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('cityParam', () => {
  it('F-56, ADR 0007: normalises the decoded path segment like the city field', () => {
    expect(valueOf(cityParam, '  Frankfurt/Main ')).toBe('Frankfurt/Main');
    expect(valueOf(cityParam, 'München')).toBe('München');
  });

  it('B-33: empty or longer than 100 characters fails (404 in the controller)', () => {
    for (const input of ['', '   ', 'c'.repeat(101), undefined]) {
      expect(cityParam.safeParse(input).success, JSON.stringify(input)).toBe(false);
    }
  });
});

describe('composition into a form schema', () => {
  it('B-24, B-56: every field of a register form reports its own message in one pass', () => {
    const RegisterForm = z.object({ firstName, lastName, email, password: newPassword });
    const result = RegisterForm.safeParse({ firstName: ' ', lastName: 'Lovelace', email: 'nope', password: 'short' });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => [issue.path.join('.'), issue.message])).toEqual([
      ['firstName', 'Enter your first name'],
      ['email', 'Enter a valid email address, like name@example.com'],
      ['password', 'Password must be at least 12 characters'],
    ]);
  });

  it('B-26: any combination of optional profile fields parses (only city filled)', () => {
    const Onboarding = z.object({ age: optionalAge, city: optionalCity, homepage: optionalHomepage });
    expect(valueOf(Onboarding, { age: '', city: 'Berlin', homepage: '' })).toEqual({
      age: null,
      city: 'Berlin',
      homepage: null,
    });
  });
});
