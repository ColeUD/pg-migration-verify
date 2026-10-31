/**
 * The project's "done" criterion, end to end: the real MCP server, driven by an MCP client, checks
 * the migrations of a realistic Supabase project (test/integration/fixtures/demo-app) against a
 * real Postgres, connected as the recommended read-only role.
 *
 * Every scenario starts from a fresh database with all fixture migrations applied, then:
 * 1. drift: history records only some versions (the others were pasted into the SQL editor), and
 *    a few objects were changed by hand afterwards;
 * 2. in sync: nothing changed, history complete;
 * 3. no history: the history table does not exist at all.
 *
 * The expected texts are spelled out in full and were checked line by line against the fixture
 * and the hand edits (see the comments next to them): a change in any tool's output must show up
 * in this file's diff. Scenario 1's verify_all text is also docs/example-output.txt, the example
 * the README embeds; run `vitest run --project integration -u` to refresh it after a deliberate
 * output change.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import pg from 'pg';
import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it, vi } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { createToolContext } from '../../src/tools/context.js';
import type {
  DiffHistoryOutput,
  ExpectedObjectsOutput,
  ListRecordedMigrationsOutput,
  ListRepoMigrationsOutput,
  VerifyAllOutput,
  VerifyMigrationOutput,
} from '../../src/tools/schemas.js';
import {
  applySql,
  createReadOnlyRole,
  createTestDatabase,
  READ_ONLY_ROLE,
  type TestDatabase,
} from './helpers/test-db.js';

const PROJECT_DIR = fileURLToPath(new URL('./fixtures/demo-app', import.meta.url));
const MIGRATIONS_DIR = path.join(PROJECT_DIR, 'supabase', 'migrations');
const EXAMPLE_OUTPUT = '../../docs/example-output.txt';

const HISTORY_TABLE = 'supabase_migrations.schema_migrations';

/** Every fixture migration as [version, name], in the order the Supabase CLI applies them. */
const ALL_MIGRATIONS: readonly (readonly [string, string])[] = [
  ['20240301090000', 'create_organizations'],
  ['20240301091500', 'create_profiles_and_memberships'],
  ['20240302100000', 'create_projects'],
  ['20240305120000', 'create_tasks'],
  ['20240310083000', 'create_comments'],
  ['20240315140000', 'task_details_and_search'],
  ['20240320090000', 'rework_profiles_and_tasks'],
  ['20240322100000', 'seed_plans'],
];

/**
 * Scenario 1's history: four of the eight files, plus two classic inconsistencies. 20240215000000
 * was recorded from a file that no longer exists, and 20240301091500 was recorded under the name
 * its file had before being renamed.
 */
const PARTIAL_HISTORY: readonly (readonly [string, string])[] = [
  ['20240215000000', 'bootstrap_extensions'],
  ['20240301090000', 'create_organizations'],
  ['20240301091500', 'create_profiles'],
  ['20240305120000', 'create_tasks'],
  ['20240315140000', 'task_details_and_search'],
];

/**
 * Hand edits made after the migrations ran, each breaking exactly one expected object:
 * create_tasks loses a column and an index, create_comments a policy and a NOT NULL, and
 * task_details_and_search's function gets another signature.
 */
const HAND_EDITS = String.raw`
ALTER TABLE public.tasks DROP COLUMN due_on;
DROP INDEX public.tasks_project_status_idx;
DROP POLICY "Authors write comments" ON public.comments;
ALTER TABLE public.comments ALTER COLUMN body DROP NOT NULL;
DROP FUNCTION public.search_tasks(text);
CREATE FUNCTION public.search_tasks(query text, max_results integer DEFAULT 50)
RETURNS SETOF public.tasks
LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT * FROM public.tasks t WHERE t.title ILIKE '%' || query || '%' LIMIT max_results;
$$;
`;

/** Rows the read-only role may even write to: the server must leave them alone regardless. */
const CANARY = `
CREATE TABLE public.canary (id integer PRIMARY KEY, note text NOT NULL);
INSERT INTO public.canary VALUES (1, 'one'), (2, 'two'), (3, 'three');
GRANT SELECT, INSERT, UPDATE, DELETE ON public.canary TO ${READ_ONLY_ROLE};
`;

const lines = (...l: string[]): string => l.join('\n');

/** Applies the fixture migrations in version order, the way `supabase db push` would. */
async function applyMigrations(admin: PgClient): Promise<void> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{14}_.+\.sql$/.test(f)).sort();
  expect(files).toHaveLength(ALL_MIGRATIONS.length);
  for (const file of files) {
    await applySql(admin, await readFile(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
}

/**
 * The Supabase CLI's history table with `rows`, plus exactly the grants the README recommends for
 * reading it (the output of list_recorded_migrations when they are missing).
 */
function historySql(rows: readonly (readonly [string, string])[]): string {
  const values = rows.map(([version, name]) => `('${version}', '${name}')`).join(', ');
  return `
CREATE SCHEMA supabase_migrations;
CREATE TABLE ${HISTORY_TABLE} (version text PRIMARY KEY, statements text[], name text);
INSERT INTO ${HISTORY_TABLE} (version, name) VALUES ${values};
GRANT USAGE ON SCHEMA supabase_migrations TO ${READ_ONLY_ROLE};
GRANT SELECT ON ${HISTORY_TABLE} TO ${READ_ONLY_ROLE};
`;
}

interface Scenario {
  db: TestDatabase;
  /** The URL the server connects with (fake, test-only credentials). */
  readOnlyUrl: string;
  client: Client;
  close(): Promise<void>;
}

/**
 * A fresh database with every migration applied, `prepare` run as the admin, and an MCP client
 * talking to the real server configured the way a user would: PGMV_DATABASE_URL holding the
 * read-only role's URL, run from the project directory.
 */
async function startScenario(prepare: (admin: PgClient) => Promise<void>): Promise<Scenario> {
  const db = await createTestDatabase();
  await applyMigrations(db.admin);
  // Before `prepare`, which may grant the role access to the history table.
  const readOnlyUrl = await createReadOnlyRole(inject('adminUrl'), db.name);
  await prepare(db.admin);

  const context = createToolContext(readConfig({ PGMV_DATABASE_URL: readOnlyUrl }, PROJECT_DIR));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(context).connect(serverTransport);
  const client = new Client({ name: 'pgmv-demo-app', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    db,
    readOnlyUrl,
    client,
    async close() {
      await client.close();
      await db.drop();
    },
  };
}

interface ToolOutput<Structured> {
  text: string;
  structured: Structured;
}

async function call<Structured>(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolOutput<Structured>> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  // Fails with the tool's own message, which says what went wrong.
  expect(result.isError ?? false, text).toBe(false);
  return { text, structured: result.structuredContent as Structured };
}

/** [file, verdict, matched/checked, superseded, unverifiable, recorded] for each migration. */
function verdicts(output: VerifyAllOutput): unknown[][] {
  return output.migrations.map((m) => [
    m.version,
    m.verdict,
    `${m.matched}/${m.checked}`,
    m.superseded,
    m.unverifiable,
    m.recorded,
  ]);
}

const SKIPPED_WARNING =
  'Skipped 1 .sql file not named <version>_<name>.sql (never applied by the Supabase CLI): ' +
  'add_billing_draft.sql';

describe('scenario 1: history out of sync and objects changed by hand', () => {
  let scenario: Scenario;
  beforeAll(async () => {
    scenario = await startScenario(async (admin) => {
      await applySql(admin, historySql(PARTIAL_HISTORY));
      await applySql(admin, HAND_EDITS);
      await applySql(admin, CANARY);
    });
  });
  afterAll(async () => {
    await scenario.close();
  });

  it('verify_all finds every hand edit and every history gap', async () => {
    const { text, structured } = await call<VerifyAllOutput>(scenario.client, 'verify_all');

    // Row by row:
    // - create_organizations: 23 objects (enum + 3 values from the DO block, 2 tables, 9 columns,
    //   6 constraints, function, trigger), all there; recorded.
    // - create_profiles_and_memberships: 21 objects; display_name is renamed by rework_..., so
    //   20 are checked. Recorded (under its old name: history is matched by version).
    // - create_projects: 18 objects, all there, never recorded (pasted into the SQL editor).
    // - create_tasks: 24 objects; tasks_assignee_idx is dropped by rework_..., so 23 are checked
    //   and 2 were removed by hand (due_on, tasks_project_status_idx).
    // - create_comments: 23 objects; task_events with its 5 columns, 2 constraints and index is
    //   dropped by rework_... (9 superseded); of the 14 left, the policy and body's NOT NULL were
    //   removed by hand. GRANT and COMMENT are unverifiable.
    // - task_details_and_search: 6 objects, the function now has another signature; the UPDATE
    //   is unverifiable.
    // - rework_profiles_and_tasks: 3 drops/renames confirmed gone, 3 objects there.
    // - seed_plans: two INSERTs, nothing to verify.
    // Totals: create_projects and rework_... are applied but not recorded; create_tasks and
    // task_details_and_search are recorded but broken. Each MISMATCH then gets its full report.
    expect(text).toBe(
      lines(
        'VERSION         NAME                             RESULT             MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240301090000  create_organizations             MATCH              23/23    0           0             recorded',
        '20240301091500  create_profiles_and_memberships  MATCH              20/20    1           0             recorded',
        '20240302100000  create_projects                  MATCH              18/18    0           0             NOT RECORDED',
        '20240305120000  create_tasks                     MISMATCH           21/23    1           0             recorded',
        '20240310083000  create_comments                  MISMATCH           12/14    9           2             NOT RECORDED',
        '20240315140000  task_details_and_search          MISMATCH           5/6      0           1             recorded',
        '20240320090000  rework_profiles_and_tasks        MATCH              6/6      0           0             NOT RECORDED',
        '20240322100000  seed_plans                       NOTHING TO VERIFY  -        0           2             NOT RECORDED',
        '',
        '8 migrations: 4 MATCH, 3 MISMATCH, 1 nothing to verify. 2 applied but NOT recorded in history.',
        '2 recorded in history but MISMATCH: 20240305120000_create_tasks.sql, 20240315140000_task_details_and_search.sql',
        SKIPPED_WARNING,
        '',
        // Line numbers are those of the statements: both columns come from the CREATE TABLE.
        'MISMATCH 21/23  20240305120000_create_tasks.sql',
        '  MISSING    line 5   column public.tasks.due_on (date, nullable)',
        '  MISSING    line 18  index public.tasks_project_status_idx (on public.tasks (project_id, status), using btree)',
        '  SUPERSEDED line 19  index public.tasks_assignee_idx: dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 12',
        `  history: recorded in ${HISTORY_TABLE}`,
        '',
        'MISMATCH 12/14  20240310083000_create_comments.sql',
        '  MISSING      line 26  policy "Authors write comments" on public.comments (for INSERT, to authenticated)',
        '  DIFFERENT    line 3   column public.comments.body: nullability expected not null, found nullable',
        '  SUPERSEDED   line 34  table public.task_events: dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  column public.task_events.id: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  primary key on public.task_events (id): table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  column public.task_events.task_id: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  foreign key on public.task_events (task_id): table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  column public.task_events.kind: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  column public.task_events.payload: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 34  column public.task_events.created_at: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  SUPERSEDED   line 42  index public.task_events_task_id_idx: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16',
        '  UNVERIFIABLE line 30  GrantStmt: privileges are not checked',
        '  UNVERIFIABLE line 32  CommentStmt: comments are not checked',
        `  history: NOT recorded in ${HISTORY_TABLE}`,
        '',
        'MISMATCH 5/6  20240315140000_task_details_and_search.sql',
        '  MISSING      line 15  function public.search_tasks(text)',
        '                        note: found other signatures: search_tasks(text, integer)',
        '  UNVERIFIABLE line 10  UpdateStmt: data change, not a schema object',
        `  history: recorded in ${HISTORY_TABLE}`,
      ),
    );
    // With a final newline, so editors that add one do not make the file drift from the output.
    await expect(`${text}\n`).toMatchFileSnapshot(EXAMPLE_OUTPUT);

    expect(structured.history).toEqual({ table: HISTORY_TABLE, status: 'ok', reason: null });
    expect(structured.totals).toEqual({
      migrations: 8,
      match: 4,
      mismatch: 3,
      nothingToVerify: 1,
      appliedNotRecorded: 2,
      recordedButMismatch: 2,
    });
    expect(verdicts(structured)).toEqual([
      ['20240301090000', 'MATCH', '23/23', 0, 0, true],
      ['20240301091500', 'MATCH', '20/20', 1, 0, true],
      ['20240302100000', 'MATCH', '18/18', 0, 0, false],
      ['20240305120000', 'MISMATCH', '21/23', 1, 0, true],
      ['20240310083000', 'MISMATCH', '12/14', 9, 2, false],
      ['20240315140000', 'MISMATCH', '5/6', 0, 1, true],
      ['20240320090000', 'MATCH', '6/6', 0, 0, false],
      ['20240322100000', 'NOTHING_TO_VERIFY', '0/0', 0, 2, false],
    ]);
    expect(
      structured.migrations.flatMap((m) =>
        m.problems.map((p) => [m.version, p.status, p.object, p.line]),
      ),
    ).toEqual([
      ['20240305120000', 'missing', 'column public.tasks.due_on', 5],
      ['20240305120000', 'missing', 'index public.tasks_project_status_idx', 18],
      ['20240310083000', 'different', 'column public.comments.body', 3],
      ['20240310083000', 'missing', 'policy "Authors write comments" on public.comments', 26],
      ['20240315140000', 'missing', 'function public.search_tasks(text)', 15],
    ]);
  });

  it('verify_migration: MATCH 18/18 for a migration pasted into the SQL editor', async () => {
    const { text, structured } = await call<VerifyMigrationOutput>(
      scenario.client,
      'verify_migration',
      { file: 'create_projects' },
    );

    // Table, 8 columns, 2 indexes, 3 constraints, trigger, RLS, 2 policies.
    expect(text).toBe(
      lines(
        'MATCH 18/18  20240302100000_create_projects.sql',
        `  history: NOT recorded in ${HISTORY_TABLE}`,
      ),
    );
    expect(structured.migration).toMatchObject({
      verdict: 'MATCH',
      matched: 18,
      checked: 18,
      superseded: 0,
      recorded: false,
      problems: [],
    });
    expect(structured.checks).toHaveLength(18);
    expect(structured.checks.every((c) => c.status === 'match')).toBe(true);
    // description was nullable here; task_details_and_search made it NOT NULL, and that holds.
    expect(structured.checks.find((c) => c.key === 'column:public.projects.description')).toEqual(
      expect.objectContaining({
        expected: 'column public.projects.description (text, not null)',
        notes: ['nullability updated by 20240315140000_task_details_and_search.sql line 11'],
      }),
    );
  });

  it('verify_migration: the problems of a recorded migration, matches included when verbose', async () => {
    const { text, structured } = await call<VerifyMigrationOutput>(
      scenario.client,
      'verify_migration',
      { file: '20240305120000', verbose: true },
    );

    expect(text).toBe(
      lines(
        'MISMATCH 21/23  20240305120000_create_tasks.sql',
        '  MISSING    line 5   column public.tasks.due_on (date, nullable)',
        '  MISSING    line 18  index public.tasks_project_status_idx (on public.tasks (project_id, status), using btree)',
        '  SUPERSEDED line 19  index public.tasks_assignee_idx: dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 12',
        '  MATCH      line 3   enum type public.task_status',
        "  MATCH      line 3   enum value public.task_status.'todo'",
        "  MATCH      line 3   enum value public.task_status.'in_progress'",
        "  MATCH      line 3   enum value public.task_status.'done'",
        '  MATCH      line 5   table public.tasks',
        '  MATCH      line 5   column public.tasks.id',
        '  MATCH      line 5   primary key on public.tasks (id)',
        '  MATCH      line 5   column public.tasks.project_id',
        '  MATCH      line 5   foreign key on public.tasks (project_id)',
        '  MATCH      line 5   column public.tasks.title',
        '  MATCH      line 5   column public.tasks.status',
        '  MATCH      line 5   column public.tasks.priority',
        '  MATCH      line 5   check on public.tasks (priority)',
        '  MATCH      line 5   column public.tasks.assignee_id',
        '  MATCH      line 5   foreign key on public.tasks (assignee_id)',
        // integer here, numeric(6,2) since task_details_and_search: checked against the latter.
        '  MATCH      line 5   column public.tasks.estimate',
        '                      note: type updated by 20240315140000_task_details_and_search.sql line 7',
        '  MATCH      line 5   column public.tasks.created_at',
        '  MATCH      line 5   column public.tasks.updated_at',
        '  MATCH      line 21  trigger tasks_set_updated_at on public.tasks',
        '  MATCH      line 25  row level security on public.tasks',
        '  MATCH      line 27  policy "Members manage tasks" on public.tasks',
        `  history: recorded in ${HISTORY_TABLE}`,
      ),
    );
    expect(structured.migration).toMatchObject({
      verdict: 'MISMATCH',
      matched: 21,
      checked: 23,
      superseded: 1,
      unverifiable: 0,
      recorded: true,
    });
    expect(structured.checks).toHaveLength(24);
    expect(structured.migration.problems.map((p) => p.expected)).toEqual([
      'column public.tasks.due_on (date, nullable)',
      'index public.tasks_project_status_idx (on public.tasks (project_id, status), using btree)',
    ]);
  });

  it('diff_history lists every version on either side and explains each discrepancy', async () => {
    const { text, structured } = await call<DiffHistoryOutput>(scenario.client, 'diff_history');

    expect(text).toBe(
      lines(
        `History: 8 migration files, 5 recorded in ${HISTORY_TABLE}`,
        '  STATUS        VERSION         REPO NAME                        RECORDED NAME',
        '  only in db    20240215000000  -                                bootstrap_extensions',
        '  in both       20240301090000  create_organizations             create_organizations',
        '  name differs  20240301091500  create_profiles_and_memberships  create_profiles',
        '  only in repo  20240302100000  create_projects                  -',
        '  in both       20240305120000  create_tasks                     create_tasks',
        '  only in repo  20240310083000  create_comments                  -',
        '  in both       20240315140000  task_details_and_search          task_details_and_search',
        '  only in repo  20240320090000  rework_profiles_and_tasks        -',
        '  only in repo  20240322100000  seed_plans                       -',
        'Summary: 4 in both (1 with a different name), 4 only in repo, 1 only in database.',
        'only in repo: not recorded as applied (pending, or run by hand without recording); verify_migration shows whether its objects exist anyway.',
        'only in db: recorded as applied but no file has that version (deleted, renamed, or applied from another branch).',
        'name differs: same version, different name; the file was probably renamed after it was applied.',
      ),
    );
    expect(structured.diff?.agree).toBe(false);
    expect(structured.diff?.onlyInRepo.map((f) => f.version)).toEqual([
      '20240302100000',
      '20240310083000',
      '20240320090000',
      '20240322100000',
    ]);
    expect(structured.diff?.onlyInDatabase).toEqual([
      { version: '20240215000000', name: 'bootstrap_extensions' },
    ]);
    expect(structured.diff?.inBoth.filter((b) => b.nameMatches === false)).toEqual([
      {
        version: '20240301091500',
        fileName: '20240301091500_create_profiles_and_memberships.sql',
        repoName: 'create_profiles_and_memberships',
        recordedName: 'create_profiles',
        nameMatches: false,
      },
    ]);
  });

  it('list_recorded_migrations shows the history table as recorded', async () => {
    const { text, structured } = await call<ListRecordedMigrationsOutput>(
      scenario.client,
      'list_recorded_migrations',
    );

    expect(text).toBe(
      lines(
        `5 migrations recorded in ${HISTORY_TABLE}`,
        '  VERSION         NAME',
        '  20240215000000  bootstrap_extensions',
        '  20240301090000  create_organizations',
        '  20240301091500  create_profiles',
        '  20240305120000  create_tasks',
        '  20240315140000  task_details_and_search',
      ),
    );
    expect(structured.history.status).toBe('ok');
    expect(structured.migrations).toEqual(
      PARTIAL_HISTORY.map(([version, name]) => ({ version, name })),
    );
  });

  it('expected_objects reads the enum out of the DO block', async () => {
    const { text, structured } = await call<ExpectedObjectsOutput>(
      scenario.client,
      'expected_objects',
      { file: '20240301090000_create_organizations.sql' },
    );

    // Statements: DO, 2 x CREATE TABLE, CREATE FUNCTION, CREATE TRIGGER. Statements inside the DO
    // block are reported at the DO statement's line.
    expect(text).toBe(
      lines(
        '20240301090000_create_organizations.sql: 5 statements, 23 expected objects, 0 notes',
        '',
        'Types (1)',
        '  present line 5   enum type public.member_role [inside DO block]',
        '',
        'Enum values (3)',
        "  present line 5   enum value public.member_role.'owner' [inside DO block]",
        "  present line 5   enum value public.member_role.'admin' [inside DO block]",
        "  present line 5   enum value public.member_role.'member' [inside DO block]",
        '',
        'Tables (2)',
        '  present line 18  table public.plans',
        '  present line 24  table public.organizations',
        '',
        'Columns (9)',
        '  present line 18  column public.plans.id (text, not null)',
        '  present line 18  column public.plans.name (text, not null)',
        '  present line 18  column public.plans.max_projects (integer, not null)',
        '  present line 24  column public.organizations.id (uuid, not null)',
        '  present line 24  column public.organizations.name (text, not null)',
        '  present line 24  column public.organizations.slug (text, not null)',
        '  present line 24  column public.organizations.plan_id (text, not null)',
        '  present line 24  column public.organizations.created_at (timestamp with time zone, not null)',
        '  present line 24  column public.organizations.updated_at (timestamp with time zone, not null)',
        '',
        'Constraints (6)',
        '  present line 18  primary key on public.plans (id)',
        '  present line 18  check on public.plans (max_projects)',
        '  present line 24  primary key on public.organizations (id)',
        '  present line 24  unique on public.organizations (slug)',
        '  present line 24  foreign key on public.organizations (plan_id) (references public.plans (id))',
        '  present line 24  constraint organizations_slug_format on public.organizations (check (slug))',
        '',
        'Functions (1)',
        '  present line 35  function public.set_updated_at()',
        '',
        'Triggers (1)',
        '  present line 47  trigger organizations_set_updated_at on public.organizations (BEFORE UPDATE, for each row, executes public.set_updated_at)',
      ),
    );
    expect(structured.statementCount).toBe(5);
    expect(structured.objects).toHaveLength(23);
    expect(structured.objects.filter((o) => o.inDoBlock).map((o) => o.key)).toEqual([
      'type:public.member_role',
      'enum_value:public.member_role.owner',
      'enum_value:public.member_role.admin',
      'enum_value:public.member_role.member',
    ]);
    expect(structured.notes).toEqual([]);
  });

  it('list_repo_migrations skips the misnamed draft and ignores the README', async () => {
    const { structured } = await call<ListRepoMigrationsOutput>(
      scenario.client,
      'list_repo_migrations',
    );

    expect(structured.directory).toBe('supabase/migrations');
    expect(structured.files.map((f) => [f.version, f.name])).toEqual(ALL_MIGRATIONS);
    expect(structured.skipped.map((s) => s.fileName)).toEqual(['add_billing_draft.sql']);
    expect(structured.duplicateVersions).toEqual([]);
  });

  it('leaves no connection or transaction open and writes nothing', async () => {
    const canary = async (): Promise<{ id: number; note: string }[]> =>
      (
        await scenario.db.admin.query<{ id: number; note: string }>(
          'SELECT id, note FROM public.canary ORDER BY id',
        )
      ).rows;
    const sessions = async (): Promise<{ state: string | null }[]> =>
      (
        await scenario.db.admin.query<{ state: string | null }>(
          'SELECT state FROM pg_stat_activity WHERE usename = $1 AND datname = $2',
          [READ_ONLY_ROLE, scenario.db.name],
        )
      ).rows;
    const before = await canary();
    expect(before).toHaveLength(3);

    // The probe sees a session of the role that is left in a transaction, so an empty result
    // below is meaningful.
    const leaked = new pg.Client({ connectionString: scenario.readOnlyUrl });
    await leaked.connect();
    await leaked.query('BEGIN READ ONLY');
    await vi.waitFor(async () => {
      expect(await sessions()).toEqual([{ state: 'idle in transaction' }]);
    });
    await leaked.end();

    for (const [name, args] of [
      ['list_repo_migrations', {}],
      ['list_recorded_migrations', {}],
      ['diff_history', {}],
      ['expected_objects', { file: 'create_tasks' }],
      ['verify_migration', { file: 'create_comments', verbose: true }],
      ['verify_all', { verbose: true }],
    ] as const) {
      await call(scenario.client, name, args);
    }

    // The MCP client is still connected: the server holds no connection between tool calls.
    // A backend can take a moment to leave pg_stat_activity after its client disconnected.
    await vi.waitFor(
      async () => {
        expect(await sessions()).toEqual([]);
      },
      { timeout: 5_000, interval: 50 },
    );
    expect(await canary()).toEqual(before);
  });
});

describe('scenario 2: everything applied and recorded', () => {
  let scenario: Scenario;
  beforeAll(async () => {
    scenario = await startScenario(async (admin) => {
      await applySql(admin, historySql(ALL_MIGRATIONS));
    });
  });
  afterAll(async () => {
    await scenario.close();
  });

  it('verify_all: every migration MATCH except the data-only one', async () => {
    const { text, structured } = await call<VerifyAllOutput>(scenario.client, 'verify_all');

    // Same counts as scenario 1 without the hand edits: create_tasks 23/23, create_comments
    // 14/14, task_details_and_search 6/6. No MISMATCH, so no detailed reports follow.
    expect(text).toBe(
      lines(
        'VERSION         NAME                             RESULT             MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240301090000  create_organizations             MATCH              23/23    0           0             recorded',
        '20240301091500  create_profiles_and_memberships  MATCH              20/20    1           0             recorded',
        '20240302100000  create_projects                  MATCH              18/18    0           0             recorded',
        '20240305120000  create_tasks                     MATCH              23/23    1           0             recorded',
        '20240310083000  create_comments                  MATCH              14/14    9           2             recorded',
        '20240315140000  task_details_and_search          MATCH              6/6      0           1             recorded',
        '20240320090000  rework_profiles_and_tasks        MATCH              6/6      0           0             recorded',
        '20240322100000  seed_plans                       NOTHING TO VERIFY  -        0           2             recorded',
        '',
        '8 migrations: 7 MATCH, 0 MISMATCH, 1 nothing to verify.',
        SKIPPED_WARNING,
      ),
    );
    expect(structured.totals).toEqual({
      migrations: 8,
      match: 7,
      mismatch: 0,
      nothingToVerify: 1,
      appliedNotRecorded: 0,
      recordedButMismatch: 0,
    });
    expect(structured.migrations.every((m) => m.problems.length === 0 && m.recorded)).toBe(true);
  });

  it('verify_migration: drops and renames count as matches once the objects are gone', async () => {
    const { text, structured } = await call<VerifyMigrationOutput>(
      scenario.client,
      'verify_migration',
      { file: 'rework_profiles_and_tasks', verbose: true },
    );

    // The policy was dropped and re-created in the same file: one expectation, with the new roles.
    expect(text).toBe(
      lines(
        'MATCH 6/6  20240320090000_rework_profiles_and_tasks.sql',
        '  MATCH line 5   policy "Profiles are visible to signed-in users" on public.profiles',
        '  MATCH line 9   column public.profiles.display_name: dropped or renamed here, and no longer exists',
        '  MATCH line 9   column public.profiles.full_name',
        '  MATCH line 12  index public.tasks_assignee_idx: dropped or renamed here, and no longer exists',
        '  MATCH line 13  index public.tasks_open_by_assignee_idx',
        '  MATCH line 16  table public.task_events: dropped or renamed here, and no longer exists',
        `  history: recorded in ${HISTORY_TABLE}`,
      ),
    );
    expect(structured.checks.map((c) => [c.expect, c.status, c.expected])).toEqual([
      [
        'present',
        'match',
        'policy "Profiles are visible to signed-in users" on public.profiles (for SELECT, to anon, authenticated)',
      ],
      ['absent', 'match', 'column public.profiles.display_name'],
      ['present', 'match', 'column public.profiles.full_name'],
      ['absent', 'match', 'index public.tasks_assignee_idx'],
      [
        'present',
        'match',
        'index public.tasks_open_by_assignee_idx (on public.tasks (assignee_id), using btree)',
      ],
      ['absent', 'match', 'table public.task_events'],
    ]);
  });

  it('diff_history: repository and history agree', async () => {
    const { text, structured } = await call<DiffHistoryOutput>(scenario.client, 'diff_history');

    expect(text).toBe(
      lines(
        `History: 8 migration files, 8 recorded in ${HISTORY_TABLE}`,
        '  STATUS   VERSION         REPO NAME                        RECORDED NAME',
        '  in both  20240301090000  create_organizations             create_organizations',
        '  in both  20240301091500  create_profiles_and_memberships  create_profiles_and_memberships',
        '  in both  20240302100000  create_projects                  create_projects',
        '  in both  20240305120000  create_tasks                     create_tasks',
        '  in both  20240310083000  create_comments                  create_comments',
        '  in both  20240315140000  task_details_and_search          task_details_and_search',
        '  in both  20240320090000  rework_profiles_and_tasks        rework_profiles_and_tasks',
        '  in both  20240322100000  seed_plans                       seed_plans',
        'Summary: 8 in both, 0 only in repo, 0 only in database.',
        'Repository and recorded history agree.',
      ),
    );
    expect(structured.diff?.agree).toBe(true);
  });
});

describe('scenario 3: no history table at all', () => {
  let scenario: Scenario;
  beforeAll(async () => {
    scenario = await startScenario(() => Promise.resolve());
  });
  afterAll(async () => {
    await scenario.close();
  });

  it('verify_all still checks every object, with history shown as unavailable', async () => {
    const { text, structured } = await call<VerifyAllOutput>(scenario.client, 'verify_all');

    expect(text).toBe(
      lines(
        'VERSION         NAME                             RESULT             MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY',
        '20240301090000  create_organizations             MATCH              23/23    0           0             -',
        '20240301091500  create_profiles_and_memberships  MATCH              20/20    1           0             -',
        '20240302100000  create_projects                  MATCH              18/18    0           0             -',
        '20240305120000  create_tasks                     MATCH              23/23    1           0             -',
        '20240310083000  create_comments                  MATCH              14/14    9           2             -',
        '20240315140000  task_details_and_search          MATCH              6/6      0           1             -',
        '20240320090000  rework_profiles_and_tasks        MATCH              6/6      0           0             -',
        '20240322100000  seed_plans                       NOTHING TO VERIFY  -        0           2             -',
        '',
        '8 migrations: 7 MATCH, 0 MISMATCH, 1 nothing to verify. History unavailable.',
        `History: ${HISTORY_TABLE} does not exist, so whether each migration was recorded is unknown. The object checks do not depend on it.`,
        SKIPPED_WARNING,
      ),
    );
    expect(structured.history).toEqual({ table: HISTORY_TABLE, status: 'missing', reason: null });
    expect(structured.totals).toMatchObject({ match: 7, mismatch: 0, nothingToVerify: 1 });
    expect(structured.migrations.every((m) => m.recorded === null)).toBe(true);
  });

  it('list_recorded_migrations explains that there is no history', async () => {
    const { text, structured } = await call<ListRecordedMigrationsOutput>(
      scenario.client,
      'list_recorded_migrations',
    );

    expect(text).toBe(
      `${HISTORY_TABLE} does not exist in this database: history cannot be compared; ` +
        'use verify_all to check objects directly.',
    );
    expect(structured).toEqual({
      history: { table: HISTORY_TABLE, status: 'missing', reason: null },
      migrations: [],
    });
  });
});
