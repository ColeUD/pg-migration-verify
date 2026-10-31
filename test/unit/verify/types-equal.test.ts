import { describe, expect, it } from 'vitest';
import {
  splitSchemaQualifier,
  typeListsEqual,
  typesEqual,
} from '../../../src/verify/types-equal.js';

describe('typesEqual', () => {
  it.each([
    // [expected (migration), actual (catalog), equal]
    ['integer', 'integer', true],
    ['integer', 'bigint', false],
    ['character varying(255)', 'character varying(255)', true],
    ['character varying(255)', 'character varying(100)', false],
    ['timestamp with time zone', 'timestamp with time zone', true],
    ['double precision', 'double precision', true],
    ['numeric(10,2)', 'numeric(10,2)', true],
    ['text[]', 'text[]', true],
    ['text[]', 'text', false],
    // bare user type resolved through the search path
    ['job_status', 'public.job_status', true],
    ['job_status[]', 'public.job_status[]', true],
    ['job_status', 'public.job_status[]', false],
    // Supabase installs extension types into `extensions`
    ['citext', 'extensions.citext', true],
    // qualified expectations must match exactly
    ['public.job_status', 'public.job_status', true],
    ['public.job_status', 'private.job_status', false],
    ['private.job_status', 'job_status', false],
    ['job_status', 'job_state', false],
    // quoted identifiers, including ones with dots and quotes inside
    ['"Job Status"', 'public."Job Status"', true],
    ['"my.type"', 'public."my.type"', true],
    ['"my.type"[]', '"My Schema"."my.type"[]', true],
    ['"my.type"', 'my.type', false],
    ['"say ""hi"""', 'public."say ""hi"""', true],
    ['type', '"my.schema".type', true],
  ] as const)('%s vs %s -> %s', (expected, actual, equal) => {
    expect(typesEqual(expected, actual)).toBe(equal);
  });
});

describe('splitSchemaQualifier', () => {
  it.each([
    ['integer', null, 'integer'],
    ['public.job_status', 'public', 'job_status'],
    ['"a.b".c', '"a.b"', 'c'],
    ['"a.b"', null, '"a.b"'],
    ['"unterminated.x', null, '"unterminated.x'],
    ['timestamp(3) with time zone', null, 'timestamp(3) with time zone'],
  ] as const)('%s -> schema %s, rest %s', (type, schema, rest) => {
    expect(splitSchemaQualifier(type)).toEqual({ schema, rest });
  });
});

describe('typeListsEqual', () => {
  it('compares element-wise with schema leniency', () => {
    expect(typeListsEqual(['uuid', 'job_status'], ['uuid', 'public.job_status'])).toBe(true);
  });

  it('requires equal length and order', () => {
    expect(typeListsEqual(['uuid'], ['uuid', 'text'])).toBe(false);
    expect(typeListsEqual(['text', 'uuid'], ['uuid', 'text'])).toBe(false);
    expect(typeListsEqual([], [])).toBe(true);
  });
});
