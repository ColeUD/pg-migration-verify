import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot, Difference, ExpectedObject } from '../../../src/model.js';
import { compareObject, type Comparison } from '../../../src/verify/compare.js';
import { SnapshotIndex } from '../../../src/verify/snapshot-index.js';
import {
  cat,
  column,
  constraint,
  enumValue,
  extension,
  fn,
  index,
  policy,
  relation,
  rls,
  schemaObj,
  snapshot,
  table,
  trigger,
  type,
} from './builders.js';

interface Case {
  name: string;
  object: ExpectedObject;
  catalog: Partial<CatalogSnapshot>;
  status: Comparison['status'];
  differences?: Difference[];
  notes?: string[];
}

function run(c: Case): void {
  const result = compareObject(c.object, new SnapshotIndex(snapshot(c.catalog)));
  expect(result).toEqual({
    status: c.status,
    differences: c.differences ?? [],
    notes: c.notes ?? [],
  });
}

const d = (attribute: string, expected: string, actual: string): Difference => ({
  attribute,
  expected,
  actual,
});

const todos = { relations: [cat.table('todos')] };

describe('compareObject: schemas, extensions, relations', () => {
  it.each<Case>([
    {
      name: 'schema match',
      object: schemaObj('app'),
      catalog: { coveredSchemas: ['app'], schemas: ['app'] },
      status: 'match',
    },
    {
      name: 'schema missing',
      object: schemaObj('app'),
      catalog: { coveredSchemas: ['app'] },
      status: 'missing',
    },
    {
      name: 'extension match, whatever schema it lives in',
      object: extension('citext', { schema: 'extensions' }),
      catalog: { extensions: [{ name: 'citext', schema: 'extensions' }] },
      status: 'match',
    },
    { name: 'extension missing', object: extension('pg_trgm'), catalog: {}, status: 'missing' },
    { name: 'table match', object: table('todos'), catalog: todos, status: 'match' },
    {
      name: 'partitioned table counts as table',
      object: table('events'),
      catalog: { relations: [cat.table('events', { kind: 'partitioned_table' })] },
      status: 'match',
    },
    { name: 'table missing', object: table('todos'), catalog: {}, status: 'missing' },
    {
      name: 'table found as a view',
      object: table('todos'),
      catalog: { relations: [cat.table('todos', { kind: 'view' })] },
      status: 'different',
      differences: [d('kind', 'table', 'view')],
    },
    {
      name: 'materialized view match',
      object: relation('materialized_view', 'stats'),
      catalog: { relations: [cat.table('stats', { kind: 'materialized_view' })] },
      status: 'match',
    },
    {
      name: 'sequence found as table',
      object: relation('sequence', 'counter'),
      catalog: { relations: [cat.table('counter')] },
      status: 'different',
      differences: [d('kind', 'sequence', 'table')],
    },
    {
      name: 'view missing from another schema',
      object: relation('view', 'report', { schema: 'api' }),
      catalog: { coveredSchemas: ['public', 'api'], relations: [cat.table('report')] },
      status: 'missing',
    },
  ])('$name', run);
});

describe('compareObject: columns', () => {
  const dueDate = cat.column('todos', 'due_date', 'date');
  it.each<Case>([
    {
      name: 'match on type and nullability',
      object: column('todos', 'due_date', { dataType: 'date', notNull: false }),
      catalog: { columns: [dueDate] },
      status: 'match',
    },
    {
      name: 'unasserted attributes are not compared',
      object: column('todos', 'due_date'),
      catalog: { columns: [dueDate] },
      status: 'match',
    },
    {
      name: 'missing',
      object: column('todos', 'due_date', { dataType: 'date' }),
      catalog: { columns: [] },
      status: 'missing',
    },
    {
      name: 'type differs',
      object: column('todos', 'due_date', { dataType: 'timestamp with time zone' }),
      catalog: { columns: [dueDate] },
      status: 'different',
      differences: [d('type', 'timestamp with time zone', 'date')],
    },
    {
      name: 'nullability differs, worded as SQL',
      object: column('todos', 'due_date', { notNull: true }),
      catalog: { columns: [dueDate] },
      status: 'different',
      differences: [d('nullability', 'not null', 'nullable')],
    },
    {
      name: 'both differ',
      object: column('todos', 'title', { dataType: 'text', notNull: false }),
      catalog: {
        columns: [cat.column('todos', 'title', 'character varying(80)', { notNull: true })],
      },
      status: 'different',
      differences: [
        d('type', 'text', 'character varying(80)'),
        d('nullability', 'nullable', 'not null'),
      ],
    },
    {
      name: 'bare user type matches schema-qualified catalog type',
      object: column('todos', 'status', { dataType: 'job_status' }),
      catalog: { columns: [cat.column('todos', 'status', 'public.job_status')] },
      status: 'match',
    },
  ])('$name', run);
});

describe('compareObject: indexes', () => {
  const ownerIdx = cat.index('todos', 'todos_owner_idx', ['owner_id']);
  it.each<Case>([
    {
      name: 'named index match',
      object: index('todos', 'todos_owner_idx', {
        unique: false,
        method: 'btree',
        columns: ['owner_id'],
      }),
      catalog: { indexes: [ownerIdx] },
      status: 'match',
    },
    {
      name: 'named index missing',
      object: index('todos', 'todos_owner_idx', { columns: ['owner_id'] }),
      catalog: {},
      status: 'missing',
    },
    {
      name: 'named index: unique, method and columns differ',
      object: index('todos', 'todos_owner_idx', {
        unique: true,
        method: 'gin',
        columns: ['owner_id', 'done'],
      }),
      catalog: { indexes: [ownerIdx] },
      status: 'different',
      differences: [
        d('unique', 'true', 'false'),
        d('method', 'gin', 'btree'),
        d('columns', '(owner_id, done)', '(owner_id)'),
      ],
    },
    {
      name: 'renamed index whose table the migration did not name',
      object: index('', 'todos_owner_idx'),
      catalog: { indexes: [ownerIdx] },
      status: 'match',
    },
    {
      name: 'named index on another table',
      object: index('todos', 'todos_owner_idx', { columns: ['owner_id'] }),
      catalog: { indexes: [cat.index('projects', 'todos_owner_idx', ['owner_id'])] },
      status: 'different',
      differences: [d('table', 'todos', 'projects')],
    },
    {
      name: 'column order matters',
      object: index('todos', 'todos_pair_idx', { columns: ['a', 'b'] }),
      catalog: { indexes: [cat.index('todos', 'todos_pair_idx', ['b', 'a'])] },
      status: 'different',
      differences: [d('columns', '(a, b)', '(b, a)')],
    },
    {
      name: 'expression columns only need to be expressions on both sides',
      object: index('profiles', 'profiles_email_idx', { columns: ['(lower(email))', 'id'] }),
      catalog: {
        indexes: [cat.index('profiles', 'profiles_email_idx', ['(lower((email)::text))', 'id'])],
      },
      status: 'match',
    },
    {
      name: 'expression expected, plain column found',
      object: index('profiles', 'profiles_email_idx', { columns: ['(lower(email))'] }),
      catalog: { indexes: [cat.index('profiles', 'profiles_email_idx', ['email'])] },
      status: 'different',
      differences: [d('columns', '((lower(email)))', '(email)')],
    },
    {
      name: 'unnamed index matched by table and columns',
      object: index('todos', null, { columns: ['owner_id'] }),
      catalog: { indexes: [cat.index('todos', 'todos_done_idx', ['done']), ownerIdx] },
      status: 'match',
    },
    {
      name: 'unnamed unique index needs a unique candidate',
      object: index('todos', null, { columns: ['owner_id'], unique: true }),
      catalog: {
        indexes: [ownerIdx, cat.index('todos', 'todos_owner_key', ['owner_id'], { unique: true })],
      },
      status: 'match',
    },
    {
      name: 'unnamed index: same columns but not unique is reported against the candidate',
      object: index('todos', null, { columns: ['owner_id'], unique: true }),
      catalog: { indexes: [ownerIdx] },
      status: 'different',
      differences: [d('unique', 'true', 'false')],
    },
    {
      name: 'unnamed index on another table does not count',
      object: index('todos', null, { columns: ['owner_id'] }),
      catalog: { indexes: [cat.index('projects', 'projects_owner_idx', ['owner_id'])] },
      status: 'missing',
    },
  ])('$name', run);
});

describe('compareObject: constraints', () => {
  const fk = cat.constraint('todos', 'todos_owner_fk', 'foreign_key', ['owner_id'], {
    references: { schema: 'public', table: 'profiles', columns: ['id'] },
  });
  const profilesRef = { schema: 'public', table: 'profiles', columns: ['id'] };
  it.each<Case>([
    {
      name: 'named foreign key match',
      object: constraint('todos', 'todos_owner_fk', {
        constraintType: 'foreign_key',
        columns: ['owner_id'],
        references: profilesRef,
      }),
      catalog: { constraints: [fk] },
      status: 'match',
    },
    {
      name: 'named constraint missing',
      object: constraint('todos', 'todos_owner_fk', { constraintType: 'foreign_key' }),
      catalog: {},
      status: 'missing',
    },
    {
      name: 'named constraint: type differs',
      object: constraint('todos', 'todos_owner_fk', { constraintType: 'unique' }),
      catalog: { constraints: [fk] },
      status: 'different',
      differences: [d('constraint type', 'unique', 'foreign key')],
    },
    {
      name: 'named foreign key: referenced table differs',
      object: constraint('todos', 'todos_owner_fk', {
        references: { schema: 'public', table: 'projects', columns: ['id'] },
      }),
      catalog: { constraints: [fk] },
      status: 'different',
      differences: [d('references', 'public.projects (id)', 'public.profiles (id)')],
    },
    {
      name: 'named foreign key: ON DELETE differs',
      object: constraint('todos', 'todos_owner_fk', {
        references: { ...profilesRef, onDelete: 'cascade', onUpdate: 'no_action' },
      }),
      catalog: { constraints: [fk] },
      status: 'different',
      differences: [d('on delete', 'cascade', 'no action')],
    },
    {
      name: 'named foreign key: same actions',
      object: constraint('todos', 'todos_owner_fk', {
        references: { ...profilesRef, onDelete: 'no_action', onUpdate: 'no_action' },
      }),
      catalog: { constraints: [fk] },
      status: 'match',
    },
    {
      name: 'unnamed foreign key: ON UPDATE differs, naming the closest match',
      object: constraint('todos', null, {
        constraintType: 'foreign_key',
        columns: ['owner_id'],
        references: { ...profilesRef, onDelete: 'no_action', onUpdate: 'cascade' },
      }),
      catalog: { constraints: [fk] },
      status: 'different',
      differences: [d('on update', 'cascade', 'no action')],
    },
    {
      // Documented limitation: CHECK expressions are not compared, only the columns they use.
      name: 'check constraint widened by hand still matches',
      object: constraint('items', 'items_price_check', {
        constraintType: 'check',
        columns: ['price'],
      }),
      catalog: {
        constraints: [cat.constraint('items', 'items_price_check', 'check', ['price'])],
      },
      status: 'match',
    },
    {
      name: 'referenced columns are not compared when not asserted',
      object: constraint('todos', 'todos_owner_fk', {
        references: { schema: 'public', table: 'profiles', columns: null },
      }),
      catalog: { constraints: [fk] },
      status: 'match',
    },
    {
      name: 'references asserted but catalog constraint is not a foreign key',
      object: constraint('todos', 'todos_owner_key', { references: profilesRef }),
      catalog: {
        constraints: [cat.constraint('todos', 'todos_owner_key', 'unique', ['owner_id'])],
      },
      status: 'different',
      differences: [d('references', 'public.profiles (id)', 'none')],
    },
    {
      name: 'primary key columns are order-sensitive',
      object: constraint('memberships', 'memberships_pkey', { columns: ['user_id', 'project_id'] }),
      catalog: {
        constraints: [
          cat.constraint('memberships', 'memberships_pkey', 'primary_key', [
            'project_id',
            'user_id',
          ]),
        ],
      },
      status: 'different',
      differences: [d('columns', '(user_id, project_id)', '(project_id, user_id)')],
    },
    {
      name: 'check constraint columns are compared as a set',
      object: constraint('todos', 'todos_dates_check', {
        constraintType: 'check',
        columns: ['due_date', 'created_at'],
      }),
      catalog: {
        constraints: [
          cat.constraint('todos', 'todos_dates_check', 'check', ['created_at', 'due_date']),
        ],
      },
      status: 'match',
    },
    {
      name: 'unnamed constraint matched by type and columns',
      object: constraint('todos', null, {
        constraintType: 'unique',
        columns: ['owner_id', 'title'],
      }),
      catalog: {
        constraints: [
          fk,
          cat.constraint('todos', 'todos_owner_id_title_key', 'unique', ['owner_id', 'title']),
        ],
      },
      status: 'match',
    },
    {
      name: 'unnamed constraint of another type does not count',
      object: constraint('todos', null, { constraintType: 'unique', columns: ['owner_id'] }),
      catalog: { constraints: [fk] },
      status: 'missing',
    },
    {
      name: 'unnamed foreign key matched including references',
      object: constraint('todos', null, {
        constraintType: 'foreign_key',
        columns: ['owner_id'],
        references: profilesRef,
      }),
      catalog: { constraints: [fk] },
      status: 'match',
    },
    {
      name: 'unnamed foreign key with other references is reported against the candidate',
      object: constraint('todos', null, {
        constraintType: 'foreign_key',
        columns: ['owner_id'],
        references: { schema: 'public', table: 'users', columns: ['id'] },
      }),
      catalog: { constraints: [fk] },
      status: 'different',
      differences: [d('references', 'public.users (id)', 'public.profiles (id)')],
    },
  ])('$name', run);
});

describe('compareObject: functions', () => {
  it.each<Case>([
    {
      name: 'match by name and argument types',
      object: fn('set_updated_at', []),
      catalog: { functions: [cat.fn('set_updated_at', [])] },
      status: 'match',
    },
    {
      name: 'bare user type in arguments',
      object: fn('close_job', ['uuid', 'job_status']),
      catalog: { functions: [cat.fn('close_job', ['uuid', 'public.job_status'])] },
      status: 'match',
    },
    {
      name: 'missing with no overloads',
      object: fn('archive_todo', ['uuid']),
      catalog: {},
      status: 'missing',
    },
    {
      name: 'missing, other overloads listed as a hint',
      object: fn('archive_todo', ['uuid']),
      catalog: {
        functions: [
          cat.fn('archive_todo', ['uuid', 'boolean']),
          cat.fn('archive_todo', ['integer']),
        ],
      },
      status: 'missing',
      notes: ['found other signatures: archive_todo(integer), archive_todo(uuid, boolean)'],
    },
    {
      name: 'procedure expected, function found',
      object: fn('refresh_stats', [], { isProcedure: true }),
      catalog: { functions: [cat.fn('refresh_stats', [])] },
      status: 'different',
      differences: [d('kind', 'procedure', 'function')],
    },
    {
      name: 'same name in another schema does not count',
      object: fn('handle_new_user', [], { schema: 'private' }),
      catalog: {
        coveredSchemas: ['public', 'private'],
        functions: [cat.fn('handle_new_user', [])],
      },
      status: 'missing',
    },
  ])('$name', run);
});

describe('compareObject: triggers', () => {
  const expected = trigger('todos', 'todos_updated_at', {
    timing: 'BEFORE',
    events: ['UPDATE'],
    forEachRow: true,
    function: { schema: 'public', name: 'set_updated_at' },
  });
  it.each<Case>([
    {
      name: 'match',
      object: expected,
      catalog: { triggers: [cat.trigger('todos', 'todos_updated_at')] },
      status: 'match',
    },
    { name: 'missing', object: expected, catalog: {}, status: 'missing' },
    {
      name: 'events compared as a set',
      object: trigger('todos', 't', { events: ['UPDATE', 'INSERT'] }),
      catalog: { triggers: [cat.trigger('todos', 't', { events: ['INSERT', 'UPDATE'] })] },
      status: 'match',
    },
    {
      name: 'unqualified function matches any schema',
      object: trigger('todos', 't', { function: { schema: null, name: 'set_updated_at' } }),
      catalog: { triggers: [cat.trigger('todos', 't')] },
      status: 'match',
    },
    {
      name: 'timing, events, level and function differ',
      object: expected,
      catalog: {
        triggers: [
          cat.trigger('todos', 'todos_updated_at', {
            timing: 'AFTER',
            events: ['INSERT', 'UPDATE'],
            forEachRow: false,
            function: { schema: 'private', name: 'set_updated_at' },
          }),
        ],
      },
      status: 'different',
      differences: [
        d('timing', 'BEFORE', 'AFTER'),
        d('events', 'UPDATE', 'INSERT OR UPDATE'),
        d('level', 'row', 'statement'),
        d('function', 'public.set_updated_at', 'private.set_updated_at'),
      ],
    },
  ])('$name', run);
});

describe('compareObject: row level security and policies', () => {
  it.each<Case>([
    {
      name: 'rls enabled match',
      object: rls('todos', { enabled: true }),
      catalog: { relations: [cat.table('todos', { rlsEnabled: true })] },
      status: 'match',
    },
    {
      name: 'rls not enabled',
      object: rls('todos', { enabled: true }),
      catalog: todos,
      status: 'different',
      differences: [d('row level security', 'enabled', 'disabled')],
    },
    {
      name: 'rls forced differs, enabled not asserted',
      object: rls('todos', { forced: true }),
      catalog: todos,
      status: 'different',
      differences: [d('forced', 'forced', 'not forced')],
    },
    {
      name: 'rls on a missing table',
      object: rls('todos', { enabled: true }),
      catalog: {},
      status: 'missing',
    },
    {
      name: 'policy match with roles as a set',
      object: policy('todos', 'owners read', {
        command: 'SELECT',
        permissive: true,
        roles: ['anon', 'authenticated'],
      }),
      catalog: {
        policies: [
          cat.policy('todos', 'owners read', {
            command: 'SELECT',
            roles: ['authenticated', 'anon'],
          }),
        ],
      },
      status: 'match',
    },
    {
      name: 'policy missing',
      object: policy('todos', 'owners read'),
      catalog: {},
      status: 'missing',
    },
    {
      name: 'policy command, mode and roles differ',
      object: policy('todos', 'owners read', {
        command: 'SELECT',
        permissive: false,
        roles: ['authenticated'],
      }),
      catalog: { policies: [cat.policy('todos', 'owners read')] },
      status: 'different',
      differences: [
        d('command', 'SELECT', 'ALL'),
        d('mode', 'restrictive', 'permissive'),
        d('roles', 'authenticated', 'public'),
      ],
    },
  ])('$name', run);
});

describe('compareObject: types and enum values', () => {
  it.each<Case>([
    {
      name: 'enum type match',
      object: type('job_status', { typeKind: 'enum' }),
      catalog: { types: [cat.type('job_status')] },
      status: 'match',
    },
    { name: 'type missing', object: type('job_status'), catalog: {}, status: 'missing' },
    {
      name: 'type kind differs',
      object: type('email', { typeKind: 'domain' }),
      catalog: { types: [cat.type('email', { typeKind: 'composite' })] },
      status: 'different',
      differences: [d('type kind', 'domain', 'composite')],
    },
    {
      name: 'enum value match',
      object: enumValue('job_status', 'done'),
      catalog: { enumValues: [{ schema: 'public', typeName: 'job_status', value: 'done' }] },
      status: 'match',
    },
    {
      name: 'enum value missing',
      object: enumValue('job_status', 'archived'),
      catalog: { enumValues: [{ schema: 'public', typeName: 'job_status', value: 'done' }] },
      status: 'missing',
    },
  ])('$name', run);
});

describe('compareObject: absent expectations', () => {
  it.each<Case>([
    {
      name: 'dropped table is gone',
      object: table('tmp_import', { expect: 'absent' }),
      catalog: {},
      status: 'match',
    },
    {
      name: 'dropped table still exists',
      object: table('tmp_import', { expect: 'absent' }),
      catalog: { relations: [cat.table('tmp_import')] },
      status: 'unexpected',
    },
    {
      name: 'dropped table replaced by a view of the same name is not the table',
      object: table('stats', { expect: 'absent' }),
      catalog: { relations: [cat.table('stats', { kind: 'view' })] },
      status: 'match',
    },
    {
      name: 'dropped column still exists',
      object: column('todos', 'legacy', { expect: 'absent' }),
      catalog: { columns: [cat.column('todos', 'legacy', 'text')] },
      status: 'unexpected',
    },
    {
      name: 'dropped named index is gone',
      object: index('todos', 'todos_old_idx', { expect: 'absent' }),
      catalog: { indexes: [cat.index('todos', 'todos_owner_idx', ['owner_id'])] },
      status: 'match',
    },
    {
      name: 'dropped unnamed constraint still exists',
      object: constraint('todos', null, {
        expect: 'absent',
        constraintType: 'unique',
        columns: ['title'],
      }),
      catalog: { constraints: [cat.constraint('todos', 'todos_title_key', 'unique', ['title'])] },
      status: 'unexpected',
    },
    {
      name: 'DROP FUNCTION without arguments: any overload is unexpected',
      object: fn('archive_todo', null, { expect: 'absent' }),
      catalog: { functions: [cat.fn('archive_todo', ['integer'])] },
      status: 'unexpected',
    },
    {
      name: 'dropped overload gone while another remains',
      object: fn('archive_todo', ['uuid'], { expect: 'absent' }),
      catalog: { functions: [cat.fn('archive_todo', ['integer'])] },
      status: 'match',
    },
    {
      name: 'dropped policy still exists',
      object: policy('todos', 'old policy', { expect: 'absent' }),
      catalog: { policies: [cat.policy('todos', 'old policy')] },
      status: 'unexpected',
    },
    {
      name: 'dropped schema is gone',
      object: schemaObj('legacy', { expect: 'absent' }),
      catalog: { coveredSchemas: ['public', 'legacy'] },
      status: 'match',
    },
    {
      name: 'dropped extension still installed',
      object: extension('pg_trgm', { expect: 'absent' }),
      catalog: { extensions: [{ name: 'pg_trgm', schema: 'public' }] },
      status: 'unexpected',
    },
    {
      name: 'dropped trigger is gone',
      object: trigger('todos', 'old_trigger', { expect: 'absent' }),
      catalog: { triggers: [cat.trigger('todos', 'todos_updated_at')] },
      status: 'match',
    },
    {
      name: 'dropped enum type still exists',
      object: type('job_status', { expect: 'absent' }),
      catalog: { types: [cat.type('job_status')] },
      status: 'unexpected',
    },
  ])('$name', run);
});

describe('compareObject: schema coverage', () => {
  it('throws for an object in a schema the snapshot did not load', () => {
    const catalog = new SnapshotIndex(snapshot());
    expect(() => compareObject(table('notes', { schema: 'private' }), catalog)).toThrow(
      /Schema "private" is not covered/,
    );
  });

  it('does not require coverage for extensions, which are database-wide', () => {
    const catalog = new SnapshotIndex(
      snapshot({ extensions: [{ name: 'citext', schema: 'extensions' }] }),
    );
    expect(compareObject(extension('citext', { schema: 'extensions' }), catalog).status).toBe(
      'match',
    );
  });
});
