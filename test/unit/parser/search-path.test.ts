/** Unqualified names resolve to the default schema, which SET search_path can change mid-file. */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadParser } from '../../../src/parser/index.js';
import { keys, noteSummaries, parse } from './helpers.js';

beforeAll(loadParser);

describe('default schema', () => {
  it('is public unless configured', () => {
    expect(keys(parse('create table t (id int)'))).toEqual([
      'relation:public.t',
      'column:public.t.id',
    ]);
    expect(keys(parse('create table t (id int)', 'app'))).toEqual([
      'relation:app.t',
      'column:app.t.id',
    ]);
  });

  it('never applies to schema-qualified names', () => {
    expect(keys(parse('create table other.t (id int)', 'app'))).toEqual([
      'relation:other.t',
      'column:other.t.id',
    ]);
  });
});

describe('SET search_path', () => {
  it.each([
    ['set search_path to app, public', 'app'],
    ['set search_path = app', 'app'],
    ['SET search_path TO "$user", extensions', 'extensions'],
    ['set local search_path to app', 'app'],
    ['set session search_path to "App Schema"', 'App Schema'],
    ["select set_config('search_path', 'app, public', false)", 'app'],
    ["select pg_catalog.set_config('search_path', 'app', true)", 'app'],
  ])('%s sends later unqualified names to %s', (statement, schema) => {
    const result = parse(
      `create table before (id int); ${statement}; create table after (id int);`,
    );
    expect(keys(result)).toEqual([
      'relation:public.before',
      'column:public.before.id',
      `relation:${schema}.after`,
      `column:${schema}.after.id`,
    ]);
    expect(result.notes.map((n) => n.category)).toEqual(['ignored']);
  });

  it.each(['reset search_path', 'set search_path to default', 'reset all'])(
    '%s goes back to the configured default',
    (statement) => {
      const result = parse(
        `set search_path to app; ${statement}; create table t (id int);`,
        'base',
      );
      expect(keys(result)).toEqual(['relation:base.t', 'column:base.t.id']);
    },
  );

  it("keeps the default for an empty path (pg_dump's set_config('search_path', '', false))", () => {
    const result = parse(
      "select pg_catalog.set_config('search_path', '', false); create table t (id int);",
    );
    expect(keys(result)).toEqual(['relation:public.t', 'column:public.t.id']);
    expect(noteSummaries(result)).toEqual([
      ['ignored', 'SelectStmt', 'search_path has no usable schema; the default schema is kept'],
    ]);
  });

  it('records the change as an ignored note', () => {
    expect(noteSummaries(parse('set search_path to app, public'))).toEqual([
      [
        'ignored',
        'VariableSetStmt',
        'search_path set: later unqualified names resolve to schema app',
      ],
    ]);
  });

  it('other settings have no lasting effect', () => {
    expect(noteSummaries(parse('set statement_timeout = 0'))).toEqual([
      ['ignored', 'VariableSetStmt', 'no lasting schema effect'],
    ]);
  });

  it('applies inside a DO block to the statements after it', () => {
    const result = parse(`do $$ begin
      set local search_path to app;
      create table t (id int);
    end $$;
    create table u (id int);`);
    expect(keys(result)).toEqual([
      'relation:app.t',
      'column:app.t.id',
      'relation:app.u',
      'column:app.u.id',
    ]);
  });
});

describe('CREATE SCHEMA with elements', () => {
  it('creates the elements in the new schema without changing the default afterwards', () => {
    const result = parse(`
      create schema app create table todos (id int) create view open_todos as select 1;
      create table later (id int);`);
    expect(keys(result)).toEqual([
      'schema:app',
      'relation:app.todos',
      'column:app.todos.id',
      'relation:app.open_todos',
      'relation:public.later',
      'column:public.later.id',
    ]);
  });

  it('names a schema created with only AUTHORIZATION after the role', () => {
    expect(keys(parse('create schema authorization app_owner'))).toEqual(['schema:app_owner']);
  });
});
