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

  it('DROP TABLE also removes foreign keys of other tables that reference it', () => {
    const result = parse(`
      create table p (id int primary key);
      create table q (id int primary key, p_id int references p (id));
      create table r (id int primary key, q_id int references q (id));
      drop table p cascade;`);
    expect(keys(result)).not.toContain('constraint:public.q.foreign_key(p_id)');
    expect(keys(result)).toContain('column:public.q.p_id');
    expect(keys(result)).toContain('constraint:public.r.foreign_key(q_id)');
  });

  it('DROP COLUMN also removes foreign keys that reference the column', () => {
    const result = parse(`
      create table p (id int primary key, code text unique);
      create table q (id int, p_code text references p (code));
      alter table p drop column code cascade;`);
    expect(keys(result)).not.toContain('constraint:public.q.foreign_key(p_code)');
  });

  it('DROP FUNCTION also removes triggers that execute it, and only those', () => {
    const result = parse(`
      create table r (id int);
      create function touch() returns trigger language plpgsql as $$ begin return new; end $$;
      create function audit() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger r_touch before update on r for each row execute function touch();
      create trigger r_touch_q before insert on r for each row execute function public.touch();
      create trigger r_audit after update on r for each row execute function audit();
      drop function public.touch() cascade;`);
    expect(keys(result)).not.toContain('trigger:public.r.r_touch');
    expect(keys(result)).not.toContain('trigger:public.r.r_touch_q');
    expect(keys(result)).toContain('trigger:public.r.r_audit');
  });

  it('DROP TYPE also removes columns of that type, arrays included', () => {
    const result = parse(`
      create type col_t as enum ('a');
      create table dt (id int, s col_t, ss col_t[], t text);
      drop type col_t cascade;`);
    expect(keys(result)).toEqual([
      'type:public.col_t',
      'relation:public.dt',
      'column:public.dt.id',
      'column:public.dt.t',
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

  it('marks the re-created object with the statement that dropped the earlier one', () => {
    const result = parse(`
      drop table if exists public.settings;
      create table public.settings (id int primary key, theme text not null);`);
    const settings = objectAt(result, 'relation:public.settings');
    expect(settings.recreated?.statementIndex).toBe(0);
    // Only the re-created object carries the marker; its new columns are simply present.
    expect(objectAt(result, 'column:public.settings.id')).not.toHaveProperty('recreated');
  });

  it('keeps the marker when later statements of the file alter the re-created object', () => {
    const result = parse(`
      drop table t;
      create table t (a int);
      alter table t alter column a set not null;
      create index t_a on t (a);
      drop index t_a;
      create index t_a on t (a, a);`);
    expect(objectAt(result, 'relation:public.t').recreated?.statementIndex).toBe(0);
    expect(objectAt(result, 'relation:public.t_a').recreated?.statementIndex).toBe(4);
  });

  it('records the enum rebuild that removes a value: rename away, create again, drop the old', () => {
    const result = parse(`
      alter type public.task_status rename to task_status_old;
      create type public.task_status as enum ('todo', 'doing', 'done');
      alter table tasks alter column status type public.task_status using status::text::public.task_status;
      drop type public.task_status_old;`);
    expect(net(result)).toEqual([
      ['type:public.task_status', 'present'],
      ['type:public.task_status_old', 'absent'],
      ['enum_value:public.task_status.todo', 'present'],
      ['enum_value:public.task_status.doing', 'present'],
      ['enum_value:public.task_status.done', 'present'],
      ['column:public.tasks.status', 'present'],
    ]);
    expect(objectAt(result, 'type:public.task_status').recreated?.statementIndex).toBe(0);
  });

  it('marks an object renamed onto a name the file dropped, but not a plain rename target', () => {
    const result = parse(`
      drop table t;
      alter table t_new rename to t;
      alter table u rename to u2;`);
    expect(objectAt(result, 'relation:public.t').recreated?.statementIndex).toBe(0);
    expect(objectAt(result, 'relation:public.u2')).not.toHaveProperty('recreated');
  });

  it('does not carry the marker to a new name when the re-created object is renamed', () => {
    const result = parse(`
      drop table t;
      create table t (a int);
      alter table t rename to t2;`);
    expect(objectAt(result, 'relation:public.t2')).not.toHaveProperty('recreated');
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

  it('records renames for the timeline, in order, except of what the file re-created', () => {
    const result = parse(`
      alter table todos rename column title to headline;
      set search_path = app;
      alter type mood rename to feeling;
      drop table settings;
      create table settings (id int);
      alter table settings rename to prefs;
      alter table app.prefs rename to prefs2;`);
    expect(
      result.renames.map((r) => [r.from.key, r.from.expect, r.to.key, r.to.expect, r.searchSchema]),
    ).toEqual([
      ['column:public.todos.title', 'absent', 'column:public.todos.headline', 'present', 'public'],
      ['type:app.mood', 'absent', 'type:app.feeling', 'present', 'app'],
      // settings -> prefs renamed the table this file re-created, which no earlier file has.
      ['relation:app.prefs', 'absent', 'relation:app.prefs2', 'present', 'app'],
    ]);
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

describe('generated names of unnamed indexes and constraints', () => {
  it('DROP CONSTRAINT by the generated name removes the unnamed constraint', () => {
    const result = parse(`
      create table public.inl (id int primary key, code text unique);
      alter table public.inl drop constraint inl_code_key;`);
    expect(net(result)).toEqual([
      ['relation:public.inl', 'present'],
      ['column:public.inl.id', 'present'],
      ['constraint:public.inl.primary_key(id)', 'present'],
      ['column:public.inl.code', 'present'],
      ['constraint:public.inl.inl_code_key', 'absent'],
    ]);
  });

  it('DROP INDEX by the generated name removes the unnamed index and keeps its table', () => {
    const result = parse(`
      create index on public.profiles (email);
      drop index public.profiles_email_idx;`);
    expect(net(result)).toEqual([['relation:public.profiles_email_idx', 'absent']]);
    expect(objectAt(result, 'relation:public.profiles_email_idx')).toMatchObject({
      table: 'profiles',
    });
  });

  it('RENAME CONSTRAINT and ALTER INDEX RENAME by the generated name keep the shape', () => {
    const result = parse(`
      create table t (id int, code text unique);
      create index on t (id);
      alter table t rename constraint t_code_key to t_code_unique;
      alter index t_id_idx rename to t_id_lookup;`);
    expect(net(result)).toEqual([
      ['relation:public.t', 'present'],
      ['column:public.t.id', 'present'],
      ['column:public.t.code', 'present'],
      ['constraint:public.t.t_code_key', 'absent'],
      ['constraint:public.t.t_code_unique', 'present'],
      ['relation:public.t_id_idx', 'absent'],
      ['relation:public.t_id_lookup', 'present'],
    ]);
    const constraint = objectAt(result, 'constraint:public.t.t_code_unique');
    expect(constraint).toMatchObject({ constraintType: 'unique', columns: ['code'] });
    expect(constraint).not.toHaveProperty('impliedName');
    expect(objectAt(result, 'relation:public.t_id_lookup')).toMatchObject({
      kind: 'index',
      table: 't',
      columns: ['id'],
    });
  });

  it('does not match a name Postgres would not have generated for it', () => {
    const result = parse(`
      create table t (code text unique);
      alter table t drop constraint t_code_key1;
      alter table other drop constraint t_code_key;`);
    expect(objectAt(result, 'constraint:public.t.unique(code)').expect).toBe('present');
  });
});

describe('ADD CONSTRAINT ... USING INDEX', () => {
  it.each([
    ['unique', 'create unique index widgets_code_idx on public.widgets (code)'],
    ['primary key', 'create unique index widgets_code_idx on public.widgets (code)'],
  ])('renames the index to the %s constraint', (type, createIndex) => {
    const result = parse(`
      create table public.widgets (id int not null, code text not null);
      ${createIndex};
      alter table public.widgets add constraint widgets_code_key ${type} using index widgets_code_idx;`);
    expect(objectAt(result, 'relation:public.widgets_code_idx').expect).toBe('absent');
    expect(objectAt(result, 'relation:public.widgets_code_key')).toMatchObject({
      kind: 'index',
      expect: 'present',
      table: 'widgets',
      unique: true,
      columns: ['code'],
    });
    expect(objectAt(result, 'constraint:public.widgets.widgets_code_key')).toMatchObject({
      expect: 'present',
      constraintType: type === 'unique' ? 'unique' : 'primary_key',
    });
  });

  it('renames an index created by an earlier migration (old name absent)', () => {
    const result = parse(
      'alter table public.widgets add constraint widgets_pkey primary key using index widgets_id_idx',
    );
    expect(net(result)).toEqual([
      ['relation:public.widgets_id_idx', 'absent'],
      ['relation:public.widgets_pkey', 'present'],
      ['constraint:public.widgets.widgets_pkey', 'present'],
    ]);
  });

  it.each([
    'alter table widgets add unique using index widgets_code_key',
    'alter table widgets add constraint widgets_code_key unique using index widgets_code_key',
  ])('renames nothing when the names agree: %s', (sql) => {
    expect(net(parse(sql))).toEqual([['constraint:public.widgets.widgets_code_key', 'present']]);
  });
});

describe('references to a renamed type or function', () => {
  it('rewrites column types that name a type renamed in the same file', () => {
    const result = parse(`
      create type mood as enum ('a');
      create table t (m mood, m2 public.mood[], o app.mood);
      alter type mood rename to feeling;`);
    expect(objectAt(result, 'column:public.t.m')).toMatchObject({ dataType: 'feeling' });
    expect(objectAt(result, 'column:public.t.m2')).toMatchObject({ dataType: 'public.feeling[]' });
    expect(objectAt(result, 'column:public.t.o')).toMatchObject({ dataType: 'app.mood' });
  });

  it('rewrites columns of a renamed domain, and qualified ones on SET SCHEMA', () => {
    const result = parse(`
      create domain d as int;
      create table t (x d, y public.d);
      alter domain d rename to e;
      alter domain e set schema app;`);
    expect(objectAt(result, 'column:public.t.x')).toMatchObject({ dataType: 'e' });
    expect(objectAt(result, 'column:public.t.y')).toMatchObject({ dataType: 'app.e' });
  });

  it('follows the search path: a bare name means the type in the current schema', () => {
    const result = parse(`
      set search_path = app;
      create type mood as enum ('a');
      create table t (m mood);
      alter type mood rename to feeling;`);
    expect(objectAt(result, 'column:app.t.m')).toMatchObject({ dataType: 'feeling' });
  });

  it('rewrites the signature of a function whose argument type is renamed', () => {
    const result = parse(`
      create type mood as enum ('a');
      create function f(m mood) returns int language sql as $$ select 1 $$;
      alter type mood rename to feeling;`);
    expect(keys(result)).toContain('function:public.f(feeling)');
    expect(keys(result)).not.toContain('function:public.f(mood)');
  });

  it('rewrites the function of triggers when the trigger function is renamed', () => {
    const result = parse(`
      create function public.f_touch() returns trigger language plpgsql as $$ begin return new; end $$;
      create trigger t_qualified before update on diary for each row execute function public.f_touch();
      create trigger t_bare before update on diary for each row execute function f_touch();
      create trigger t_other before update on diary for each row execute function app.f_touch();
      alter function public.f_touch() rename to f_touch2;`);
    expect(objectAt(result, 'trigger:public.diary.t_qualified')).toMatchObject({
      function: { schema: 'public', name: 'f_touch2' },
    });
    expect(objectAt(result, 'trigger:public.diary.t_bare')).toMatchObject({
      function: { schema: null, name: 'f_touch2' },
    });
    expect(objectAt(result, 'trigger:public.diary.t_other')).toMatchObject({
      function: { schema: 'app', name: 'f_touch' },
    });
  });

  it('moves qualified trigger function references on SET SCHEMA', () => {
    const result = parse(`
      create trigger t before update on diary for each row execute function public.f();
      alter function public.f() set schema app;`);
    expect(objectAt(result, 'trigger:public.diary.t')).toMatchObject({
      function: { schema: 'app', name: 'f' },
    });
  });

  it('leaves triggers alone when an overload with arguments is renamed', () => {
    const result = parse(`
      create trigger t before update on diary for each row execute function f();
      alter function f(integer) rename to g;`);
    expect(objectAt(result, 'trigger:public.diary.t')).toMatchObject({
      function: { schema: null, name: 'f' },
    });
  });
});

describe('IF NOT EXISTS within one file', () => {
  it('ADD COLUMN IF NOT EXISTS of a column the file created does nothing', () => {
    const result = parse(`
      create table t (a int);
      alter table t add column if not exists a text;`);
    expect(attributes(objectAt(result, 'column:public.t.a'))).toMatchObject({
      dataType: 'integer',
      notNull: false,
    });
    expect(objectAt(result, 'column:public.t.a')).not.toHaveProperty('conditional');
  });

  it('CREATE TABLE IF NOT EXISTS of a table the file created declares nothing', () => {
    const result = parse(`
      create table t (a int);
      create table if not exists t (a bigint not null, b text unique);`);
    expect(net(result)).toEqual([
      ['relation:public.t', 'present'],
      ['column:public.t.a', 'present'],
    ]);
    expect(objectAt(result, 'column:public.t.a')).toMatchObject({ dataType: 'integer' });
  });

  it('is certain to run after a DROP in the same file', () => {
    const result = parse(`
      drop table if exists t;
      create table if not exists t (a int);
      alter table t drop column if exists b;
      alter table t add column if not exists b text;`);
    expect(result.objects.filter((o) => o.conditional !== undefined)).toEqual([]);
    expect(objectAt(result, 'relation:public.t').recreated?.statementIndex).toBe(0);
  });

  it('stays conditional on what the file does not know about', () => {
    const result = parse('create table if not exists t (a int);');
    expect(result.objects.map((o) => o.conditional)).toEqual([
      'relation:public.t',
      'relation:public.t',
    ]);
  });

  it('a definite ALTER after a conditional CREATE asserts only what the ALTER says', () => {
    const result = parse(`
      create table if not exists t (a int not null);
      alter table t alter column a type bigint;`);
    const a = objectAt(result, 'column:public.t.a');
    expect(attributes(a)).toMatchObject({ dataType: 'bigint', notNull: null });
    expect(a).not.toHaveProperty('conditional');
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
