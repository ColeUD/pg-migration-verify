/** CREATE TABLE (every column and constraint form), other relations, and ALTER TABLE. */
import { beforeAll, describe, expect, it } from 'vitest';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, keys, noteSummaries, objectAt, parse } from './helpers.js';

beforeAll(loadParser);

describe('CREATE TABLE', () => {
  const sql = `
    create table if not exists app.todos (
      id bigint generated always as identity primary key,
      project_id uuid not null references app.projects (id) on delete cascade,
      owner_id uuid references auth.users,
      title text not null check (char_length(title) between 1 and 200),
      "Display Name" text,
      status text default 'open' constraint todos_status_check check (status in ('open', 'done')),
      priority smallint null,
      slug text unique,
      tags text[] not null default '{}',
      serial_no serial,
      starts_at timestamptz,
      ends_at timestamptz,
      constraint todos_dates_check check (ends_at > starts_at),
      constraint todos_project_slug_key unique (project_id, slug),
      foreign key (owner_id, project_id) references app.memberships (user_id, project_id),
      exclude using gist (project_id with =, tstzrange(starts_at, ends_at) with &&)
    );`;

  it('emits the table, every column and every constraint in source order', () => {
    expect(keys(parse(sql))).toEqual([
      'relation:app.todos',
      'column:app.todos.id',
      'constraint:app.todos.primary_key(id)',
      'column:app.todos.project_id',
      'constraint:app.todos.foreign_key(project_id)',
      'column:app.todos.owner_id',
      'constraint:app.todos.foreign_key(owner_id)',
      'column:app.todos.title',
      'constraint:app.todos.check(title)',
      'column:app.todos.Display Name',
      'column:app.todos.status',
      'constraint:app.todos.todos_status_check',
      'column:app.todos.priority',
      'column:app.todos.slug',
      'constraint:app.todos.unique(slug)',
      'column:app.todos.tags',
      'column:app.todos.serial_no',
      'column:app.todos.starts_at',
      'column:app.todos.ends_at',
      'constraint:app.todos.todos_dates_check',
      'constraint:app.todos.todos_project_slug_key',
      'constraint:app.todos.foreign_key(owner_id,project_id)',
      'constraint:app.todos.exclusion(project_id,(tstzrange(starts_at, ends_at)))',
    ]);
  });

  it.each([
    // [column, dataType, notNull, why]
    ['id', 'bigint', true, 'identity and inline PRIMARY KEY'],
    ['project_id', 'uuid', true, 'NOT NULL'],
    ['owner_id', 'uuid', false, 'no NOT NULL means nullable'],
    ['Display Name', 'text', false, 'quoted name kept verbatim'],
    ['priority', 'smallint', false, 'explicit NULL'],
    ['tags', 'text[]', true, 'NOT NULL with a default'],
    ['serial_no', 'integer', true, 'serial implies NOT NULL'],
    ['starts_at', 'timestamp with time zone', false, 'timestamptz'],
  ])('column %s is %s, notNull %s (%s)', (name, dataType, notNull) => {
    expect(objectAt(parse(sql), `column:app.todos.${name}`)).toMatchObject({
      kind: 'column',
      expect: 'present',
      schema: 'app',
      table: 'todos',
      name,
      dataType,
      notNull,
    });
  });

  it('describes foreign keys with their referenced table and columns', () => {
    const result = parse(sql);
    expect(objectAt(result, 'constraint:app.todos.foreign_key(project_id)')).toMatchObject({
      name: null,
      constraintType: 'foreign_key',
      columns: ['project_id'],
      references: { schema: 'app', table: 'projects', columns: ['id'] },
    });
    // REFERENCES auth.users without a column list means its primary key: not known from SQL.
    expect(objectAt(result, 'constraint:app.todos.foreign_key(owner_id)')).toMatchObject({
      references: { schema: 'auth', table: 'users', columns: null },
    });
    expect(objectAt(result, 'constraint:app.todos.foreign_key(owner_id,project_id)')).toMatchObject(
      {
        columns: ['owner_id', 'project_id'],
        references: { schema: 'app', table: 'memberships', columns: ['user_id', 'project_id'] },
      },
    );
  });

  it('lists the columns a check constraint references, sorted', () => {
    expect(objectAt(parse(sql), 'constraint:app.todos.todos_dates_check')).toMatchObject({
      name: 'todos_dates_check',
      constraintType: 'check',
      columns: ['ends_at', 'starts_at'],
      references: null,
    });
  });

  it('does not emit indexes for PRIMARY KEY and UNIQUE constraints', () => {
    expect(parse(sql).objects.filter((o) => o.kind === 'index')).toEqual([]);
  });

  it('makes columns of a table-level PRIMARY KEY NOT NULL', () => {
    const result = parse(
      'create table memberships (user_id uuid, project_id uuid, role text, primary key (user_id, project_id));',
    );
    expect(result.objects.filter((o) => o.kind === 'column').map(attributes)).toEqual([
      {
        kind: 'column',
        expect: 'present',
        schema: 'public',
        table: 'memberships',
        name: 'user_id',
        dataType: 'uuid',
        notNull: true,
      },
      {
        kind: 'column',
        expect: 'present',
        schema: 'public',
        table: 'memberships',
        name: 'project_id',
        dataType: 'uuid',
        notNull: true,
      },
      {
        kind: 'column',
        expect: 'present',
        schema: 'public',
        table: 'memberships',
        name: 'role',
        dataType: 'text',
        notNull: false,
      },
    ]);
    expect(
      objectAt(result, 'constraint:public.memberships.primary_key(user_id,project_id)'),
    ).toMatchObject({
      constraintType: 'primary_key',
      columns: ['user_id', 'project_id'],
    });
  });

  it.each([
    [
      'create table "Orders" ("OrderId" int)',
      'relation:public.Orders',
      'column:public.Orders.OrderId',
    ],
    ['create table "My Schema"."T" (x int)', 'relation:My Schema.T', 'column:My Schema.T.x'],
    ['create table App.Todos (Title text)', 'relation:app.todos', 'column:app.todos.title'],
    [
      'create table public."Display Names" ("Full Name" text)',
      'relation:public.Display Names',
      'column:public.Display Names.Full Name',
    ],
  ])('stores identifiers as Postgres does: %s', (statement, tableKey, columnKey) => {
    expect(keys(parse(statement))).toEqual([tableKey, columnKey]);
  });

  it('treats IF NOT EXISTS like a plain CREATE', () => {
    const plain = parse('create table t (id int not null)').objects.map(attributes);
    const ifNotExists = parse('create table if not exists t (id int not null)').objects.map(
      attributes,
    );
    expect(ifNotExists).toEqual(plain);
  });

  it('checks unlogged tables like any other table', () => {
    expect(keys(parse('create unlogged table cache (k text)'))).toEqual([
      'relation:public.cache',
      'column:public.cache.k',
    ]);
  });

  it('ignores temporary tables, which do not outlive the session', () => {
    const result = parse('create temp table scratch (id int)');
    expect(result.objects).toEqual([]);
    expect(noteSummaries(result)).toEqual([
      ['ignored', 'CreateStmt', 'temporary table: it does not outlive the session'],
    ]);
  });

  it.each([
    [
      "create table events_2024 partition of events for values from ('2024-01-01') to ('2025-01-01')",
      'relation:public.events_2024',
      'columns of a partition come from its parent table and are not checked',
    ],
    [
      'create table special_todos (extra text) inherits (todos)',
      'relation:public.special_todos',
      'inherited columns come from the parent table and are not checked',
    ],
    [
      'create table todos_copy (like todos including all)',
      'relation:public.todos_copy',
      'columns copied with LIKE are not listed, so they are not checked',
    ],
  ])('expects the table but notes columns it cannot see: %s', (statement, tableKey, reason) => {
    const result = parse(statement);
    expect(objectAt(result, tableKey).kind).toBe('table');
    expect(noteSummaries(result)).toEqual([['unverifiable', 'CreateStmt', reason]]);
  });
});

describe('other relations', () => {
  it.each([
    [
      'create or replace view public.open_todos as select * from todos where not done',
      'view',
      'relation:public.open_todos',
      'ViewStmt',
    ],
    [
      'create materialized view stats as select count(*) from todos with no data',
      'materialized_view',
      'relation:public.stats',
      'CreateTableAsStmt',
    ],
    [
      'create table todo_archive as select * from todos',
      'table',
      'relation:public.todo_archive',
      'CreateTableAsStmt',
    ],
    [
      'create sequence if not exists app.invoice_no start 1000',
      'sequence',
      'relation:app.invoice_no',
      'CreateSeqStmt',
    ],
  ])('%s', (statement, kind, key) => {
    const result = parse(statement);
    expect(keys(result)).toEqual([key]);
    expect(objectAt(result, key).kind).toBe(kind);
  });

  it('notes that the columns of CREATE TABLE AS / materialized views are not checked', () => {
    expect(noteSummaries(parse('create materialized view stats as select 1 as n'))).toEqual([
      ['unverifiable', 'CreateTableAsStmt', 'columns come from a query and are not checked'],
    ]);
  });

  it('ignores temporary views', () => {
    expect(parse('create temp view v as select 1').objects).toEqual([]);
  });
});

describe('ALTER TABLE', () => {
  it.each([
    [
      'add column',
      'alter table todos add column notes text',
      { name: 'notes', expect: 'present', dataType: 'text', notNull: false },
    ],
    [
      'add column if not exists',
      "alter table todos add column if not exists notes text not null default ''",
      { name: 'notes', expect: 'present', dataType: 'text', notNull: true },
    ],
    [
      'drop column',
      'alter table todos drop column if exists legacy',
      { name: 'legacy', expect: 'absent', dataType: null, notNull: null },
    ],
    [
      'alter type',
      'alter table todos alter column title type varchar(500) using title::varchar(500)',
      { name: 'title', expect: 'present', dataType: 'character varying(500)', notNull: null },
    ],
    [
      'set data type',
      'alter table todos alter column n set data type bigint',
      { name: 'n', expect: 'present', dataType: 'bigint', notNull: null },
    ],
    [
      'set not null',
      'alter table todos alter column title set not null',
      { name: 'title', expect: 'present', dataType: null, notNull: true },
    ],
    [
      'drop not null',
      'alter table todos alter column title drop not null',
      { name: 'title', expect: 'present', dataType: null, notNull: false },
    ],
  ])('%s', (_label, statement, column) => {
    const result = parse(statement);
    expect(result.objects.map(attributes)).toEqual([
      { kind: 'column', schema: 'public', table: 'todos', ...column },
    ]);
    expect(result.notes).toEqual([]);
  });

  it('adds a column together with its inline constraints', () => {
    const result = parse(
      'alter table todos add column assignee uuid references auth.users (id) on delete set null',
    );
    expect(keys(result)).toEqual([
      'column:public.todos.assignee',
      'constraint:public.todos.foreign_key(assignee)',
    ]);
  });

  it('adds and drops named constraints', () => {
    const result = parse(`
      alter table todos add constraint todos_title_len check (length(title) < 500);
      alter table projects drop constraint if exists projects_name_key;`);
    expect(result.objects.map(attributes)).toEqual([
      {
        kind: 'constraint',
        expect: 'present',
        schema: 'public',
        table: 'todos',
        name: 'todos_title_len',
        constraintType: 'check',
        columns: ['title'],
        references: null,
      },
      {
        kind: 'constraint',
        expect: 'absent',
        schema: 'public',
        table: 'projects',
        name: 'projects_name_key',
        constraintType: null,
        columns: null,
        references: null,
      },
    ]);
  });

  it('makes the columns of an added PRIMARY KEY NOT NULL', () => {
    const result = parse('alter table todos add primary key (id)');
    expect(result.objects.map(attributes)).toEqual([
      {
        kind: 'column',
        expect: 'present',
        schema: 'public',
        table: 'todos',
        name: 'id',
        dataType: null,
        notNull: true,
      },
      {
        kind: 'constraint',
        expect: 'present',
        schema: 'public',
        table: 'todos',
        name: null,
        constraintType: 'primary_key',
        columns: ['id'],
        references: null,
      },
    ]);
  });

  it.each([
    ['enable row level security', { enabled: true, forced: null }],
    ['disable row level security', { enabled: false, forced: null }],
    ['force row level security', { enabled: null, forced: true }],
    ['no force row level security', { enabled: null, forced: false }],
  ])('%s', (action, state) => {
    expect(parse(`alter table todos ${action}`).objects.map(attributes)).toEqual([
      { kind: 'rls', expect: 'present', schema: 'public', table: 'todos', ...state },
    ]);
  });

  it('handles several subcommands in one statement', () => {
    const result = parse(`
      alter table if exists only app.todos
        add column a int not null default 0,
        add column b text,
        alter column c set not null,
        drop column d,
        alter column e set default now(),
        enable row level security;`);
    expect(keys(result)).toEqual([
      'column:app.todos.a',
      'column:app.todos.b',
      'column:app.todos.c',
      'column:app.todos.d',
      'rls:app.todos',
    ]);
    expect(noteSummaries(result)).toEqual([
      ['unverifiable', 'AlterTableStmt', 'column defaults are not checked'],
    ]);
  });

  it.each([
    ["alter table todos alter column status set default 'open'", 'column defaults are not checked'],
    ['alter table todos alter column status drop default', 'column defaults are not checked'],
    ['alter table todos owner to postgres', 'ownership is not checked'],
    ['alter table todos replica identity full', 'ALTER TABLE ReplicaIdentity is not checked'],
    [
      'alter table todos validate constraint todos_title_len',
      'ALTER TABLE ValidateConstraint is not checked',
    ],
    ['alter view open_todos owner to postgres', 'ownership is not checked'],
    [
      'alter index todos_title_idx set (fillfactor = 70)',
      'ALTER INDEX SetRelOptions is not checked',
    ],
    [
      'alter materialized view stats set (autovacuum_enabled = false)',
      'ALTER MATERIALIZED VIEW SetRelOptions is not checked',
    ],
  ])('notes what it cannot check: %s', (statement, reason) => {
    const result = parse(statement);
    expect(result.objects).toEqual([]);
    expect(noteSummaries(result)).toEqual([['unverifiable', 'AlterTableStmt', reason]]);
  });
});
