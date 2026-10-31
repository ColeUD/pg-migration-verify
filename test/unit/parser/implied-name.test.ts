/**
 * The names Postgres generates for unnamed constraints and indexes. The integration test
 * migration-patterns.test.ts checks the same rules against a real server.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ExpectedObject } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { makeObjectName } from '../../../src/parser/implied-name.js';
import { parse } from './helpers.js';

beforeAll(loadParser);

/** `[key, impliedName]` of every unnamed index and constraint the SQL declares. */
function impliedNames(sql: string): [string, string | undefined][] {
  return parse(sql).objects.flatMap((o: ExpectedObject) =>
    (o.kind === 'constraint' || o.kind === 'index') && o.name === null
      ? [[o.key, o.impliedName]]
      : [],
  );
}

describe('generated names of unnamed constraints', () => {
  it.each([
    ['create table t (id int primary key)', 't_pkey'],
    ['create table t (a int, b int, primary key (a, b))', 't_pkey'],
    ['create table t (code text unique)', 't_code_key'],
    ['create table t (a int, b int, unique (a, b))', 't_a_b_key'],
    ['create table t (a int, b int, unique (a) include (b))', 't_a_b_key'],
    ['create table t (owner_id uuid references profiles (id))', 't_owner_id_fkey'],
    ['create table t (a int, b int, foreign key (a, b) references p (x, y))', 't_a_b_fkey'],
    ['create table t (age int check (age > 0))', 't_age_check'],
    ['create table t (a int, check (a > 0 and a < 10))', 't_a_check'],
    ['create table t (a int, b int, check (a > b))', 't_check'],
    ['create table t (a int check (true))', 't_check'],
    ['create table t (r tstzrange, exclude using gist (r with &&))', 't_r_excl'],
    ['alter table t add unique (slug)', 't_slug_key'],
  ])('%s -> %s', (sql, name) => {
    expect(impliedNames(sql).map(([, implied]) => implied)).toContain(name);
  });

  it('gives named constraints no generated name', () => {
    const [, , check] = parse('create table t (a int constraint a_positive check (a > 0))').objects;
    expect(check).toMatchObject({ kind: 'constraint', name: 'a_positive' });
    expect(check).not.toHaveProperty('impliedName');
  });

  it('names a USING INDEX constraint without a name after the index', () => {
    const [constraint] = parse('alter table t add unique using index t_code_idx').objects;
    expect(constraint).toMatchObject({ kind: 'constraint', name: 't_code_idx', columns: null });
    expect(constraint).not.toHaveProperty('impliedName');
  });
});

describe('generated names of unnamed indexes', () => {
  it.each([
    ['create index on t (email)', 't_email_idx'],
    ['create unique index on t (a, b)', 't_a_b_idx'],
    ['create index on t (a) include (b, c)', 't_a_b_c_idx'],
    ['create index on t ((a + b))', 't_expr_idx'],
    ['create index on t ((a + b), (a - b))', 't_expr_expr1_idx'],
    ['create index on t (lower(email))', 't_lower_idx'],
    ['create index on t (lower(a), lower(b))', 't_lower_lower1_idx'],
    ["create index on t ((data ->> 'k'))", 't_expr_idx'],
    ['create index on t ((a::text))', 't_a_idx'],
    ["create index on t (('x'::text))", 't_text_idx'],
    ['create index on t ((coalesce(a, b)))', 't_coalesce_idx'],
    ['create index on t (a, a)', 't_a_a1_idx'],
    ['create index on app."Todo Items" ("projectId", done)', 'Todo Items_projectId_done_idx'],
  ])('%s -> %s', (sql, name) => {
    expect(impliedNames(sql)).toEqual([[expect.any(String), name]]);
  });

  it('gives named indexes no generated name', () => {
    expect(parse('create index t_a on t (a)').objects[0]).not.toHaveProperty('impliedName');
  });
});

describe('makeObjectName', () => {
  it('cuts the longer name first until the result fits in 63 bytes', () => {
    const name = makeObjectName('a'.repeat(40), 'b'.repeat(40), 'key');
    expect(name).toBe(`${'a'.repeat(29)}_${'b'.repeat(29)}_key`);
    expect(Buffer.byteLength(name)).toBe(63);
  });

  it('cuts only the long name when the other is short', () => {
    expect(makeObjectName('t'.repeat(70), 'id', 'fkey')).toBe(`${'t'.repeat(55)}_id_fkey`);
    expect(makeObjectName('t'.repeat(70), null, 'pkey')).toBe(`${'t'.repeat(58)}_pkey`);
  });

  it('never cuts a multibyte character in half', () => {
    // 30 two-byte characters (60 bytes) must lose 3 bytes: 2 characters go, not 1.5.
    const name = makeObjectName('é'.repeat(30), 'c', 'key');
    expect(name).toBe(`${'é'.repeat(28)}_c_key`);
    expect(Buffer.byteLength(name)).toBe(62);
  });

  it('leaves short names alone', () => {
    expect(makeObjectName('profiles', 'username', 'key')).toBe('profiles_username_key');
  });
});
