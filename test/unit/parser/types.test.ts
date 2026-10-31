/**
 * Type normalization must produce exactly what Postgres' format_type() prints, because the catalog
 * reader reports column and argument types that way and the verifier compares strings.
 */
import type { TypeName } from 'libpg-query';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ColumnObject, FunctionObject } from '../../../src/model.js';
import { loadParser, normalizeTypeName } from '../../../src/parser/index.js';
import { noteSummaries, objectAt, parse } from './helpers.js';

beforeAll(loadParser);

/** The normalized type of a column declared as `sqlType`. */
function columnType(sqlType: string): string | null {
  const result = parse(`create table t (c ${sqlType})`);
  return (objectAt(result, 'column:public.t.c') as ColumnObject).dataType;
}

/** The normalized identity type of a function argument declared as `sqlType`. */
function argumentType(sqlType: string): string | undefined {
  const result = parse(`create function f(a ${sqlType}) returns void language sql as $$ $$`);
  const fn = result.objects.find((o): o is FunctionObject => o.kind === 'function');
  return fn?.argTypes?.[0];
}

describe('normalizeTypeName for columns (format_type with typmod)', () => {
  it.each([
    // integers
    ['int', 'integer'],
    ['integer', 'integer'],
    ['int4', 'integer'],
    ['int2', 'smallint'],
    ['smallint', 'smallint'],
    ['int8', 'bigint'],
    ['bigint', 'bigint'],
    // serial types are plain integers in the catalog
    ['serial', 'integer'],
    ['serial4', 'integer'],
    ['bigserial', 'bigint'],
    ['serial8', 'bigint'],
    ['smallserial', 'smallint'],
    ['serial2', 'smallint'],
    // floating point (float(p) picks real or double precision by precision)
    ['real', 'real'],
    ['float4', 'real'],
    ['float', 'double precision'],
    ['float(10)', 'real'],
    ['float(30)', 'double precision'],
    ['float8', 'double precision'],
    ['double precision', 'double precision'],
    // booleans
    ['bool', 'boolean'],
    ['boolean', 'boolean'],
    // character types
    ['varchar', 'character varying'],
    ['varchar(255)', 'character varying(255)'],
    ['character varying(10)', 'character varying(10)'],
    ['national character varying(4)', 'character varying(4)'],
    ['char', 'character(1)'],
    ['character', 'character(1)'],
    ['char(10)', 'character(10)'],
    ['bpchar(5)', 'character(5)'],
    // a length-less bpchar column really is printed as bpchar by format_type
    ['bpchar', 'bpchar'],
    // quoted "char" is the one-byte internal type, not character(1)
    ['"char"', '"char"'],
    // numeric: a lone precision means scale 0
    ['numeric', 'numeric'],
    ['decimal', 'numeric'],
    ['numeric(10,2)', 'numeric(10,2)'],
    ['numeric(10)', 'numeric(10,0)'],
    ['decimal(5)', 'numeric(5,0)'],
    // date/time: precision goes before the time zone words
    ['timestamp', 'timestamp without time zone'],
    ['timestamp(3)', 'timestamp(3) without time zone'],
    ['timestamptz', 'timestamp with time zone'],
    ['timestamp with time zone', 'timestamp with time zone'],
    ['timestamp(3) with time zone', 'timestamp(3) with time zone'],
    ['timestamptz(6)', 'timestamp(6) with time zone'],
    ['timestamp(9)', 'timestamp(6) without time zone'],
    ['time', 'time without time zone'],
    ['time(3)', 'time(3) without time zone'],
    ['timetz', 'time with time zone'],
    ['time(2) with time zone', 'time(2) with time zone'],
    ['date', 'date'],
    // bit strings: BIT alone means BIT(1)
    ['bit', 'bit(1)'],
    ['bit(8)', 'bit(8)'],
    ['varbit', 'bit varying'],
    ['varbit(4)', 'bit varying(4)'],
    ['bit varying(8)', 'bit varying(8)'],
    // types that pass through unchanged
    ['text', 'text'],
    ['uuid', 'uuid'],
    ['json', 'json'],
    ['jsonb', 'jsonb'],
    ['bytea', 'bytea'],
    ['inet', 'inet'],
    ['citext', 'citext'],
    ['pg_catalog.text', 'text'],
    ['pg_catalog.int4', 'integer'],
    // extension types keep numeric typmods
    ['vector(1536)', 'vector(1536)'],
  ])('%s -> %s', (sqlType, expected) => {
    expect(columnType(sqlType)).toBe(expected);
  });
});

describe('interval field restrictions', () => {
  it.each([
    ['interval', 'interval'],
    ['interval year', 'interval year'],
    ['interval month', 'interval month'],
    ['interval day', 'interval day'],
    ['interval hour', 'interval hour'],
    ['interval minute', 'interval minute'],
    ['interval second', 'interval second'],
    ['interval year to month', 'interval year to month'],
    ['interval day to hour', 'interval day to hour'],
    ['interval day to minute', 'interval day to minute'],
    ['interval day to second', 'interval day to second'],
    ['interval hour to minute', 'interval hour to minute'],
    ['interval hour to second', 'interval hour to second'],
    ['interval minute to second', 'interval minute to second'],
    ['interval second(3)', 'interval second(3)'],
    ['interval day to second(3)', 'interval day to second(3)'],
    ['interval(4)', 'interval(4)'],
  ])('%s -> %s', (sqlType, expected) => {
    expect(columnType(sqlType)).toBe(expected);
  });

  it('returns null for a field mask it cannot decode, rather than guessing', () => {
    const typeName: TypeName = {
      names: [{ String: { sval: 'pg_catalog' } }, { String: { sval: 'interval' } }],
      typmods: [{ A_Const: { ival: { ival: 12345 } } }],
    };
    expect(normalizeTypeName(typeName)).toBeNull();
  });
});

describe('arrays', () => {
  it.each([
    ['int[]', 'integer[]'],
    ['int[][]', 'integer[]'],
    ['int[3][4]', 'integer[]'],
    ['text array', 'text[]'],
    ['varchar(20)[]', 'character varying(20)[]'],
    ['timestamptz[]', 'timestamp with time zone[]'],
    ['public.job_status[]', 'public.job_status[]'],
  ])('%s -> %s (format_type does not track dimensions)', (sqlType, expected) => {
    expect(columnType(sqlType)).toBe(expected);
  });
});

describe('user-defined types', () => {
  it.each([
    ['job_status', 'job_status'],
    ['public.job_status', 'public.job_status'],
    ['app.job_status', 'app.job_status'],
    ['extensions.citext', 'extensions.citext'],
    ['"Mood"', '"Mood"'],
    ['"My Schema"."Mood"', '"My Schema"."Mood"'],
    ['App.Mood', 'app.mood'],
  ])('%s -> %s (schema kept only when written, quoted like quote_ident)', (sqlType, expected) => {
    expect(columnType(sqlType)).toBe(expected);
  });
});

describe('function argument types (format_type without typmod)', () => {
  it.each([
    ['varchar(255)', 'character varying'],
    ['character varying', 'character varying'],
    ['numeric(10,2)', 'numeric'],
    ['timestamptz(3)', 'timestamp with time zone'],
    ['timestamp', 'timestamp without time zone'],
    ['char(3)', 'character'],
    ['bpchar', 'character'],
    ['bit(8)', 'bit'],
    ['interval day to second', 'interval'],
    ['int', 'integer'],
    ['int[]', 'integer[]'],
    ['public.job_status', 'public.job_status'],
    ['"Mood"', '"Mood"'],
  ])('%s -> %s', (sqlType, expected) => {
    expect(argumentType(sqlType)).toBe(expected);
  });

  it('returns null for %TYPE references, which only the database can resolve', () => {
    const typeName: TypeName = {
      names: [{ String: { sval: 'todos' } }, { String: { sval: 'title' } }],
      pct_type: true,
    };
    expect(normalizeTypeName(typeName)).toBeNull();
    expect(normalizeTypeName(typeName, { withTypmod: false })).toBeNull();
  });

  it('turns a function with a %TYPE argument into a note instead of a guessed signature', () => {
    const result = parse(
      'create function set_title(t public.todos.title%type) returns void language sql as $$ $$',
    );
    expect(result.objects).toEqual([]);
    expect(noteSummaries(result)).toEqual([
      [
        'unverifiable',
        'CreateFunctionStmt',
        'an argument type uses %TYPE, so the function signature cannot be known from the SQL alone',
      ],
    ]);
  });
});
