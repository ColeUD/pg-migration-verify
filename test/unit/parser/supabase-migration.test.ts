/**
 * End to end: a realistic Supabase-style migration, with the complete expected result spelled out.
 * If this test changes, the change in behaviour should be visible right here in the diff.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ConstraintObject, ParsedMigration } from '../../../src/model.js';
import { loadParser } from '../../../src/parser/index.js';
import { attributes, fixture, noteSummaries, objectAt, parse } from './helpers.js';

beforeAll(loadParser);

const present = { expect: 'present' } as const;
const table = (name: string) => ({ kind: 'table', ...present, schema: 'public', name });
const column = (tableName: string, name: string, dataType: string, notNull: boolean) => ({
  kind: 'column',
  ...present,
  schema: 'public',
  table: tableName,
  name,
  dataType,
  notNull,
});
const constraint = (
  tableName: string,
  name: string | null,
  constraintType: ConstraintObject['constraintType'],
  columns: string[],
  references: ConstraintObject['references'] = null,
) => ({
  kind: 'constraint',
  ...present,
  schema: 'public',
  table: tableName,
  name,
  constraintType,
  columns,
  references,
});
const rls = (tableName: string) => ({
  kind: 'rls',
  ...present,
  schema: 'public',
  table: tableName,
  enabled: true,
  forced: null,
});
const enumValue = (value: string) => ({
  kind: 'enum_value',
  ...present,
  schema: 'public',
  typeName: 'todo_status',
  value,
});

describe('a Supabase-style migration', () => {
  let result: ParsedMigration;
  beforeAll(() => {
    result = parse(fixture('supabase-todos.sql'));
  });

  it('yields exactly these objects, in order', () => {
    expect(result.objects.map(attributes)).toEqual([
      { kind: 'extension', ...present, schema: 'extensions', name: 'pgcrypto' },
      { kind: 'type', ...present, schema: 'public', name: 'todo_status', typeKind: 'enum' },
      enumValue('open'),
      enumValue('in_progress'),
      enumValue('done'),

      table('profiles'),
      column('profiles', 'id', 'uuid', true),
      constraint('profiles', null, 'primary_key', ['id']),
      constraint('profiles', null, 'foreign_key', ['id'], {
        schema: 'auth',
        table: 'users',
        columns: ['id'],
      }),
      column('profiles', 'username', 'text', false),
      constraint('profiles', null, 'unique', ['username']),
      column('profiles', 'full_name', 'text', false),
      column('profiles', 'avatar_url', 'text', false),
      column('profiles', 'updated_at', 'timestamp with time zone', false),
      constraint('profiles', 'username_length', 'check', ['username']),
      rls('profiles'),
      {
        kind: 'policy',
        ...present,
        schema: 'public',
        table: 'profiles',
        name: 'Public profiles are viewable by everyone.',
        command: 'SELECT',
        permissive: true,
        roles: ['public'],
        using: 'true',
        withCheck: null,
      },
      {
        kind: 'policy',
        ...present,
        schema: 'public',
        table: 'profiles',
        name: 'Users can insert their own profile.',
        command: 'INSERT',
        permissive: true,
        roles: ['public'],
        using: null,
        withCheck: '((SELECT auth.uid())) = id',
      },

      table('projects'),
      column('projects', 'id', 'uuid', true),
      constraint('projects', null, 'primary_key', ['id']),
      column('projects', 'owner_id', 'uuid', true),
      constraint('projects', null, 'foreign_key', ['owner_id'], {
        schema: 'public',
        table: 'profiles',
        columns: ['id'],
      }),
      column('projects', 'name', 'character varying(120)', true),
      column('projects', 'created_at', 'timestamp with time zone', true),

      table('todos'),
      column('todos', 'id', 'bigint', true),
      constraint('todos', null, 'primary_key', ['id']),
      column('todos', 'project_id', 'uuid', true),
      constraint('todos', null, 'foreign_key', ['project_id'], {
        schema: 'public',
        table: 'projects',
        columns: ['id'],
      }),
      column('todos', 'title', 'text', true),
      column('todos', 'status', 'public.todo_status', true),
      column('todos', 'due_on', 'date', false),
      column('todos', 'inserted_at', 'timestamp with time zone', true),

      {
        kind: 'index',
        ...present,
        schema: 'public',
        table: 'todos',
        name: 'todos_project_id_idx',
        unique: false,
        method: 'btree',
        columns: ['project_id'],
      },
      {
        kind: 'index',
        ...present,
        schema: 'public',
        table: 'projects',
        name: 'projects_owner_name_key',
        unique: true,
        method: 'btree',
        columns: ['owner_id', '(lower(name))'],
      },
      rls('projects'),
      rls('todos'),
      {
        kind: 'policy',
        ...present,
        schema: 'public',
        table: 'projects',
        name: 'Owners manage their projects',
        command: 'ALL',
        permissive: true,
        roles: ['authenticated'],
        using: '((SELECT auth.uid())) = owner_id',
        withCheck: '((SELECT auth.uid())) = owner_id',
      },

      {
        kind: 'function',
        ...present,
        schema: 'public',
        name: 'handle_new_user',
        argTypes: [],
        isProcedure: false,
      },
      {
        kind: 'trigger',
        ...present,
        schema: 'auth',
        table: 'users',
        name: 'on_auth_user_created',
        timing: 'AFTER',
        events: ['INSERT'],
        forEachRow: true,
        function: { schema: 'public', name: 'handle_new_user' },
      },
      {
        kind: 'policy',
        ...present,
        schema: 'storage',
        table: 'objects',
        name: 'Avatar images are publicly accessible.',
        command: 'SELECT',
        permissive: true,
        roles: ['public'],
        using: "bucket_id = 'avatars'",
        withCheck: null,
      },
    ]);
  });

  it('notes the statements it cannot check, with where they are', () => {
    expect(noteSummaries(result)).toEqual([
      ['unverifiable', 'InsertStmt', 'data change, not a schema object'],
      ['unverifiable', 'AlterPublicationStmt', 'publications are not checked'],
      ['unverifiable', 'GrantStmt', 'privileges are not checked'],
    ]);
    expect(result.notes.map((n) => [n.source.statementIndex, n.source.line])).toEqual([
      [15, 72],
      [17, 77],
      [18, 79],
    ]);
  });

  it('counts every top-level statement', () => {
    expect(result.statementCount).toBe(19);
  });

  it('points each object at the statement that created it', () => {
    const fn = objectAt(result, 'function:public.handle_new_user()').source;
    expect([fn.statementIndex, fn.line]).toEqual([13, 55]);
    expect(fn.excerpt).toMatch(
      /^create or replace function public\.handle_new_user\(\) returns trigger language plpgsql security definer/,
    );
    expect(fn.excerpt.length).toBeLessThanOrEqual(160);
    expect(fn.inDoBlock).toBeUndefined();
  });
});
