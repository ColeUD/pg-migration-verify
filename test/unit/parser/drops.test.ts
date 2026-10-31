/** Every checked DROP becomes an absent expectation; IF EXISTS and CASCADE do not change that. */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, noteSummaries, parse } from './helpers.js';

beforeAll(loadParser);

describe('DROP', () => {
  it.each([
    [
      'drop table if exists todos, app.projects cascade',
      ['relation:public.todos', 'relation:app.projects'],
    ],
    ['drop view open_todos', ['relation:public.open_todos']],
    ['drop materialized view if exists stats', ['relation:public.stats']],
    ['drop sequence app.invoice_no', ['relation:app.invoice_no']],
    ['drop index concurrently if exists app.todos_title_idx', ['relation:app.todos_title_idx']],
    ['drop type if exists mood, app.status', ['type:public.mood', 'type:app.status']],
    ['drop domain email', ['type:public.email']],
    ['drop function if exists f', ['function:public.f(*)']],
    ['drop function f()', ['function:public.f()']],
    ['drop function f(int, varchar(10))', ['function:public.f(integer,character varying)']],
    ['drop procedure app.archive(timestamptz)', ['function:app.archive(timestamp with time zone)']],
    ['drop trigger if exists t on app.todos', ['trigger:app.todos.t']],
    ['drop policy "Users can view" on public."Orders"', ['policy:public.Orders.Users can view']],
    ['drop schema if exists app cascade', ['schema:app']],
    ['drop extension if exists "uuid-ossp"', ['extension:uuid-ossp']],
  ])('%s', (sql, expectedKeys) => {
    const result = parse(sql);
    expect(result.notes).toEqual([]);
    expect(result.objects.map((o) => [o.key, o.expect])).toEqual(
      expectedKeys.map((key) => [key, 'absent']),
    );
  });

  it('marks procedures as procedures', () => {
    expect(parse('drop procedure p(int)').objects[0]).toMatchObject({ isProcedure: true });
    expect(parse('drop function p(int)').objects[0]).toMatchObject({ isProcedure: false });
  });

  it('marks dropped domains as domains', () => {
    expect(parse('drop domain email').objects[0]).toMatchObject({
      kind: 'type',
      typeKind: 'domain',
    });
  });

  it('leaves the table of a dropped index unknown when this file did not create it', () => {
    expect(attributes(parse('drop index todos_title_idx').objects[0]!)).toEqual({
      kind: 'index',
      expect: 'absent',
      schema: 'public',
      table: '',
      name: 'todos_title_idx',
      unique: null,
      method: null,
      columns: null,
    });
  });

  it.each([
    ['drop rule r on todos', 'DROP RULE is not checked'],
    ['drop cast if exists (text as int)', 'DROP CAST is not checked'],
    ['drop foreign table remote_todos', 'DROP FOREIGN TABLE is not checked'],
    ['drop routine r', 'DROP ROUTINE is not checked'],
  ])('notes object types it does not check: %s', (sql, reason) => {
    const result = parse(sql);
    expect(result.objects).toEqual([]);
    expect(noteSummaries(result)).toEqual([['unverifiable', 'DropStmt', reason]]);
  });
});
