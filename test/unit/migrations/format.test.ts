import { describe, expect, it } from 'vitest';
import { tooLargeReason, type MigrationListing } from '../../../src/migrations/files.js';
import {
  formatHistoryDiff,
  formatMigrationListing,
  formatRecordedHistory,
} from '../../../src/migrations/format.js';
import { diffHistory } from '../../../src/migrations/history-diff.js';
import type { MigrationFile, RecordedHistory } from '../../../src/model.js';

const TABLE = 'supabase_migrations.schema_migrations';

function file(
  version: string,
  name: string,
  checksum = 'abcdef0123456789'.repeat(4),
): MigrationFile {
  const fileName = `${version}_${name}.sql`;
  return { version, name, fileName, path: `/repo/supabase/migrations/${fileName}`, checksum };
}

const lines = (...rows: string[]): string => rows.join('\n');

describe('formatMigrationListing', () => {
  it('renders an aligned table with short checksums', () => {
    const listing: MigrationListing = {
      files: [
        file('20240101000000', 'create_profiles'),
        file('20240102000000', 'create_todos', '0123456789abcdef'.repeat(4)),
      ],
      skipped: [],
      duplicateVersions: [],
    };

    expect(formatMigrationListing(listing, 'supabase/migrations')).toBe(
      lines(
        '2 migration files in supabase/migrations',
        '  VERSION         NAME             SHA256',
        '  20240101000000  create_profiles  abcdef012345',
        '  20240102000000  create_todos     0123456789ab',
      ),
    );
  });

  it('warns that versions of different lengths apply in file-name order', () => {
    const listing: MigrationListing = {
      files: [file('10', 'b'), file('9', 'a')],
      skipped: [],
      duplicateVersions: [],
    };
    expect(formatMigrationListing(listing, 'db').split('\n').at(-1)).toMatch(
      /^Versions of different lengths: the Supabase CLI applies migrations in file-name order/,
    );
  });

  it('marks oversized files as not verified rather than skipped by the CLI', () => {
    const listing: MigrationListing = {
      files: [],
      skipped: [{ fileName: '2024_dump.sql', reason: tooLargeReason() }],
      duplicateVersions: [],
    };
    expect(formatMigrationListing(listing, 'db')).toContain('Skipped 1 .sql file, not verified:');
  });

  it('adds skipped files and duplicate versions after the table', () => {
    const listing: MigrationListing = {
      files: [file('1', 'init'), file('1', 'init_again')],
      skipped: [
        { fileName: 'seed.sql', reason: 'bad name' },
        { fileName: 'notes_v2.sql', reason: 'bad name too' },
      ],
      duplicateVersions: ['1'],
    };

    expect(formatMigrationListing(listing, 'db/migrations')).toBe(
      lines(
        '2 migration files in db/migrations',
        '  VERSION  NAME        SHA256',
        '  1        init        abcdef012345',
        '  1        init_again  abcdef012345',
        '',
        'Skipped 2 .sql files (never applied by the Supabase CLI):',
        '  seed.sql      bad name',
        '  notes_v2.sql  bad name too',
        '',
        'Duplicate versions (each version must belong to one file): 1',
      ),
    );
  });

  it('says so when there are no migration files, using singular nouns for one skipped file', () => {
    const listing: MigrationListing = {
      files: [],
      skipped: [{ fileName: 'seed.sql', reason: 'bad name' }],
      duplicateVersions: [],
    };

    expect(formatMigrationListing(listing, 'supabase/migrations')).toBe(
      lines(
        'No migration files in supabase/migrations.',
        '',
        'Skipped 1 .sql file (never applied by the Supabase CLI):',
        '  seed.sql  bad name',
      ),
    );
  });
});

describe('formatRecordedHistory', () => {
  it('lists recorded migrations sorted by version, with a dash for a missing name', () => {
    const history: RecordedHistory = {
      status: 'ok',
      table: TABLE,
      migrations: [
        { version: '20240102000000', name: null },
        { version: '20240101000000', name: 'create_profiles' },
      ],
    };

    expect(formatRecordedHistory(history)).toBe(
      lines(
        `2 migrations recorded in ${TABLE}`,
        '  VERSION         NAME',
        '  20240101000000  create_profiles',
        '  20240102000000  -',
      ),
    );
  });

  it('says when nothing is recorded', () => {
    expect(formatRecordedHistory({ status: 'ok', table: TABLE, migrations: [] })).toBe(
      `No migrations recorded in ${TABLE}.`,
    );
  });

  it('explains that a missing history table blocks the comparison, and what to use instead', () => {
    expect(formatRecordedHistory({ status: 'missing', table: TABLE })).toBe(
      'supabase_migrations.schema_migrations does not exist in this database: history cannot be ' +
        'compared; use verify_all to check objects directly.',
    );
  });

  it('explains the grants needed when the history table is not readable', () => {
    const history: RecordedHistory = {
      status: 'not_readable',
      table: TABLE,
      reason: 'permission denied for schema supabase_migrations',
    };

    expect(formatRecordedHistory(history)).toBe(
      lines(
        `${TABLE} exists but cannot be read: permission denied for schema supabase_migrations`,
        'History cannot be compared until the connecting role can read it. As an administrator, run:',
        '  GRANT USAGE ON SCHEMA supabase_migrations TO <role>;',
        `  GRANT SELECT ON ${TABLE} TO <role>;`,
        '<role> is the role in the connection string; it needs no write privileges.',
        'verify_all checks objects directly and works without this grant.',
      ),
    );
  });

  it('omits the schema grant for an unqualified table name', () => {
    const text = formatRecordedHistory({
      status: 'not_readable',
      table: 'schema_migrations',
      reason: 'permission denied',
    });

    expect(text).toContain('  GRANT SELECT ON schema_migrations TO <role>;');
    expect(text).not.toContain('USAGE');
  });
});

describe('formatHistoryDiff', () => {
  it('renders every version with its status, a summary and an explanation per discrepancy', () => {
    const files = [
      file('20240101000000', 'create_profiles'),
      file('20240102000000', 'create_todos'),
      file('20240104000000', 'add_todo_index'),
    ];
    const history: RecordedHistory = {
      status: 'ok',
      table: TABLE,
      migrations: [
        { version: '20240101000000', name: 'create_profiles' },
        { version: '20240102000000', name: 'todos' },
        { version: '20240103000000', name: 'create_projects' },
      ],
    };

    expect(formatHistoryDiff(diffHistory(files, history.migrations), history)).toBe(
      lines(
        `History: 3 migration files, 3 recorded in ${TABLE}`,
        '  STATUS        VERSION         REPO NAME        RECORDED NAME',
        '  in both       20240101000000  create_profiles  create_profiles',
        '  name differs  20240102000000  create_todos     todos',
        '  only in db    20240103000000  -                create_projects',
        '  only in repo  20240104000000  add_todo_index   -',
        'Summary: 2 in both (1 with a different name), 1 only in repo, 1 only in database.',
        'only in repo: not recorded as applied (pending, or run by hand without recording); ' +
          'verify_migration shows whether its objects exist anyway.',
        'only in db: recorded as applied but no file has that version (deleted, renamed, or ' +
          'applied from another branch).',
        'name differs: same version, different name; the file was probably renamed after it was applied.',
      ),
    );
  });

  it('confirms agreement when nothing differs, treating an unknown recorded name as no conflict', () => {
    const files = [file('1', 'init'), file('2', 'add_todos')];
    const history: RecordedHistory = {
      status: 'ok',
      table: TABLE,
      migrations: [
        { version: '1', name: 'init' },
        { version: '2', name: null },
      ],
    };

    expect(formatHistoryDiff(diffHistory(files, history.migrations), history)).toBe(
      lines(
        `History: 2 migration files, 2 recorded in ${TABLE}`,
        '  STATUS   VERSION  REPO NAME  RECORDED NAME',
        '  in both  1        init       init',
        '  in both  2        add_todos  -',
        'Summary: 2 in both, 0 only in repo, 0 only in database.',
        'Repository and recorded history agree.',
      ),
    );
  });

  it('says there is nothing to compare when both sides are empty', () => {
    const history: RecordedHistory = { status: 'ok', table: TABLE, migrations: [] };

    expect(formatHistoryDiff(diffHistory([], []), history)).toBe(
      lines(`History: 0 migration files, 0 recorded in ${TABLE}`, 'Nothing to compare.'),
    );
  });

  it.each<RecordedHistory>([
    { status: 'missing', table: TABLE },
    { status: 'not_readable', table: TABLE, reason: 'permission denied' },
  ])('falls back to the history explanation when status is $status', (history) => {
    const diff = diffHistory([file('1', 'init')], []);

    expect(formatHistoryDiff(diff, history)).toBe(formatRecordedHistory(history));
  });
});
