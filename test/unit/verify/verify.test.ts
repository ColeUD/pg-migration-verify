import { describe, expect, it } from 'vitest';
import type { CatalogSnapshot } from '../../../src/model.js';
import {
  formatSummary,
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
  index,
  migration,
  note,
  rls,
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
  it('returns reports in apply order whatever the input order, using later migrations', () => {
    const reports = verify(
      [
        migration('20240301000000_cleanup.sql', [
          table('tmp_import', { expect: 'absent', line: 3 }),
        ]),
        migration('0009_legacy.sql', [table('tmp_import')]),
        migration('20240101000000_init.sql', [table('todos')]),
      ],
      snapshot({ relations: [cat.table('todos')] }),
    );
    expect(reports.map((r) => r.file)).toEqual([
      '0009_legacy.sql',
      '20240101000000_init.sql',
      '20240301000000_cleanup.sql',
    ]);
    expect(reports[0]?.checks[0]).toMatchObject({
      status: 'superseded',
      supersededBy: {
        file: '20240301000000_cleanup.sql',
        reason: 'dropped by 20240301000000_cleanup.sql line 3',
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

  it('applies migrations in file-name order, as the Supabase CLI does: 10_ before 2_', () => {
    const migrations = [
      migration('2_drop_x.sql', [table('x', { expect: 'absent' })]),
      migration('10_create_x.sql', [table('x')]),
    ];
    // The CLI ran 10_create_x.sql, then 2_drop_x.sql: x is gone.
    const reports = verify(migrations, snapshot());
    expect(reports.map((r) => [r.file, r.verdict])).toEqual([
      ['10_create_x.sql', 'NOTHING_TO_VERIFY'],
      ['2_drop_x.sql', 'MATCH'],
    ]);
    expect(reports[0]?.checks[0]).toMatchObject({
      status: 'superseded',
      supersededBy: { file: '2_drop_x.sql' },
    });
    // Had x survived, the drop is what failed.
    const kept = verify(migrations, snapshot({ relations: [cat.table('x')] }));
    expect(kept.map((r) => r.verdict)).toEqual(['NOTHING_TO_VERIFY', 'MISMATCH']);
  });

  it('returns only the report asked for, the same as in a full run', () => {
    const migrations = [
      migration('20240101000000_init.sql', [column('todos', 'estimate', { dataType: 'integer' })]),
      migration('20240201000000_widen.sql', [column('todos', 'estimate', { dataType: 'bigint' })]),
    ];
    const catalog = snapshot({ columns: [cat.column('todos', 'estimate', 'bigint')] });
    const all = verify(migrations, catalog);
    const only = verifyMigrations({
      migrations,
      snapshot: catalog,
      recordedVersions: null,
      only: '20240101000000_init.sql',
    });
    expect(only).toEqual([all[0]]);
  });
});

describe('verifyMigrations: a later change that is not in the database', () => {
  const INIT = '20240101000000_init.sql';
  const WIDEN = '20240201000000_widen.sql';
  const DECIMAL = '20240301000000_decimal.sql';
  const migrations = [
    migration(INIT, [column('big', 'n', { dataType: 'integer', notNull: true })]),
    migration(WIDEN, [column('big', 'n', { dataType: 'bigint', line: 2 })]),
    migration(DECIMAL, [column('big', 'n', { dataType: 'numeric', line: 3 })]),
  ];
  const holding = (dataType: string) =>
    snapshot({ columns: [cat.column('big', 'n', dataType, { notNull: true })] });

  it('matches the earlier migration as it was, and reports the change on the later one', () => {
    const reports = verify(migrations.slice(0, 2), holding('integer'), ['20240101000000']);
    expect(reports[0]).toMatchObject({ verdict: 'MATCH', matched: 1, checked: 1 });
    expect(reports[0]?.checks[0]).toMatchObject({
      status: 'match',
      object: { dataType: 'integer' },
      notes: [
        `matches its state before ${WIDEN}, whose change is not in the database (reported on that migration)`,
      ],
    });
    expect(reports[1]?.checks[0]).toMatchObject({
      status: 'different',
      differences: [{ attribute: 'type', expected: 'bigint', actual: 'integer' }],
    });
    expect(formatSummary(reports)).not.toContain('recorded in history but MISMATCH');
  });

  it('falls back to the newest state the database holds', () => {
    const reports = verify(migrations, holding('bigint'));
    expect(reports.map((r) => r.verdict)).toEqual(['MATCH', 'MATCH', 'MISMATCH']);
    expect(reports[0]?.checks[0]?.notes).toEqual([
      `type updated by ${WIDEN} line 2`,
      `matches its state before ${DECIMAL}, whose change is not in the database (reported on that migration)`,
    ]);
  });

  it('stays DIFFERENT, against the final expectation, when no state matches', () => {
    const [first] = verify(migrations, holding('text'));
    expect(first?.checks[0]).toMatchObject({
      status: 'different',
      differences: [{ attribute: 'type', expected: 'numeric', actual: 'text' }],
    });
  });

  it('matches the old name of an object a later migration renames but did not run', () => {
    const renames = [
      migration('20240101000000_init.sql', [column('t', 'a', { dataType: 'integer' })]),
      migration(
        '20240201000000_rename.sql',
        [column('t', 'a', { expect: 'absent' }), column('t', 'b')],
        [],
        [
          {
            from: column('t', 'a', { expect: 'absent' }),
            to: column('t', 'b'),
            searchSchema: 'public',
          },
        ],
      ),
    ];
    const reports = verify(renames, snapshot({ columns: [cat.column('t', 'a', 'integer')] }));
    expect(reports.map((r) => r.verdict)).toEqual(['MATCH', 'MISMATCH']);
    expect(reports[0]?.checks[0]?.object.key).toBe('column:public.t.a');
  });

  it('does not excuse a missing object by an attribute change', () => {
    const reports = verify(migrations.slice(0, 2), snapshot());
    expect(reports[0]?.checks[0]?.status).toBe('missing');
  });
});

describe('verifyMigrations: scale', () => {
  /**
   * Many migrations shaped like a real project: each creates a table with columns, an index, a
   * foreign key to the previous table and RLS, alters the previous table, and every tenth drops
   * an older table. Resolving visits only the later migrations that touch an object.
   */
  function project(count: number): MigrationInput[] {
    return Array.from({ length: count }, (_, i) => {
      const name = `t${i}`;
      const objects = [
        table(name),
        ...Array.from({ length: 10 }, (_, c) =>
          column(name, `c${c}`, { dataType: 'integer', notNull: c === 0 }),
        ),
        constraint(name, null, { constraintType: 'primary_key', columns: ['c0'] }),
        index(name, `${name}_c1_idx`, { columns: ['c1'] }),
        constraint(name, null, {
          constraintType: 'foreign_key',
          columns: ['c2'],
          references: { schema: 'public', table: `t${Math.max(i - 1, 0)}`, columns: ['c0'] },
        }),
        rls(name, { enabled: true }),
        ...(i > 0 ? [column(`t${i - 1}`, 'c3', { notNull: true })] : []),
        ...(i % 10 === 9 ? [table(`t${i - 5}`, { expect: 'absent' })] : []),
      ];
      return migration(`${String(i).padStart(14, '0')}_m.sql`, objects);
    });
  }

  /** Best of five runs, in milliseconds, which keeps scheduling noise out of the ratio. */
  function timeVerify(count: number): number {
    const migrations = project(count);
    let best = Infinity;
    for (let run = 0; run < 5; run += 1) {
      const started = performance.now();
      verify(migrations, snapshot());
      best = Math.min(best, performance.now() - started);
    }
    return best;
  }

  it('grows about linearly with the number of objects', () => {
    timeVerify(100); // warm up
    const small = timeVerify(500);
    const large = timeVerify(2000);
    // Quadratic resolution would take about 16 times as long; allow plenty of noise.
    expect(large / small).toBeLessThan(10);
    expect(large).toBeLessThan(5_000);
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
