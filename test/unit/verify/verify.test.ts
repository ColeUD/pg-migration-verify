import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from '../../../src/model.js';
import {
  requiredSchemas,
  verifyMigrations,
  type MigrationInput,
} from '../../../src/verify/index.js';
import {
  cat,
  column,
  constraint,
  extension,
  fn,
  migration,
  note,
  snapshot,
  table,
  trigger,
} from './builders.js';

function verify(
  migrations: MigrationInput[],
  catalog: CatalogSnapshot,
  recorded: string[] | null = null,
) {
  return verifyMigrations({
    migrations,
    snapshot: catalog,
    recordedVersions: recorded === null ? null : new Set(recorded),
  });
}

describe('verifyMigrations: verdicts and counts', () => {
  const catalog = snapshot({
    relations: [cat.table('todos')],
    columns: [cat.column('todos', 'title', 'text', { notNull: true })],
  });

  it.each([
    {
      name: 'MATCH when every checked object matches',
      objects: [table('todos'), column('todos', 'title', { dataType: 'text', notNull: true })],
      verdict: 'MATCH',
      checked: 2,
      matched: 2,
    },
    {
      name: 'MISMATCH when something is missing',
      objects: [table('todos'), column('todos', 'due_date', { dataType: 'date' })],
      verdict: 'MISMATCH',
      checked: 2,
      matched: 1,
    },
    {
      name: 'MISMATCH when something differs',
      objects: [column('todos', 'title', { notNull: false })],
      verdict: 'MISMATCH',
      checked: 1,
      matched: 0,
    },
    {
      name: 'MISMATCH when a dropped object still exists',
      objects: [table('todos', { expect: 'absent' })],
      verdict: 'MISMATCH',
      checked: 1,
      matched: 0,
    },
    {
      name: 'NOTHING_TO_VERIFY with no objects',
      objects: [],
      verdict: 'NOTHING_TO_VERIFY',
      checked: 0,
      matched: 0,
    },
  ] as const)('$name', ({ objects, verdict, checked, matched }) => {
    const [report] = verify([migration('20240101000000_init.sql', [...objects])], catalog);
    expect(report).toMatchObject({ verdict, checked, matched });
  });

  it('does not count superseded objects, and is NOTHING_TO_VERIFY when all are superseded', () => {
    const reports = verify(
      [
        migration('20240101000000_tmp.sql', [table('tmp_import'), column('tmp_import', 'raw')]),
        migration('20240102000000_drop_tmp.sql', [table('tmp_import', { expect: 'absent' })]),
      ],
      snapshot(),
    );
    expect(reports.map((r) => [r.verdict, r.checked, r.matched])).toEqual([
      ['NOTHING_TO_VERIFY', 0, 0],
      ['MATCH', 1, 1],
    ]);
    expect(reports[0]?.checks.map((c) => c.status)).toEqual(['superseded', 'superseded']);
  });

  it('passes notes through and fills report identity from the file', () => {
    const notes = [note('GrantStmt', 'privileges are not checked', { line: 25 })];
    const [report] = verify(
      [migration('20240101000000_create_todos.sql', [table('todos')], notes)],
      catalog,
    );
    expect(report).toMatchObject({
      file: '20240101000000_create_todos.sql',
      version: '20240101000000',
      name: 'create_todos',
      notes: [{ statementType: 'GrantStmt', source: { file: '20240101000000_create_todos.sql' } }],
    });
  });
});

describe('verifyMigrations: recorded flag', () => {
  const m = [migration('20240101000000_a.sql', []), migration('20240102000000_b.sql', [])];

  it('is true/false per version when history is available', () => {
    expect(verify(m, snapshot(), ['20240101000000']).map((r) => r.recorded)).toEqual([true, false]);
  });

  it('is null when history is unavailable', () => {
    expect(verify(m, snapshot(), null).map((r) => r.recorded)).toEqual([null, null]);
  });
});

describe('verifyMigrations: timeline', () => {
  it('returns reports in version order whatever the input order, using later migrations', () => {
    const reports = verify(
      [
        migration('20240301000000_cleanup.sql', [
          table('tmp_import', { expect: 'absent', line: 3 }),
        ]),
        migration('9_legacy.sql', [table('tmp_import')]),
        migration('20240101000000_init.sql', [table('todos')]),
      ],
      snapshot({ relations: [cat.table('todos')] }),
    );
    expect(reports.map((r) => r.file)).toEqual([
      '9_legacy.sql',
      '20240101000000_init.sql',
      '20240301000000_cleanup.sql',
    ]);
    expect(reports[0]?.checks[0]).toMatchObject({
      status: 'superseded',
      supersededBy: {
        file: '20240301000000_cleanup.sql',
        reason: 'dropped or renamed by 20240301000000_cleanup.sql line 3',
      },
    });
  });

  it('checks an object against its effective (later-altered) expectation', () => {
    const [first] = verify(
      [
        migration('20240101000000_init.sql', [
          column('todos', 'estimate', { dataType: 'integer' }),
        ]),
        migration('20240201000000_widen.sql', [
          column('todos', 'estimate', { dataType: 'bigint', line: 2 }),
        ]),
      ],
      snapshot({ columns: [cat.column('todos', 'estimate', 'bigint')] }),
    );
    expect(first?.checks[0]).toMatchObject({
      status: 'match',
      object: { dataType: 'bigint' },
      notes: ['type updated by 20240201000000_widen.sql line 2'],
    });
  });

  it('combines timeline notes with comparison hints', () => {
    const [first] = verify(
      [
        migration('20240101000000_init.sql', [fn('archive_todo', ['uuid'])]),
        migration('20240201000000_proc.sql', [fn('archive_todo', ['uuid'], { isProcedure: true })]),
      ],
      snapshot({ functions: [cat.fn('archive_todo', ['integer'])] }),
    );
    expect(first?.checks[0]).toMatchObject({
      status: 'missing',
      notes: [
        'kind updated by 20240201000000_proc.sql line 1',
        'found other signatures: archive_todo(integer)',
      ],
    });
  });

  it('reports a dropped-then-recreated object as superseded in the dropping migration', () => {
    const reports = verify(
      [
        migration('20240101000000_drop.sql', [table('todos', { expect: 'absent' })]),
        migration('20240102000000_recreate.sql', [table('todos')]),
      ],
      snapshot({ relations: [cat.table('todos')] }),
    );
    expect(reports.map((r) => r.checks[0]?.status)).toEqual(['superseded', 'match']);
  });

  it('throws when an object lives in a schema the snapshot does not cover', () => {
    expect(() =>
      verify(
        [migration('20240101000000_init.sql', [table('notes', { schema: 'private' })])],
        snapshot(),
      ),
    ).toThrow(/not covered/);
  });
});

describe('requiredSchemas', () => {
  it('collects object, referenced-table and trigger-function schemas, sorted and unique', () => {
    const migrations = [
      migration('20240101000000_a.sql', [
        table('todos'),
        constraint('todos', 'todos_owner_fk', {
          references: { schema: 'auth', table: 'users', columns: ['id'] },
        }),
        extension('citext', { schema: 'extensions' }),
      ]),
      migration('20240102000000_b.sql', [
        table('notes', { schema: 'private' }),
        trigger('todos', 'todos_audit', { function: { schema: 'audit', name: 'log_change' } }),
        trigger('todos', 'todos_touch', { function: { schema: null, name: 'touch' } }),
      ]),
    ];
    expect(requiredSchemas(migrations)).toEqual([
      'audit',
      'auth',
      'extensions',
      'private',
      'public',
    ]);
  });

  it('is empty without objects', () => {
    expect(requiredSchemas([migration('20240101000000_a.sql', [])])).toEqual([]);
  });
});
