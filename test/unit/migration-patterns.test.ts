/**
 * Common migration patterns that rebuild, rename or re-declare objects, through the real parser,
 * the verifier and the formatter, against a hand-written catalog of the database those migrations
 * leave behind. Each of them once produced a false MISSING or DIFFERENT on a correct database.
 * The integration test migration-patterns.test.ts applies the same SQL to a real Postgres.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { MigrationFile, MigrationReport } from '../../src/model.js';
import { loadParser, parseMigration } from '../../src/parser/index.js';
import { formatMigrationReport, formatSummary, verifyMigrations } from '../../src/verify/index.js';
import { PATTERN_MIGRATIONS } from '../fixtures/migration-patterns.js';
import { cat, snapshot } from './verify/builders.js';

/** The database after every migration in PATTERN_MIGRATIONS ran. */
const DATABASE = snapshot({
  relations: [
    cat.table('tasks'),
    cat.table('settings'),
    cat.table('profiles'),
    cat.table('inl'),
    cat.table('widgets'),
    cat.table('gadgets'),
    cat.table('diary'),
    cat.table('ine'),
  ],
  columns: [
    cat.column('tasks', 'id', 'integer', { notNull: true }),
    cat.column('tasks', 'status', 'public.task_status', { notNull: true }),
    cat.column('settings', 'id', 'integer', { notNull: true }),
    cat.column('settings', 'theme', 'text', { notNull: true }),
    cat.column('profiles', 'id', 'uuid', { notNull: true }),
    cat.column('profiles', 'username', 'text'),
    cat.column('profiles', 'email', 'text'),
    cat.column('profiles', 'age', 'integer'),
    cat.column('inl', 'id', 'integer', { notNull: true }),
    cat.column('inl', 'code', 'text'),
    cat.column('widgets', 'id', 'integer', { notNull: true }),
    cat.column('widgets', 'code', 'text'),
    cat.column('gadgets', 'id', 'integer', { notNull: true }),
    cat.column('diary', 'id', 'integer', { notNull: true }),
    cat.column('diary', 'm', 'public.feeling'),
    cat.column('ine', 'id', 'integer', { notNull: true }),
    cat.column('ine', 'a', 'integer', { notNull: true }),
  ],
  indexes: [
    cat.index('tasks', 'tasks_pkey', ['id'], { unique: true, primary: true }),
    cat.index('settings', 'settings_pkey', ['id'], { unique: true, primary: true }),
    cat.index('profiles', 'profiles_pkey', ['id'], { unique: true, primary: true }),
    cat.index('inl', 'inl_pkey', ['id'], { unique: true, primary: true }),
    cat.index('widgets', 'widgets_code_key', ['code'], { unique: true }),
    cat.index('gadgets', 'gadgets_pkey', ['id'], { unique: true, primary: true }),
    cat.index('diary', 'diary_pkey', ['id'], { unique: true, primary: true }),
    cat.index('ine', 'ine_pkey', ['id'], { unique: true, primary: true }),
  ],
  constraints: [
    cat.constraint('tasks', 'tasks_pkey', 'primary_key', ['id']),
    cat.constraint('settings', 'settings_pkey', 'primary_key', ['id']),
    cat.constraint('profiles', 'profiles_pkey', 'primary_key', ['id']),
    cat.constraint('inl', 'inl_pkey', 'primary_key', ['id']),
    cat.constraint('widgets', 'widgets_code_key', 'unique', ['code']),
    cat.constraint('gadgets', 'gadgets_pkey', 'primary_key', ['id']),
    cat.constraint('diary', 'diary_pkey', 'primary_key', ['id']),
    cat.constraint('ine', 'ine_pkey', 'primary_key', ['id']),
  ],
  functions: [cat.fn('f_touch2', [])],
  triggers: [
    cat.trigger('diary', 'diary_touch', {
      timing: 'BEFORE',
      events: ['UPDATE'],
      function: { schema: 'public', name: 'f_touch2' },
    }),
  ],
  types: [cat.type('task_status'), cat.type('feeling')],
  enumValues: [
    ...['todo', 'doing', 'done'].map((value) => ({
      schema: 'public',
      typeName: 'task_status',
      value,
    })),
    ...['ok', 'meh'].map((value) => ({ schema: 'public', typeName: 'feeling', value })),
  ],
});

describe('migration patterns that rebuild, rename or re-declare objects', () => {
  let reports: MigrationReport[];

  beforeAll(async () => {
    await loadParser();
    reports = verifyMigrations({
      migrations: Object.entries(PATTERN_MIGRATIONS).map(([fileName, sql]) => ({
        file: file(fileName),
        parsed: parseMigration(sql, { file: fileName }),
      })),
      snapshot: DATABASE,
      recordedVersions: null,
    });
  });

  /** Verbose report lines of one migration, by its name. */
  function lines(name: string): string[] {
    const report = reports.find((r) => r.name === name);
    expect(report, name).toBeDefined();
    return formatMigrationReport(report!, { verbose: true }).split('\n');
  }

  it('verifies every migration as MATCH', () => {
    expect(formatSummary(reports)).toBe(
      [
        'VERSION         NAME                    RESULT  MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240101000000  tasks_and_settings      MATCH   4/4      11          0             -',
        '20240102000000  rebuild_enum_and_table  MATCH   10/10    0           0             -',
        '20240201000000  profiles                MATCH   11/11    3           0             -',
        '20240202000000  drop_generated_names    MATCH*  3/3      0           0             -',
        '20240301000000  widgets_using_index     MATCH   6/6      0           0             -',
        '20240302000000  gadgets_index           MATCH   3/3      0           0             -',
        '20240303000000  gadgets_primary_key     MATCH   3/3      0           0             -',
        '20240401000000  diary_renames           MATCH   11/11    0           0             -',
        '20240501000000  ine                     MATCH   4/4      0           0             -',
        '20240502000000  ine_if_not_exists       MATCH*  1/1      3           0             -',
        '',
        '10 migrations: 10 MATCH, 0 MISMATCH, 0 nothing to verify. History unavailable.',
        'MATCH*: every check would also hold had the file never run, so it may not have been applied.',
      ].join('\n'),
    );
  });

  it('supersedes what a later rebuild of an enum or a table leaves out', () => {
    const file = '20240102000000_rebuild_enum_and_table.sql';
    const rebuilt = `dropped and re-created by ${file}`;
    const tableRebuilt = `table public.settings ${rebuilt} line 6`;
    // The enum was renamed to task_status_old (its values with it) and dropped as such.
    const oldDropped = `type public.task_status_old dropped by ${file} line 4`;
    const renamed = `type public.task_status renamed to type public.task_status_old by ${file} line 1`;
    expect(lines('tasks_and_settings')).toEqual([
      'MATCH 4/4  20240101000000_tasks_and_settings.sql',
      `  SUPERSEDED line 1  enum type public.task_status_old: dropped by ${file} line 4`,
      `                     note: renamed from enum type public.task_status by ${file} line 1`,
      ...['todo', 'doing', 'blocked', 'done'].flatMap((value) => [
        `  SUPERSEDED line 1  enum value public.task_status_old.'${value}': ${oldDropped}`,
        `                     note: ${renamed}`,
      ]),
      `  SUPERSEDED line 3  table public.settings: ${rebuilt} line 6`,
      `  SUPERSEDED line 3  column public.settings.id: ${tableRebuilt}`,
      `  SUPERSEDED line 3  primary key on public.settings (id): ${tableRebuilt}`,
      `  SUPERSEDED line 3  column public.settings.theme: ${tableRebuilt}`,
      `  SUPERSEDED line 3  column public.settings.beta: ${tableRebuilt}`,
      `  SUPERSEDED line 4  policy "read settings" on public.settings: ${tableRebuilt}`,
      '  MATCH      line 2  table public.tasks',
      '  MATCH      line 2  column public.tasks.id',
      '  MATCH      line 2  primary key on public.tasks (id)',
      '  MATCH      line 2  column public.tasks.status',
      '  history: unavailable',
    ]);
  });

  it('supersedes unnamed constraints and indexes dropped by their generated names', () => {
    const dropped = 'dropped by 20240202000000_drop_generated_names.sql';
    expect(lines('profiles')).toEqual([
      'MATCH 11/11  20240201000000_profiles.sql',
      `  SUPERSEDED line 1  unique on public.profiles (username): ${dropped} line 1`,
      `  SUPERSEDED line 1  check on public.profiles (age): ${dropped} line 2`,
      `  SUPERSEDED line 2  index on public.profiles (email): ${dropped} line 3`,
      '  MATCH      line 1  table public.profiles',
      '  MATCH      line 1  column public.profiles.id',
      '  MATCH      line 1  primary key on public.profiles (id)',
      '  MATCH      line 1  column public.profiles.username',
      '  MATCH      line 1  column public.profiles.email',
      '  MATCH      line 1  column public.profiles.age',
      '  MATCH      line 3  table public.inl',
      '  MATCH      line 3  column public.inl.id',
      '  MATCH      line 3  primary key on public.inl (id)',
      '  MATCH      line 3  column public.inl.code',
      '  MATCH      line 4  constraint inl_code_key on public.inl: dropped or renamed here, and no longer exists',
      '  history: unavailable',
    ]);
  });

  it('follows the index that ADD CONSTRAINT ... USING INDEX renames', () => {
    expect(lines('gadgets_index')).toEqual([
      'MATCH 3/3  20240302000000_gadgets_index.sql',
      '  MATCH line 1  table public.gadgets',
      '  MATCH line 1  column public.gadgets.id',
      '  MATCH line 2  index public.gadgets_pkey',
      '                note: renamed from index public.gadgets_id_idx by 20240303000000_gadgets_primary_key.sql line 1',
      '  history: unavailable',
    ]);
  });

  it('checks a re-declaration that IF NOT EXISTS skipped for existence only', () => {
    const skipped =
      'skipped by IF NOT EXISTS: table public.ine already created by 20240501000000_ine.sql line 1';
    expect(lines('ine_if_not_exists')).toEqual([
      'MATCH 1/1  20240502000000_ine_if_not_exists.sql',
      `  SUPERSEDED line 1  column public.ine.id: ${skipped}`,
      `  SUPERSEDED line 1  primary key on public.ine (id): ${skipped}`,
      `  SUPERSEDED line 1  column public.ine.a: ${skipped}`,
      '  MATCH      line 1  table public.ine',
      '                     note: IF NOT EXISTS: already created by 20240501000000_ine.sql line 1, so only its existence is checked',
      '  evidence: none, every check would also hold had this file never run, so this MATCH does not show that it was applied',
      '  history: unavailable',
    ]);
    // The earlier migration is checked against what it created, not the skipped re-declaration.
    expect(lines('ine').join('\n')).not.toContain('updated by');
  });
});

function file(fileName: string): MigrationFile {
  const [, version = '', name = ''] = /^(\d+)_(.*)\.sql$/.exec(fileName) ?? [];
  return { version, name, fileName, path: `/repo/${fileName}`, checksum: '0'.repeat(64) };
}
