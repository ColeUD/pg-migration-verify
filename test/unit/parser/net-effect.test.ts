/**
 * A file's result is its net effect: one entry per object, saying what the file leaves behind.
 * These tests cover how later statements merge into, replace, cascade over or rename earlier ones.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ParsedMigration } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, keys, noteSummaries, objectAt, parse } from './helpers.js';

beforeAll(loadParser);

/** `[key, expect]` pairs: the shape of a net result at a glance. */
function net(result: ParsedMigration): [string, string][] {
  return result.objects.map((o) => [o.key, o.expect]);
}

describe('present over present', () => {
  it('merges ALTER COLUMN into the created column and keeps the creating statement as source', () => {
    const result = parse(`
      create table todos (id int, title varchar(100));
      alter table todos alter column title type text;
      alter table todos alter column title set not null;`);
    const title = objectAt(result, 'column:public.todos.title');
    expect(attributes(title)).toEqual({
      kind: 'column',
      expect: 'present',
      schema: 'public',
      table: 'todos',
      name: 'title',
      dataType: 'text',
      notNull: true,
    });
    expect(title.source.statementIndex).toBe(0);
  });

  it('merges ENABLE and FORCE ROW LEVEL SECURITY into one rls object', () => {
    const result = parse(`
      alter table todos enable row level security;
      alter table todos force row level security;`);
    expect(attributes(objectAt(result, 'rls:public.todos'))).toMatchObject({
      enabled: true,
      forced: true,
    });
  });
});

describe('absent over present', () => {
  it('CREATE then DROP TABLE leaves only the absent table, without its dependents', () => {
    const result = parse(`
      create table todos (id int primary key, title text);
      create index todos_title_idx on todos (title);
      alter table todos enable row level security;
      create policy p on todos using (true);
      create trigger t before insert on todos for each row execute function f();
      drop table todos;`);
    expect(net(result)).toEqual([['relation:public.todos', 'absent']]);
  });

  it('DROP COLUMN also removes indexes and constraints on that column', () => {
    const result = parse(`
      create table todos (id int, slug text unique, title text);
      create index todos_slug_idx on todos (slug);
      create index todos_title_idx on todos (title);
      alter table todos drop column slug;`);
    expect(net(result)).toEqual([
      ['relation:public.todos', 'present'],
      ['column:public.todos.id', 'present'],
      ['column:public.todos.slug', 'absent'],
      ['column:public.todos.title', 'present'],
      ['relation:public.todos_title_idx', 'present'],
    ]);
  });

  it('DROP SCHEMA ... CASCADE removes everything this file put in the schema', () => {
    const result = parse(`
      create schema app;
      create table app.todos (id int);
      create type app.mood as enum ('ok');
      create table public.keep (id int);
      drop schema app cascade;`);
    expect(net(result)).toEqual([
      ['schema:app', 'absent'],
      ['relation:public.keep', 'present'],
      ['column:public.keep.id', 'present'],
    ]);
  });

  it('DROP SCHEMA without CASCADE does not touch other objects', () => {
    const result = parse('create table app.todos (id int); drop schema app;');
    expect(net(result)).toEqual([
      ['relation:app.todos', 'present'],
      ['column:app.todos.id', 'present'],
      ['schema:app', 'absent'],
    ]);
  });

  it('DROP FUNCTION without an argument list drops the function created with any signature', () => {
    const result = parse(`
      create function f(a int) returns int language sql as $$ select a $$;
      drop function f;`);
    expect(net(result)).toEqual([['function:public.f(*)', 'absent']]);
  });

  it('DROP INDEX keeps the table of an index this file created', () => {
    const result = parse('create index i on todos (title); drop index i;');
    expect(attributes(objectAt(result, 'relation:public.i'))).toMatchObject({
      kind: 'index',
      expect: 'absent',
      table: 'todos',
    });
  });
});

describe('present over absent (re-created)', () => {
  it('DROP TABLE IF EXISTS then CREATE TABLE expects the new table', () => {
    const result = parse(`
      drop table if exists todos;
      create table todos (id int);`);
    expect(net(result)).toEqual([
      ['relation:public.todos', 'present'],
      ['column:public.todos.id', 'present'],
    ]);
    expect(objectAt(result, 'relation:public.todos').source.statementIndex).toBe(1);
  });

  it('DROP FUNCTION f then CREATE FUNCTION f(...) expects only the new function', () => {
    const result = parse(`
      drop function if exists f;
      create function f(a int) returns int language sql as $$ select a $$;`);
    expect(net(result)).toEqual([['function:public.f(integer)', 'present']]);
  });
});

describe('renames', () => {
  it('RENAME TABLE moves columns, indexes, constraints, RLS, policies and triggers to the new name', () => {
    const result = parse(`
      create table todos (id int primary key, title text);
      create index todos_title_idx on todos (title);
      alter table todos enable row level security;
      create policy p on todos using (true);
      create trigger t before insert on todos for each row execute function f();
      create table comments (todo_id int references todos (id));
      alter table todos rename to tasks;`);
    expect(net(result)).toEqual([
      ['relation:public.todos', 'absent'],
      ['column:public.tasks.id', 'present'],
      ['constraint:public.tasks.primary_key(id)', 'present'],
      ['column:public.tasks.title', 'present'],
      ['relation:public.todos_title_idx', 'present'],
      ['rls:public.tasks', 'present'],
      ['policy:public.tasks.p', 'present'],
      ['trigger:public.tasks.t', 'present'],
      ['relation:public.comments', 'present'],
      ['column:public.comments.todo_id', 'present'],
      ['constraint:public.comments.foreign_key(todo_id)', 'present'],
      ['relation:public.tasks', 'present'],
    ]);
    expect(objectAt(result, 'relation:public.todos_title_idx')).toMatchObject({ table: 'tasks' });
    expect(objectAt(result, 'constraint:public.comments.foreign_key(todo_id)')).toMatchObject({
      references: { schema: 'public', table: 'tasks', columns: ['id'] },
    });
  });

  it('RENAME TABLE of a table from an earlier migration: old name absent, new name present', () => {
    expect(net(parse('alter table todos rename to tasks;'))).toEqual([
      ['relation:public.todos', 'absent'],
      ['relation:public.tasks', 'present'],
    ]);
  });

  it('RENAME COLUMN carries the known type and updates indexes, constraints and foreign keys', () => {
    const result = parse(`
      create table users (email text not null unique);
      create index users_email_idx on users (email);
      create table invites (sent_to text references users (email));
      alter table users rename column email to email_address;`);
    expect(attributes(objectAt(result, 'column:public.users.email_address'))).toEqual({
      kind: 'column',
      expect: 'present',
      schema: 'public',
      table: 'users',
      name: 'email_address',
      dataType: 'text',
      notNull: true,
    });
    expect(objectAt(result, 'column:public.users.email').expect).toBe('absent');
    expect(objectAt(result, 'constraint:public.users.unique(email_address)')).toMatchObject({
      columns: ['email_address'],
    });
    expect(objectAt(result, 'relation:public.users_email_idx')).toMatchObject({
      columns: ['email_address'],
    });
    expect(objectAt(result, 'constraint:public.invites.foreign_key(sent_to)')).toMatchObject({
      references: { schema: 'public', table: 'users', columns: ['email_address'] },
    });
  });

  it('RENAME COLUMN of a column from an earlier migration asserts nothing about its type', () => {
    const result = parse('alter table todos rename column body to description;');
    expect(result.objects.map(attributes)).toEqual([
      {
        kind: 'column',
        expect: 'absent',
        schema: 'public',
        table: 'todos',
        name: 'body',
        dataType: null,
        notNull: null,
      },
      {
        kind: 'column',
        expect: 'present',
        schema: 'public',
        table: 'todos',
        name: 'description',
        dataType: null,
        notNull: null,
      },
    ]);
  });

  it('SET SCHEMA moves a table and its dependents', () => {
    const result = parse(`
      create table todos (id int);
      create index todos_id_idx on todos (id);
      alter table todos set schema app;`);
    // Indexes live in their table's schema, so the index moves too.
    expect(net(result)).toEqual([
      ['relation:public.todos', 'absent'],
      ['column:app.todos.id', 'present'],
      ['relation:app.todos_id_idx', 'present'],
      ['relation:app.todos', 'present'],
    ]);
  });

  it('renames a schema with everything this file created in it', () => {
    const result = parse(`
      create schema app;
      create table app.todos (id int);
      alter schema app rename to core;`);
    expect(net(result)).toEqual([
      ['schema:app', 'absent'],
      ['relation:core.todos', 'present'],
      ['column:core.todos.id', 'present'],
      ['schema:core', 'present'],
    ]);
  });

  it.each([
    [
      'index (ALTER INDEX)',
      'create unique index i on todos (title); alter index i rename to j;',
      'relation:public.i',
      'relation:public.j',
      { kind: 'index', table: 'todos', unique: true, method: 'btree', columns: ['title'] },
    ],
    [
      'index renamed through ALTER TABLE',
      'create index i on todos (title); alter table i rename to j;',
      'relation:public.i',
      'relation:public.j',
      { kind: 'index', table: 'todos' },
    ],
    [
      'constraint',
      'alter table todos add constraint c check (n > 0); alter table todos rename constraint c to d;',
      'constraint:public.todos.c',
      'constraint:public.todos.d',
      { constraintType: 'check', columns: ['n'] },
    ],
    [
      'trigger',
      'create trigger t after insert on todos execute function f(); alter trigger t on todos rename to u;',
      'trigger:public.todos.t',
      'trigger:public.todos.u',
      { timing: 'AFTER', events: ['INSERT'] },
    ],
    [
      'policy',
      'create policy p on todos for select using (true); alter policy p on todos rename to q;',
      'policy:public.todos.p',
      'policy:public.todos.q',
      { command: 'SELECT', using: 'true' },
    ],
    [
      'function',
      'create function f(a int) returns int language sql as $$ select a $$; alter function f(int) rename to g;',
      'function:public.f(integer)',
      'function:public.g(integer)',
      { argTypes: ['integer'] },
    ],
    [
      'function without an argument list',
      'create function f(a text) returns text language sql as $$ select a $$; alter function f rename to g;',
      'function:public.f(text)',
      'function:public.g(text)',
      { argTypes: ['text'] },
    ],
    [
      'view',
      'create view v as select 1; alter view v rename to w;',
      'relation:public.v',
      'relation:public.w',
      { kind: 'view' },
    ],
    [
      'sequence',
      'create sequence s; alter sequence s rename to t;',
      'relation:public.s',
      'relation:public.t',
      { kind: 'sequence' },
    ],
    [
      'enum value',
      "create type mood as enum ('ok'); alter type mood rename value 'ok' to 'fine';",
      'enum_value:public.mood.ok',
      'enum_value:public.mood.fine',
      { typeName: 'mood' },
    ],
  ])('renaming a %s carries what the file knew', (_label, sql, oldKey, newKey, carried) => {
    const result = parse(sql);
    expect(objectAt(result, oldKey).expect).toBe('absent');
    expect(objectAt(result, newKey)).toMatchObject({ expect: 'present', ...carried });
    expect(result.notes).toEqual([]);
  });

  it('notes a function renamed without an argument list that this file did not create', () => {
    const result = parse('alter function legacy_fn rename to modern_fn;');
    expect(net(result)).toEqual([['function:public.legacy_fn(*)', 'absent']]);
    expect(noteSummaries(result)).toEqual([
      [
        'unverifiable',
        'RenameStmt',
        'the new name of function public.legacy_fn(...) is not checked: write the argument list so the function can be identified',
      ],
    ]);
  });
});

describe('ordering', () => {
  it('lists objects in the order the file first mentions them', () => {
    const result = parse(`
      create table b (id int);
      create table a (id int);
      alter table b add column x int;`);
    expect(keys(result)).toEqual([
      'relation:public.b',
      'column:public.b.id',
      'relation:public.a',
      'column:public.a.id',
      'column:public.b.x',
    ]);
  });
});
