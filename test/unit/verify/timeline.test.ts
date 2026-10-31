import { describe, expect, it } from 'vitest';
import { resolveObjects, type ResolvedObject } from '../../../src/verify/timeline.js';
import {
  column,
  constraint,
  enumValue,
  fn,
  index,
  migration,
  policy,
  relation,
  schemaObj,
  table,
  trigger,
  type,
} from './builders.js';
import type { ExpectedObject } from '../../../src/model.js';
import type { MigrationInput } from '../../../src/verify/index.js';

/** Resolve the objects of the first migration against the rest. */
function resolveFirst(...migrations: MigrationInput[]): ResolvedObject[] {
  return resolveObjects(
    migrations.map((m) => m.parsed),
    0,
  );
}

const M1 = '20240101000000_init.sql';
const M2 = '20240201000000_change.sql';
const M3 = '20240301000000_cleanup.sql';

describe('resolveObjects: superseding', () => {
  it.each([
    {
      name: 'dropped by a later migration (same key)',
      original: table('tmp_import', { line: 4 }),
      later: [table('tmp_import', { expect: 'absent', line: 3 })],
      reason: `dropped by ${M2} line 3`,
    },
    {
      name: 'column dropped later',
      original: column('todos', 'note', { dataType: 'text' }),
      later: [column('todos', 'note', { expect: 'absent', line: 9 })],
      reason: `dropped by ${M2} line 9`,
    },
    {
      name: 'column of a table dropped later (parent key)',
      original: column('todos', 'title', { dataType: 'text' }),
      later: [table('todos', { expect: 'absent', line: 2 })],
      reason: `table public.todos dropped by ${M2} line 2`,
    },
    {
      name: 'policy of a dropped table',
      original: policy('todos', 'owners read'),
      later: [table('todos', { expect: 'absent' }), table('tasks')],
      reason: `table public.todos dropped by ${M2} line 1`,
    },
    {
      name: 'index on a dropped table',
      original: index('todos', null, { columns: ['owner_id'] }),
      later: [table('todos', { expect: 'absent' })],
      reason: `table public.todos dropped by ${M2} line 1`,
    },
    {
      name: 'trigger on a dropped table',
      original: trigger('todos', 'todos_updated_at'),
      later: [table('todos', { expect: 'absent' })],
      reason: `table public.todos dropped by ${M2} line 1`,
    },
    {
      name: 'enum value of a dropped type',
      original: enumValue('job_status', 'done'),
      later: [type('job_status', { expect: 'absent', line: 5 })],
      reason: `type public.job_status dropped by ${M2} line 5`,
    },
    {
      name: 'any overload, by DROP FUNCTION without argument list',
      original: fn('archive_todo', ['uuid']),
      later: [fn('archive_todo', null, { expect: 'absent', line: 7 })],
      reason: `dropped by ${M2} line 7`,
    },
    {
      name: 'everything in a dropped schema',
      original: table('notes', { schema: 'legacy' }),
      later: [schemaObj('legacy', { expect: 'absent' })],
      reason: `schema legacy dropped by ${M2} line 1`,
    },
    {
      name: 'absent object re-created later',
      original: policy('todos', 'owners read', { expect: 'absent' }),
      later: [policy('todos', 'owners read', { command: 'SELECT', line: 12 })],
      reason: `re-created by ${M2} line 12`,
    },
    {
      name: 'table replaced by a view of the same name',
      original: table('stats'),
      later: [relation('view', 'stats', { line: 6 })],
      reason: `replaced by view public.stats in ${M2} line 6`,
    },
  ])('$name', ({ original, later, reason }) => {
    const [resolved] = resolveFirst(migration(M1, [original]), migration(M2, later));
    expect(resolved?.supersededBy).toMatchObject({ file: M2, reason });
  });

  it('stops at the first superseding migration', () => {
    const [resolved] = resolveFirst(
      migration(M1, [table('tmp')]),
      migration(M2, [table('tmp', { expect: 'absent' })]),
      migration(M3, [table('tmp', { expect: 'absent' })]),
    );
    expect(resolved?.supersededBy?.file).toBe(M2);
  });

  it.each([
    {
      name: 'a different overload being dropped',
      original: fn('archive_todo', ['uuid']),
      later: [fn('archive_todo', ['integer'], { expect: 'absent' })],
    },
    {
      name: 'a same-named column on another table being dropped',
      original: column('todos', 'title'),
      later: [column('projects', 'title', { expect: 'absent' })],
    },
    {
      name: 'an unrelated table being dropped',
      original: column('todos', 'title'),
      later: [table('projects', { expect: 'absent' })],
    },
    {
      name: 'a later migration that does not mention it',
      original: table('todos'),
      later: [],
    },
  ])('is not superseded by $name', ({ original, later }) => {
    const [resolved] = resolveFirst(migration(M1, [original]), migration(M2, later));
    expect(resolved?.supersededBy).toBeUndefined();
  });

  it('only looks at later migrations', () => {
    const migrations = [
      migration(M1, [table('todos', { expect: 'absent' })]),
      migration(M2, [table('todos')]),
    ].map((m) => m.parsed);
    expect(resolveObjects(migrations, 1)).toEqual([
      { object: migrations[1]?.objects[0], notes: [], earlier: [] },
    ]);
  });
});

describe('resolveObjects: later alterations', () => {
  it('merges non-null attributes from later migrations, later wins, with one note per change', () => {
    const [resolved] = resolveFirst(
      migration(M1, [column('todos', 'estimate', { dataType: 'integer', notNull: false })]),
      migration(M2, [column('todos', 'estimate', { dataType: 'numeric(6,2)', line: 4 })]),
      migration(M3, [
        column('todos', 'estimate', { dataType: 'numeric(8,2)', notNull: true, line: 2 }),
      ]),
    );
    expect(resolved?.supersededBy).toBeUndefined();
    expect(resolved?.object).toMatchObject({
      dataType: 'numeric(8,2)',
      notNull: true,
      source: { file: M1, line: 1 },
    });
    expect(resolved?.notes).toEqual([
      `type updated by ${M2} line 4`,
      `type updated by ${M3} line 2`,
      `nullability updated by ${M3} line 2`,
    ]);
  });

  it('ignores later statements that repeat the current value or assert nothing', () => {
    const [resolved] = resolveFirst(
      migration(M1, [column('todos', 'title', { dataType: 'text', notNull: true })]),
      migration(M2, [column('todos', 'title', { notNull: true }), column('todos', 'title')]),
    );
    expect(resolved?.notes).toEqual([]);
    expect(resolved?.object).toMatchObject({ dataType: 'text', notNull: true });
  });

  it('merges policy roles and expressions, noting only compared attributes', () => {
    const [resolved] = resolveFirst(
      migration(M1, [
        policy('todos', 'read', { command: 'SELECT', roles: ['anon'], using: 'true' }),
      ]),
      migration(M2, [
        policy('todos', 'read', { roles: ['authenticated'], using: '(owner_id = auth.uid())' }),
      ]),
    );
    expect(resolved?.object).toMatchObject({
      command: 'SELECT',
      roles: ['authenticated'],
      using: '(owner_id = auth.uid())',
    });
    expect(resolved?.notes).toEqual([`roles updated by ${M2} line 1`]);
  });

  it('keeps merge notes when the object is superseded afterwards', () => {
    const [resolved] = resolveFirst(
      migration(M1, [column('todos', 'estimate', { dataType: 'integer' })]),
      migration(M2, [column('todos', 'estimate', { dataType: 'bigint' })]),
      migration(M3, [table('todos', { expect: 'absent' })]),
    );
    expect(resolved?.notes).toEqual([`type updated by ${M2} line 1`]);
    expect(resolved?.supersededBy?.file).toBe(M3);
  });

  it('does not merge into an absent expectation', () => {
    const original = column('todos', 'legacy', { expect: 'absent' });
    const [resolved] = resolveFirst(
      migration(M1, [original]),
      migration(M2, [column('todos', 'other', { dataType: 'text' })]),
    );
    expect(resolved).toEqual({
      object: { ...original, source: { ...original.source, file: M1 } },
      notes: [],
      earlier: [],
    });
  });
});

/** The statement that dropped the earlier object, as NetEffect records it on the re-created one. */
const DROP_STATEMENT = { file: M2, statementIndex: 0, line: 1, excerpt: 'drop table settings' };

describe('resolveObjects: dropped and re-created by a later migration', () => {
  it.each([
    {
      name: 'a column the rebuilt table leaves out',
      original: column('settings', 'beta', { dataType: 'boolean' }),
      later: [{ ...table('settings', { line: 2 }), recreated: DROP_STATEMENT }],
      reason: `table public.settings dropped and re-created by ${M2} line 2`,
    },
    {
      name: 'a policy on the rebuilt table',
      original: policy('settings', 'read settings', { command: 'SELECT' }),
      later: [{ ...table('settings', { line: 2 }), recreated: DROP_STATEMENT }],
      reason: `table public.settings dropped and re-created by ${M2} line 2`,
    },
    {
      name: 'an enum value the rebuilt type leaves out',
      original: enumValue('task_status', 'blocked'),
      later: [
        { ...type('task_status', { typeKind: 'enum', line: 2 }), recreated: DROP_STATEMENT },
        type('task_status_old', { expect: 'absent', line: 4 }),
      ],
      reason: `enum type public.task_status dropped and re-created by ${M2} line 2`,
    },
    {
      name: 'the re-created object itself',
      original: table('settings'),
      later: [{ ...table('settings', { line: 2 }), recreated: DROP_STATEMENT }],
      reason: `dropped and re-created by ${M2} line 2`,
    },
    {
      name: 'an object in a re-created schema',
      original: table('notes', { schema: 'legacy' }),
      later: [{ ...schemaObj('legacy', { line: 2 }), recreated: DROP_STATEMENT }],
      reason: `schema legacy dropped and re-created by ${M2} line 2`,
    },
  ])('supersedes $name', ({ original, later, reason }) => {
    const [resolved] = resolveFirst(migration(M1, [original]), migration(M2, later));
    expect(resolved?.supersededBy).toMatchObject({ file: M2, reason });
  });

  it('supersedes a child the rebuild declares again; the later file checks that one', () => {
    const migrations = [
      migration(M1, [column('settings', 'id', { dataType: 'integer', notNull: true })]),
      migration(M2, [
        { ...table('settings'), recreated: DROP_STATEMENT },
        column('settings', 'id', { dataType: 'bigint', notNull: true }),
      ]),
    ].map((m) => m.parsed);
    expect(resolveObjects(migrations, 0)[0]?.supersededBy?.reason).toBe(
      `table public.settings dropped and re-created by ${M2} line 1`,
    );
    expect(resolveObjects(migrations, 1).map((r) => r.supersededBy)).toEqual([
      undefined,
      undefined,
    ]);
  });

  it('still reports an absent object re-created later as re-created', () => {
    const [resolved] = resolveFirst(
      migration(M1, [table('settings', { expect: 'absent' })]),
      migration(M2, [{ ...table('settings', { line: 3 }), recreated: DROP_STATEMENT }]),
    );
    expect(resolved?.supersededBy?.reason).toBe(`re-created by ${M2} line 3`);
  });

  it('is not superseded by a plain (not re-created) declaration of the parent', () => {
    const [resolved] = resolveFirst(
      migration(M1, [column('settings', 'beta', { dataType: 'boolean' })]),
      migration(M2, [table('settings')]),
    );
    expect(resolved?.supersededBy).toBeUndefined();
  });
});

describe('resolveObjects: drops by the name Postgres generated', () => {
  function unnamed<T extends ExpectedObject>(o: T, impliedName: string): T {
    return { ...o, impliedName };
  }
  const usernameKey = unnamed(
    constraint('profiles', null, { constraintType: 'unique', columns: ['username'] }),
    'profiles_username_key',
  );

  it.each([
    {
      name: 'unique constraint',
      original: usernameKey,
      later: constraint('profiles', 'profiles_username_key', { expect: 'absent', line: 2 }),
    },
    {
      name: 'check constraint',
      original: unnamed(
        constraint('profiles', null, { constraintType: 'check', columns: ['age'] }),
        'profiles_age_check',
      ),
      later: constraint('profiles', 'profiles_age_check', { expect: 'absent', line: 2 }),
    },
    {
      name: 'index (DROP INDEX does not name the table)',
      original: unnamed(index('profiles', null, { columns: ['email'] }), 'profiles_email_idx'),
      later: index('', 'profiles_email_idx', { expect: 'absent', line: 2 }),
    },
  ])('supersedes an unnamed $name', ({ original, later }) => {
    const [resolved] = resolveFirst(migration(M1, [original]), migration(M2, [later]));
    expect(resolved?.supersededBy).toEqual({
      file: M2,
      line: 2,
      reason: `dropped by ${M2} line 2`,
      byKey: later.key,
    });
  });

  it.each([
    {
      name: 'a constraint of that name on another table',
      later: constraint('accounts', 'profiles_username_key', { expect: 'absent' }),
    },
    {
      name: 'a constraint with a collision suffix',
      later: constraint('profiles', 'profiles_username_key1', { expect: 'absent' }),
    },
    {
      name: 'an index of that name',
      later: index('', 'profiles_username_key', { expect: 'absent' }),
    },
  ])('is not superseded by $name', ({ later }) => {
    const [resolved] = resolveFirst(migration(M1, [usernameKey]), migration(M2, [later]));
    expect(resolved?.supersededBy).toBeUndefined();
  });
});

describe('resolveObjects: IF NOT EXISTS', () => {
  function ifNotExists<T extends ExpectedObject>(o: T, guard: string = o.key): T {
    return { ...o, conditional: guard };
  }
  const ine = table('ine');

  it('does not merge a later re-declaration that Postgres skipped', () => {
    const [, a] = resolveFirst(
      migration(M1, [ine, column('ine', 'a', { dataType: 'integer', notNull: true })]),
      migration(M2, [
        ifNotExists(ine),
        ifNotExists(column('ine', 'a', { dataType: 'bigint', notNull: false }), ine.key),
      ]),
      migration(M3, [ifNotExists(column('ine', 'a', { dataType: 'text' }))]),
    );
    expect(a?.notes).toEqual([]);
    expect(a?.object).toMatchObject({ dataType: 'integer', notNull: true });
  });

  it('still merges a definite ALTER (control)', () => {
    const [, a] = resolveFirst(
      migration(M1, [ine, column('ine', 'a', { dataType: 'integer' })]),
      migration(M2, [column('ine', 'a', { dataType: 'bigint' })]),
    );
    expect(a?.object).toMatchObject({ dataType: 'bigint' });
    expect(a?.notes).toEqual([`type updated by ${M2} line 1`]);
  });

  it('checks only the existence of what an earlier migration created, and skips the rest', () => {
    const migrations = [
      migration(M1, [ine, column('ine', 'a', { dataType: 'integer', notNull: true })]),
      migration(M2, [
        ifNotExists(table('ine', { line: 3 })),
        ifNotExists(column('ine', 'a', { dataType: 'bigint' }), ine.key),
        ifNotExists(column('ine', 'extra', { dataType: 'text' }), ine.key),
        ifNotExists(column('other', 'a', { dataType: 'text', notNull: false })),
      ]),
    ].map((m) => m.parsed);
    const [created, a, extra, other] = resolveObjects(migrations, 1);
    expect(created?.supersededBy).toBeUndefined();
    expect(created?.notes).toEqual([
      `IF NOT EXISTS: already created by ${M1} line 1, so only its existence is checked`,
    ]);
    const skipped = {
      file: M1,
      line: 1,
      byKey: ine.key,
      reason: `skipped by IF NOT EXISTS: table public.ine already created by ${M1} line 1`,
    };
    expect(a?.supersededBy).toEqual(skipped);
    expect(extra?.supersededBy).toEqual(skipped);
    // Nothing earlier created public.other.a: it is checked as declared.
    expect(other).toEqual({ object: migrations[1]?.objects[3], notes: [], earlier: [] });
  });

  it('checks an ADD COLUMN IF NOT EXISTS of an existing column for existence only', () => {
    const migrations = [
      migration(M1, [column('ine', 'a', { dataType: 'integer', notNull: true })]),
      migration(M2, [ifNotExists(column('ine', 'a', { dataType: 'text', notNull: false }))]),
    ].map((m) => m.parsed);
    const [a] = resolveObjects(migrations, 1);
    expect(a?.supersededBy).toBeUndefined();
    expect(a?.object).toMatchObject({ dataType: null, notNull: null });
  });

  it.each([
    { name: 'dropped in between', between: [table('ine', { expect: 'absent' })] },
    { name: 'dropped as a column in between', between: [column('ine', 'a', { expect: 'absent' })] },
  ])('runs as declared when the object was $name', ({ between }) => {
    const migrations = [
      migration(M1, [ine, column('ine', 'a', { dataType: 'integer' })]),
      migration(M2, between),
      migration(M3, [ifNotExists(column('ine', 'a', { dataType: 'text' }))]),
    ].map((m) => m.parsed);
    expect(resolveObjects(migrations, 2)).toEqual([
      { object: migrations[2]?.objects[0], notes: [], earlier: [] },
    ]);
  });
});
