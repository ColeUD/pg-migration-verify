import { describe, expect, it } from 'vitest';
import type { ExpectedObject, MigrationReport } from '../../../src/model.js';
import { describeExpected } from '../../../src/verify/describe.js';
import {
  formatExpectedObjects,
  formatMigrationReport,
  formatSummary,
  verifyMigrations,
} from '../../../src/verify/index.js';
import {
  cat,
  column,
  constraint,
  fn,
  index,
  migration,
  note,
  policy,
  rls,
  snapshot,
  table,
  trigger,
  type,
} from './builders.js';

/**
 * A small project history covering every report line kind:
 * - create_todos: all good, one table dropped later (superseded), a GRANT and a BEGIN.
 * - add_todos_extras: recorded in history but broken in four ways.
 * - cleanup: applied but NOT recorded in history (run by hand in the SQL editor); the new column
 *   shows that it ran, which the drop alone could not.
 * - seed: data only, nothing to verify.
 */
const migrations = [
  migration(
    '20240101000000_create_todos.sql',
    [
      table('todos', { line: 1 }),
      column('todos', 'id', { dataType: 'uuid', notNull: true, line: 2 }),
      column('todos', 'title', { dataType: 'text', notNull: true, line: 3 }),
      table('tmp_import', { line: 10 }),
      policy('todos', 'owners read', { command: 'SELECT', roles: ['authenticated'], line: 14 }),
    ],
    [
      note('GrantStmt', 'privileges are not checked', { line: 20 }),
      note('TransactionStmt', 'transaction control has no schema effect', {
        category: 'ignored',
        line: 1,
      }),
    ],
  ),
  migration(
    '20240102000000_add_todos_extras.sql',
    [
      column('todos', 'due_date', { dataType: 'date', notNull: false, line: 7 }),
      index('todos', 'todos_owner_idx', { unique: true, columns: ['owner_id'], line: 12 }),
      policy('todos', 'old policy', { expect: 'absent', line: 20 }),
      fn('archive_todo', ['uuid'], { line: 25 }),
      rls('todos', { enabled: true, line: 30, inDoBlock: true }),
    ],
    [note('GrantStmt', 'privileges are not checked', { line: 32 })],
  ),
  migration('20240301000000_cleanup.sql', [
    table('tmp_import', { expect: 'absent', line: 3 }),
    column('todos', 'done', { dataType: 'boolean', line: 5 }),
  ]),
  migration(
    '20240302000000_seed.sql',
    [],
    [note('InsertStmt', 'data changes are not schema changes', { category: 'ignored', line: 1 })],
  ),
];

const catalog = snapshot({
  relations: [cat.table('todos', { rlsEnabled: true })],
  columns: [
    cat.column('todos', 'id', 'uuid', { notNull: true }),
    cat.column('todos', 'title', 'text', { notNull: true }),
    cat.column('todos', 'done', 'boolean'),
  ],
  indexes: [cat.index('todos', 'todos_owner_idx', ['owner_id'])],
  policies: [
    cat.policy('todos', 'owners read', { command: 'SELECT', roles: ['authenticated'] }),
    cat.policy('todos', 'old policy'),
  ],
  functions: [cat.fn('archive_todo', ['integer'])],
});

const reports = verifyMigrations({
  migrations,
  snapshot: catalog,
  recordedVersions: new Set(['20240101000000', '20240102000000']),
});

function report(version: string): MigrationReport {
  const found = reports.find((r) => r.version === version);
  if (found === undefined) throw new Error(`no report for ${version}`);
  return found;
}

const lines = (...l: string[]): string => l.join('\n');

describe('formatMigrationReport', () => {
  it('lists problems first, then superseded and unverifiable, with hints under their line', () => {
    expect(formatMigrationReport(report('20240102000000'))).toBe(
      lines(
        'MISMATCH 1/5  20240102000000_add_todos_extras.sql',
        '  MISSING      line 7   column public.todos.due_date (date, nullable)',
        '  MISSING      line 25  function public.archive_todo(uuid)',
        '                        note: found other signatures: archive_todo(integer)',
        '  DIFFERENT    line 12  index public.todos_owner_idx: unique expected true, found false',
        '  UNEXPECTED   line 20  policy "old policy" on public.todos: dropped or renamed here, but still exists',
        '  UNVERIFIABLE line 32  GrantStmt: privileges are not checked',
        '  history: recorded',
      ),
    );
  });

  it('adds matches and DO-block markers in verbose mode', () => {
    expect(formatMigrationReport(report('20240102000000'), { verbose: true })).toBe(
      lines(
        'MISMATCH 1/5  20240102000000_add_todos_extras.sql',
        '  MISSING      line 7   column public.todos.due_date (date, nullable)',
        '  MISSING      line 25  function public.archive_todo(uuid)',
        '                        note: found other signatures: archive_todo(integer)',
        '  DIFFERENT    line 12  index public.todos_owner_idx: unique expected true, found false',
        '  UNEXPECTED   line 20  policy "old policy" on public.todos: dropped or renamed here, but still exists',
        '  UNVERIFIABLE line 32  GrantStmt: privileges are not checked',
        '  MATCH        line 30  row level security on public.todos [inside DO block]',
        '  history: recorded',
      ),
    );
  });

  it('keeps a matching migration short, naming the history table when given', () => {
    expect(
      formatMigrationReport(report('20240101000000'), {
        historyTable: 'supabase_migrations.schema_migrations',
      }),
    ).toBe(
      lines(
        'MATCH 4/4  20240101000000_create_todos.sql',
        '  SUPERSEDED   line 10  table public.tmp_import: dropped by 20240301000000_cleanup.sql line 3',
        '  UNVERIFIABLE line 20  GrantStmt: privileges are not checked',
        '  history: recorded in supabase_migrations.schema_migrations',
      ),
    );
  });

  it('shows matches and ignored statements in verbose mode, in file order within each group', () => {
    expect(formatMigrationReport(report('20240101000000'), { verbose: true })).toBe(
      lines(
        'MATCH 4/4  20240101000000_create_todos.sql',
        '  SUPERSEDED   line 10  table public.tmp_import: dropped by 20240301000000_cleanup.sql line 3',
        '  UNVERIFIABLE line 20  GrantStmt: privileges are not checked',
        '  MATCH        line 1   table public.todos',
        '  MATCH        line 2   column public.todos.id',
        '  MATCH        line 3   column public.todos.title',
        '  MATCH        line 14  policy "owners read" on public.todos',
        '  IGNORED      line 1   TransactionStmt: transaction control has no schema effect',
        '  history: recorded',
      ),
    );
  });

  it('formats a fully matching, unrecorded migration in two lines', () => {
    expect(formatMigrationReport(report('20240301000000'))).toBe(
      lines('MATCH 2/2  20240301000000_cleanup.sql', '  history: NOT recorded'),
    );
  });

  it('says that a matching drop is gone, so verbose output cannot read as "it exists"', () => {
    expect(formatMigrationReport(report('20240301000000'), { verbose: true })).toBe(
      lines(
        'MATCH 2/2  20240301000000_cleanup.sql',
        '  MATCH line 3  table public.tmp_import: dropped or renamed here, and no longer exists',
        '  MATCH line 5  column public.todos.done',
        '  history: NOT recorded',
      ),
    );
  });

  it('formats a migration with nothing to verify', () => {
    expect(formatMigrationReport(report('20240302000000'))).toBe(
      lines('NOTHING TO VERIFY  20240302000000_seed.sql', '  history: NOT recorded'),
    );
  });

  it('says when history is unavailable', () => {
    expect(formatMigrationReport({ ...report('20240301000000'), recorded: null })).toBe(
      lines('MATCH 2/2  20240301000000_cleanup.sql', '  history: unavailable'),
    );
  });

  it('joins several differences of one object', () => {
    const [r] = verifyMigrations({
      migrations: [
        migration('20240101000000_init.sql', [
          column('todos', 'title', { dataType: 'text', notNull: true, line: 4 }),
        ]),
      ],
      snapshot: snapshot({ columns: [cat.column('todos', 'title', 'character varying(80)')] }),
      recordedVersions: null,
    });
    expect(formatMigrationReport(r!)).toBe(
      lines(
        'MISMATCH 0/1  20240101000000_init.sql',
        '  DIFFERENT line 4  column public.todos.title: type expected text, found character varying(80); nullability expected not null, found nullable',
        '  history: unavailable',
      ),
    );
  });
});

describe('formatMigrationReport: superseded objects', () => {
  const DROP = '20240201000000_drop.sql';
  const [created, extended] = verifyMigrations({
    migrations: [
      migration('20240101000000_events.sql', [
        table('events', { line: 3 }),
        column('events', 'id', { dataType: 'integer', line: 3 }),
        column('events', 'kind', { dataType: 'text', line: 3 }),
        constraint('events', null, { constraintType: 'primary_key', columns: ['id'], line: 3 }),
        index('events', 'events_kind_idx', { columns: ['kind'], line: 9 }),
        policy('events', 'read events', { line: 11 }),
      ]),
      migration('20240102000000_events_more.sql', [
        column('events', 'payload', { dataType: 'jsonb', line: 1 }),
        column('events', 'at', { dataType: 'timestamptz', line: 2 }),
      ]),
      migration(DROP, [table('events', { expect: 'absent', line: 4 })]),
    ],
    snapshot: snapshot(),
    recordedVersions: null,
  });

  it('shows a dropped table once, counting what went with it', () => {
    expect(formatMigrationReport(created!)).toBe(
      lines(
        'NOTHING TO VERIFY  20240101000000_events.sql',
        `  SUPERSEDED line 3  table public.events (and 2 columns, 1 index, 1 constraint, 1 policy): dropped by ${DROP} line 4`,
        '  history: unavailable',
      ),
    );
  });

  it('lists objects one by one when what superseded them is not in the report', () => {
    expect(formatMigrationReport(extended!)).toBe(
      lines(
        'NOTHING TO VERIFY  20240102000000_events_more.sql',
        `  SUPERSEDED line 1  column public.events.payload: table public.events dropped by ${DROP} line 4`,
        `  SUPERSEDED line 2  column public.events.at: table public.events dropped by ${DROP} line 4`,
        '  history: unavailable',
      ),
    );
  });

  it('lists every superseded object in verbose mode', () => {
    expect(formatMigrationReport(created!, { verbose: true }).split('\n')).toHaveLength(8);
  });

  it('keeps the cause of each superseded check, for grouping by clients', () => {
    expect(created?.checks.map((c) => (c.status === 'superseded' ? c.supersededBy : null))).toEqual(
      Array(6).fill({
        file: DROP,
        line: 4,
        reason: expect.stringContaining(`dropped by ${DROP} line 4`) as string,
        byKey: 'relation:public.events',
      }),
    );
  });
});

describe('formatSummary', () => {
  it('renders an aligned table and totals calling out unrecorded and recorded-but-broken migrations', () => {
    expect(formatSummary(reports)).toBe(
      lines(
        'VERSION         NAME              RESULT             MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240101000000  create_todos      MATCH              4/4      1           1             recorded',
        '20240102000000  add_todos_extras  MISMATCH           1/5      0           1             recorded',
        '20240301000000  cleanup           MATCH              2/2      0           0             NOT RECORDED',
        '20240302000000  seed              NOTHING TO VERIFY  -        0           0             NOT RECORDED',
        '',
        '4 migrations: 2 MATCH, 1 MISMATCH, 1 nothing to verify. 1 applied but NOT recorded in history.',
        '1 recorded in history but MISMATCH: 20240102000000_add_todos_extras.sql',
      ),
    );
  });

  it('notes unavailable history and uses the singular for one migration', () => {
    expect(formatSummary([{ ...report('20240301000000'), recorded: null }])).toBe(
      lines(
        'VERSION         NAME     RESULT  MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240301000000  cleanup  MATCH   2/2      0           0             -',
        '',
        '1 migration: 1 MATCH, 0 MISMATCH, 0 nothing to verify. History unavailable.',
      ),
    );
  });

  it('handles an empty migration list', () => {
    expect(formatSummary([])).toBe('No migrations.');
  });
});

describe('formatExpectedObjects', () => {
  it('groups objects by kind in dependency order, then lists notes', () => {
    expect(formatExpectedObjects(migrations[1]!.parsed)).toBe(
      lines(
        '20240102000000_add_todos_extras.sql: 6 statements, 5 expected objects, 1 note',
        '',
        'Columns (1)',
        '  present      line 7   column public.todos.due_date (date, nullable)',
        '',
        'Indexes (1)',
        '  present      line 12  index public.todos_owner_idx (on public.todos (owner_id), unique)',
        '',
        'Functions (1)',
        '  present      line 25  function public.archive_todo(uuid)',
        '',
        'Row level security (1)',
        '  present      line 30  row level security on public.todos (enabled) [inside DO block]',
        '',
        'Policies (1)',
        '  absent       line 20  policy "old policy" on public.todos',
        '',
        'Notes (1)',
        '  unverifiable line 32  GrantStmt: privileges are not checked',
      ),
    );
  });

  it('sorts objects of one kind by line and handles an empty migration', () => {
    const parsed = migration('20240101000000_init.sql', [
      table('todos', { line: 9 }),
      table('projects', { line: 2 }),
    ]).parsed;
    expect(formatExpectedObjects(parsed)).toBe(
      lines(
        '20240101000000_init.sql: 2 statements, 2 expected objects, 0 notes',
        '',
        'Tables (2)',
        '  present line 2  table public.projects',
        '  present line 9  table public.todos',
      ),
    );
    expect(formatExpectedObjects(migration('20240101000000_empty.sql', []).parsed)).toBe(
      '20240101000000_empty.sql: 0 statements, 0 expected objects, 0 notes',
    );
  });
});

describe('describeExpected', () => {
  const cases: [ExpectedObject, string][] = [
    [column('todos', 'title'), 'column public.todos.title'],
    [column('todos', 'title', { dataType: 'text' }), 'column public.todos.title (text)'],
    [column('todos', 'title', { notNull: true }), 'column public.todos.title (not null)'],
    [
      index('todos', null, { columns: ['owner_id'], unique: true, method: 'gin' }),
      'index on public.todos (owner_id) (unique, using gin)',
    ],
    [index('todos', 'todos_owner_idx'), 'index public.todos_owner_idx (on public.todos)'],
    [index('', 'todos_name_idx'), 'index public.todos_name_idx'],
    [
      constraint('todos', 'todos_owner_fk', {
        constraintType: 'foreign_key',
        columns: ['owner_id'],
        references: { schema: 'public', table: 'profiles', columns: ['id'] },
      }),
      'constraint todos_owner_fk on public.todos (foreign key (owner_id), references public.profiles (id))',
    ],
    [
      constraint('todos', null, {
        constraintType: 'foreign_key',
        columns: ['owner_id'],
        references: {
          schema: 'public',
          table: 'profiles',
          columns: ['id'],
          onDelete: 'set_null',
          onUpdate: 'no_action',
        },
      }),
      'foreign key on public.todos (owner_id) (references public.profiles (id), on delete set null)',
    ],
    [
      constraint('todos', null, { constraintType: 'check', columns: ['due_date'] }),
      'check on public.todos (due_date)',
    ],
    [
      trigger('todos', 'todos_updated_at', {
        timing: 'BEFORE',
        events: ['UPDATE', 'INSERT'],
        forEachRow: true,
        function: { schema: null, name: 'set_updated_at' },
      }),
      'trigger todos_updated_at on public.todos (BEFORE INSERT OR UPDATE, for each row, executes set_updated_at)',
    ],
    [
      trigger('todos', 't', { events: ['DELETE'], forEachRow: false }),
      'trigger t on public.todos (DELETE, for each statement)',
    ],
    [
      rls('todos', { enabled: true, forced: false }),
      'row level security on public.todos (enabled, not forced)',
    ],
    [
      policy('todos', 'owners read', {
        command: 'SELECT',
        permissive: false,
        roles: ['authenticated', 'anon'],
      }),
      'policy "owners read" on public.todos (restrictive, for SELECT, to anon, authenticated)',
    ],
    [type('email', { typeKind: 'domain' }), 'type public.email (domain)'],
    [type('job_status', { typeKind: 'enum' }), 'enum type public.job_status'],
    [fn('refresh_stats', [], { isProcedure: true }), 'procedure public.refresh_stats()'],
  ];
  it.each(cases.map(([object, text]) => ({ object, text })))('$text', ({ object, text }) => {
    expect(describeExpected(object)).toBe(text);
  });
});
