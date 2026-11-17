import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { formValues, formView, parseForm } from '../form.js';

/** A register-like form; the real field rules live in shared/validation/fields.ts. */
const RegisterForm = z.object({
  firstName: z.string().trim().min(1, 'Enter your first name').max(100, 'First name must be 100 characters or fewer'),
  email: z.string().trim().toLowerCase().min(1, 'Enter an email address').pipe(z.email('Enter a valid email address')),
  password: z.string().min(12, 'Password must be at least 12 characters'),
});

describe('parseForm', () => {
  it('F-18: returns the parsed, normalised data on success', () => {
    const result = parseForm(RegisterForm, {
      _csrf: 'token',
      firstName: '  Ada ',
      email: ' Ada@Example.com ',
      password: 'correct horse battery',
    });

    expect(result).toEqual({
      ok: true,
      data: { firstName: 'Ada', email: 'ada@example.com', password: 'correct horse battery' },
    });
  });

  it('F-19, F-21, B-24: maps every invalid field to its own message', () => {
    const result = parseForm(RegisterForm, { firstName: '', email: 'not-an-email', password: 'short' });

    expect(result).toMatchObject({
      ok: false,
      errors: {
        firstName: 'Enter your first name',
        email: 'Enter a valid email address',
        password: 'Password must be at least 12 characters',
      },
    });
  });

  it('F-21: keeps only the first message per field', () => {
    const TwoChecks = z.object({
      name: z
        .string()
        .min(3, 'first')
        .regex(/^[a-z]+$/, 'second'),
    });

    expect(parseForm(TwoChecks, { name: 'A' })).toMatchObject({ ok: false, errors: { name: 'first' } });
  });

  it('F-19, F-20, B-11, B-24: keeps the submitted values but never passwords, the CSRF token or the signature', () => {
    const result = parseForm(RegisterForm, {
      _csrf: 'token-value',
      firstName: 'Ada',
      email: 'ada@',
      password: 'secret-password-1',
      newPassword: 'secret-password-2',
      currentPassword: 'secret-password-3',
      signature: 'data:image/png;base64,AAAA',
    });

    expect(result).toEqual({
      ok: false,
      errors: { email: 'Enter a valid email address' },
      values: { firstName: 'Ada', email: 'ada@' },
    });
  });

  it('B-26: a missing field is an error for that field, not an exception', () => {
    const result = parseForm(RegisterForm, {});

    expect(result.ok).toBe(false);
    expect(result.ok ? undefined : Object.keys(result.errors)).toEqual(['firstName', 'email', 'password']);
    expect(result.ok ? undefined : result.values).toEqual({});
  });

  it('B-49: a repeated field (an array from the body parser) is rejected and not echoed back', () => {
    const result = parseForm(RegisterForm, { firstName: ['Ada', 'Grace'], email: 'ada@example.com', password: 'x' });

    expect(result.ok ? undefined : Object.keys(result.errors)).toContain('firstName');
    expect(result.ok ? undefined : result.values).toEqual({ email: 'ada@example.com' });
  });

  it('F-21: a root-level refinement is reported under _form', () => {
    const Matching = z
      .object({ a: z.string(), b: z.string() })
      .refine((value) => value.a === value.b, { message: 'The values must match' });

    expect(parseForm(Matching, { a: 'x', b: 'y' })).toMatchObject({
      ok: false,
      errors: { _form: 'The values must match' },
    });
  });

  it('B-56: a body that is not an object is a failed parse, not a crash', () => {
    for (const body of [undefined, null, 'firstName=Ada', 42]) {
      expect(parseForm(RegisterForm, body)).toMatchObject({ ok: false, values: {} });
    }
  });
});

describe('formValues', () => {
  it('F-60: keeps string fields only, without secrets', () => {
    expect(formValues({ city: 'Leipzig', age: '31', password: 'x', list: ['a'], nested: { a: 1 } })).toEqual({
      city: 'Leipzig',
      age: '31',
    });
  });
});

describe('formView', () => {
  it('F-21, B-68: builds the error summary as links to the fields, in field order', () => {
    const view = formView(
      { email: 'ada@' },
      { firstName: 'Enter your first name', email: 'Enter a valid email address' },
    );

    expect(view).toEqual({
      values: { email: 'ada@' },
      errors: { firstName: 'Enter your first name', email: 'Enter a valid email address' },
      errorList: [
        { field: 'firstName', message: 'Enter your first name', href: '#firstName' },
        { field: 'email', message: 'Enter a valid email address', href: '#email' },
      ],
    });
  });

  it('F-21: a form-level error links to the main region', () => {
    expect(formView({}, { _form: 'Something is wrong' }).errorList).toEqual([
      { field: '_form', message: 'Something is wrong', href: '#main' },
    ]);
  });

  it('F-33: an empty view for the first GET', () => {
    expect(formView()).toEqual({ values: {}, errors: {}, errorList: [] });
  });
});
