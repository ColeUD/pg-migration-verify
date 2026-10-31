/**
 * Parser -> verifier -> formatter, with the real SQL parser and a hand-written catalog. The verify
 * tests use hand-built expectations and the parser tests never see a catalog; this file proves the
 * two agree on what crosses between them: type spelling (`varchar(40)` vs `character varying(40)`,
 * bare `plan` vs `public.plan`), object keys, unnamed constraints and indexes matched against the
 * names Postgres generated, an index renamed in a later file (whose table the parser cannot know)
 * and followed there by the earlier file's expectation, and later migrations superseding earlier
 * objects.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { MigrationFile, MigrationReport } from '../../src/model.js';
import { loadParser, parseMigration } from '../../src/parser/index.js';
import {
  formatMigrationReport,
  formatSummary,
  verifyMigrations,
  type MigrationInput,
} from '../../src/verify/index.js';
import { cat, snapshot } from './verify/builders.js';

const MIGRATIONS: Record<string, string> = {
  '20240101000000_create_profiles.sql': `
CREATE TYPE plan AS ENUM ('free', 'pro');
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  username varchar(40) NOT NULL UNIQUE,
  plan plan NOT NULL DEFAULT 'free',
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles are public" ON profiles FOR SELECT USING (true);
`,
  '20240102000000_create_todos.sql': `
CREATE TABLE todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES profiles (id),
  title text NOT NULL CHECK (char_length(title) > 0),
  due date,
  legacy_flag boolean
);
CREATE INDEX ON todos (owner_id);
CREATE FUNCTION archive_todo(todo_id integer) RETURNS void LANGUAGE sql AS $$ SELECT $$;
GRANT SELECT ON todos TO authenticated;
`,
  '20240103000000_todos_priority.sql': `
ALTER TABLE todos ADD COLUMN priority int2 NOT NULL DEFAULT 0;
ALTER TABLE todos DROP COLUMN legacy_flag;
ALTER TABLE todos ALTER COLUMN due TYPE timestamptz;
CREATE INDEX todos_priority_idx ON todos (priority);
DROP FUNCTION archive_todo(integer);
CREATE FUNCTION archive_todo(todo_id bigint) RETURNS void LANGUAGE sql AS $$ SELECT $$;
ALTER INDEX todos_owner_id_idx RENAME TO todos_owner_idx;
`,
};

/**
 * The database as someone left it: the first migration ran through the CLI; the second was pasted
 * into the SQL editor (so its objects exist but history does not know it); the third is recorded
 * but only its DROP COLUMN, ALTER COLUMN TYPE and ALTER INDEX took effect. Names are the ones
 * Postgres generates for unnamed constraints and indexes, and user types are schema-qualified as
 * `format_type` prints them with an empty search_path.
 */
const DATABASE = snapshot({
  relations: [
    cat.table('profiles', { rlsEnabled: true }),
    cat.table('todos'),
    cat.table('todos_id_seq', { kind: 'sequence' }),
  ],
  columns: [
    cat.column('profiles', 'id', 'uuid', { notNull: true }),
    cat.column('profiles', 'username', 'character varying(40)', { notNull: true }),
    cat.column('profiles', 'plan', 'public.plan', { notNull: true }),
    cat.column('profiles', 'created_at', 'timestamp with time zone', { notNull: true }),
    cat.column('todos', 'id', 'bigint', { notNull: true }),
    cat.column('todos', 'owner_id', 'uuid', { notNull: true }),
    cat.column('todos', 'title', 'text', { notNull: true }),
    cat.column('todos', 'due', 'timestamp with time zone'),
  ],
  indexes: [
    cat.index('profiles', 'profiles_pkey', ['id'], { unique: true, primary: true }),
    cat.index('profiles', 'profiles_username_key', ['username'], { unique: true }),
    cat.index('todos', 'todos_pkey', ['id'], { unique: true, primary: true }),
    cat.index('todos', 'todos_owner_idx', ['owner_id']),
  ],
  constraints: [
    cat.constraint('profiles', 'profiles_pkey', 'primary_key', ['id']),
    cat.constraint('profiles', 'profiles_username_key', 'unique', ['username']),
    cat.constraint('todos', 'todos_pkey', 'primary_key', ['id']),
    cat.constraint('todos', 'todos_owner_id_fkey', 'foreign_key', ['owner_id'], {
      references: { schema: 'public', table: 'profiles', columns: ['id'] },
    }),
    cat.constraint('todos', 'todos_title_check', 'check', ['title']),
  ],
  functions: [cat.fn('archive_todo', ['integer'])],
  policies: [cat.policy('profiles', 'Profiles are public', { command: 'SELECT' })],
  types: [cat.type('plan')],
  enumValues: [
    { schema: 'public', typeName: 'plan', value: 'free' },
    { schema: 'public', typeName: 'plan', value: 'pro' },
  ],
});

const RECORDED = new Set(['20240101000000', '20240103000000']);

describe('parse, verify and format a partially applied database', () => {
  let reports: MigrationReport[];

  beforeAll(async () => {
    await loadParser();
    reports = verifyMigrations({
      migrations: Object.entries(MIGRATIONS).map(([fileName, sql]) => input(fileName, sql)),
      snapshot: DATABASE,
      recordedVersions: RECORDED,
    });
  });

  it('summarizes which migrations really ran and which history disagrees with', () => {
    expect(formatSummary(reports)).toBe(
      [
        'VERSION         NAME             RESULT    MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240101000000  create_profiles  MATCH     12/12    0           0             recorded',
        '20240102000000  create_todos     MATCH     9/9      2           1             NOT RECORDED',
        '20240103000000  todos_priority   MISMATCH  4/8      0           0             recorded',
        '',
        '3 migrations: 2 MATCH, 1 MISMATCH, 0 nothing to verify. 1 applied but NOT recorded in history.',
        '1 recorded in history but MISMATCH: 20240103000000_todos_priority.sql',
      ].join('\n'),
    );
  });

  it('explains the half-applied migration line by line', () => {
    expect(
      formatMigrationReport(reports[2]!, {
        historyTable: 'supabase_migrations.schema_migrations',
      }),
    ).toBe(
      [
        'MISMATCH 4/8  20240103000000_todos_priority.sql',
        '  MISSING    line 2  column public.todos.priority (smallint, not null)',
        '  MISSING    line 5  index public.todos_priority_idx (on public.todos (priority), using btree)',
        '  MISSING    line 7  function public.archive_todo(bigint)',
        '                     note: found other signatures: archive_todo(integer)',
        '  UNEXPECTED line 6  function public.archive_todo(integer): dropped or renamed here, but still exists',
        '  history: recorded in supabase_migrations.schema_migrations',
      ].join('\n'),
    );
  });

  it('checks the earlier migration against the later type change and skips what was dropped', () => {
    const todos = reports[1]!;
    const verbose = formatMigrationReport(todos, { verbose: true }).split('\n');
    expect(verbose).toContain(
      '  SUPERSEDED   line 2   column public.todos.legacy_flag: dropped by 20240103000000_todos_priority.sql line 3',
    );
    expect(verbose).toContain(
      '  SUPERSEDED   line 10  function public.archive_todo(integer): dropped by 20240103000000_todos_priority.sql line 6',
    );
    // Renamed in the later file by the name Postgres generated for it: checked under the new name.
    expect(verbose).toEqual(
      expect.arrayContaining([
        '  MATCH        line 9   index public.todos_owner_idx',
        '                        note: renamed from index on public.todos (owner_id) by 20240103000000_todos_priority.sql line 8',
      ]),
    );
    expect(todos.checks.find((c) => c.object.key === 'column:public.todos.due')?.notes).toEqual([
      'type updated by 20240103000000_todos_priority.sql line 4',
    ]);
  });
});

function input(fileName: string, sql: string): MigrationInput {
  const [, version = '', name = ''] = /^(\d+)_(.*)\.sql$/.exec(fileName) ?? [];
  const file: MigrationFile = {
    version,
    name,
    fileName,
    path: `/repo/supabase/migrations/${fileName}`,
    checksum: '0'.repeat(64),
  };
  return { file, parsed: parseMigration(sql, { file: fileName }) };
}
