import { describe, expect, it } from 'vitest';
import { resolveObjects, type ResolvedObject } from '../../../src/verify/timeline.js';
import {
  column,
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
      reason: `dropped or renamed by ${M2} line 3`,
    },
    {
      name: 'column dropped or renamed later',
      original: column('todos', 'note', { dataType: 'text' }),
      later: [column('todos', 'note', { expect: 'absent', line: 9 })],
      reason: `dropped or renamed by ${M2} line 9`,
    },
    {
      name: 'column of a table dropped later (parent key)',
      original: column('todos', 'title', { dataType: 'text' }),
      later: [table('todos', { expect: 'absent', line: 2 })],
      reason: `table public.todos dropped or renamed by ${M2} line 2`,
    },
    {
      name: 'policy of a renamed table (rename = old name absent)',
      original: policy('todos', 'owners read'),
      later: [table('todos', { expect: 'absent' }), table('tasks')],
      reason: `table public.todos dropped or renamed by ${M2} line 1`,
    },
    {
      name: 'index on a dropped table',
      original: index('todos', null, { columns: ['owner_id'] }),
      later: [table('todos', { expect: 'absent' })],
      reason: `table public.todos dropped or renamed by ${M2} line 1`,
    },
    {
      name: 'trigger on a dropped table',
      original: trigger('todos', 'todos_updated_at'),
      later: [table('todos', { expect: 'absent' })],
      reason: `table public.todos dropped or renamed by ${M2} line 1`,
    },
    {
      name: 'enum value of a dropped type',
      original: enumValue('job_status', 'done'),
      later: [type('job_status', { expect: 'absent', line: 5 })],
      reason: `type public.job_status dropped or renamed by ${M2} line 5`,
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
    expect(resolved?.supersededBy).toEqual({ file: M2, reason });
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
      { object: migrations[1]?.objects[0], notes: [] },
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
    });
  });
});
