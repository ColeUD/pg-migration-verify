/**
 * Functions and procedures are identified by schema, name and identity argument types; bodies are
 * opaque and must never leak objects or notes into the result.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { FunctionObject } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, keys, parse } from './helpers.js';

beforeAll(loadParser);

function onlyFunction(sql: string): Omit<FunctionObject, 'key' | 'source'> {
  const result = parse(sql);
  expect(result.notes).toEqual([]);
  expect(result.objects).toHaveLength(1);
  return attributes(result.objects[0]!) as Omit<FunctionObject, 'key' | 'source'>;
}

describe('CREATE FUNCTION', () => {
  it.each([
    [
      'sql function with a $$ body containing semicolons',
      `create function public.count_open(p_project uuid) returns bigint language sql stable as $$
         select count(*) from todos where project_id = p_project and not done;
       $$;`,
      'count_open',
      ['uuid'],
    ],
    [
      'plpgsql with a $fn$ body that contains a nested $$-quoted string',
      `create or replace function public.make_greeting(name text) returns text language plpgsql as $fn$
       begin
         return format($$Hello, %s; welcome!$$, name);
       end;
       $fn$;`,
      'make_greeting',
      ['text'],
    ],
    [
      'Supabase trigger function: SECURITY DEFINER, SET search_path, DML in the body',
      `create or replace function public.handle_new_user() returns trigger
       language plpgsql security definer set search_path = '' as $$
       begin
         insert into public.profiles (id) values (new.id);
         create table should_not_be_seen (id int);
         return new;
       end;
       $$;`,
      'handle_new_user',
      [],
    ],
    [
      'RETURNS TABLE: table columns are not arguments',
      `create function search_todos(q text, lim int default 20)
       returns table (id uuid, title text) language sql as $$ select id, title from todos limit lim $$;`,
      'search_todos',
      ['text', 'integer'],
    ],
    [
      'OUT parameters are skipped; IN, INOUT and VARIADIC are kept',
      `create function split_name(in full_name text, out first text, out last text, inout n int, variadic rest text[])
       language plpgsql as $$ begin first := full_name; end $$;`,
      'split_name',
      ['text', 'integer', 'text[]'],
    ],
    [
      'default arguments and typmods (stripped, like format_type(t, NULL))',
      `create function f(a varchar(10) default 'x', b numeric(10, 2) = 0, c timestamptz(3) default now())
       returns void language sql as $$ $$;`,
      'f',
      ['character varying', 'numeric', 'timestamp with time zone'],
    ],
    [
      'SQL-standard RETURN body',
      'create function add_one(a int) returns int language sql immutable return a + 1;',
      'add_one',
      ['integer'],
    ],
    [
      'SQL-standard BEGIN ATOMIC body',
      'create function two() returns int language sql begin atomic select 1; select 2; end;',
      'two',
      [],
    ],
    [
      'user-defined argument types keep the schema only when written',
      'create function set_status(s public.job_status, older job_status[]) returns void language sql as $$ $$;',
      'set_status',
      ['public.job_status', 'job_status[]'],
    ],
  ])('%s', (_label, sql, name, argTypes) => {
    expect(onlyFunction(sql)).toEqual({
      kind: 'function',
      expect: 'present',
      schema: 'public',
      name,
      argTypes,
      isProcedure: false,
    });
  });

  it('keeps schema-qualified and quoted names as Postgres stores them', () => {
    expect(
      keys(parse('create function "App"."DoThing"() returns void language sql as $$ $$;')),
    ).toEqual(['function:App.DoThing()']);
  });

  it('gives each overload its own key', () => {
    const result = parse(`
      create function area(r float8) returns float8 language sql as $$ select pi() * r * r $$;
      create function area(w int, h int) returns int language sql as $$ select w * h $$;`);
    expect(keys(result)).toEqual([
      'function:public.area(double precision)',
      'function:public.area(integer,integer)',
    ]);
  });

  it('treats OR REPLACE of the same signature as the same object', () => {
    const result = parse(`
      create function ping() returns text language sql as $$ select 'a' $$;
      create or replace function ping() returns text language sql as $$ select 'b' $$;`);
    expect(keys(result)).toEqual(['function:public.ping()']);
    expect(result.objects[0]?.source.statementIndex).toBe(0);
  });
});

describe('CREATE PROCEDURE', () => {
  it('is a function with isProcedure set', () => {
    expect(
      onlyFunction(
        `create or replace procedure archive_done(cutoff timestamptz) language sql as $$
           delete from todos where done_at < cutoff;
         $$;`,
      ),
    ).toEqual({
      kind: 'function',
      expect: 'present',
      schema: 'public',
      name: 'archive_done',
      argTypes: ['timestamp with time zone'],
      isProcedure: true,
    });
  });
});
