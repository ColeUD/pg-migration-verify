/**
 * The MCP surface: six read-only tools over the parser, catalog and verify modules.
 *
 * Descriptions are written for the model that decides which tool to call: what the tool does,
 * when to use it, and what its output words mean. Handlers live in src/tools; this module only
 * registers them and turns their results (or errors) into MCP tool results.
 */
import { McpServer, type CallToolResult, type ToolAnnotations } from '@modelcontextprotocol/server';
import { DatabaseError, redactSecrets } from './catalog/index.js';
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';
import type { ToolContext, ToolResult } from './tools/context.js';
import { compareHistory } from './tools/diff-history.js';
import { expectedObjects } from './tools/expected-objects.js';
import { listRecordedMigrations } from './tools/list-recorded-migrations.js';
import { listRepoMigrations } from './tools/list-repo-migrations.js';
import {
  diffHistoryInput,
  diffHistoryOutput,
  expectedObjectsInput,
  expectedObjectsOutput,
  listRecordedMigrationsInput,
  listRecordedMigrationsOutput,
  listRepoMigrationsInput,
  listRepoMigrationsOutput,
  verifyAllInput,
  verifyAllOutput,
  verifyMigrationInput,
  verifyMigrationOutput,
} from './tools/schemas.js';
import { verifyAll } from './tools/verify-all.js';
import { verifyMigration } from './tools/verify-migration.js';

/** Every tool only reads files and pg_catalog, so hosts may run them without asking. */
const READ_ONLY: ToolAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const READ_ONLY_TEXT =
  'Read-only: it reads migration files and pg_catalog inside a READ ONLY transaction, and never ' +
  'runs migration SQL or writes anything.';

const NEEDS_DATABASE =
  'Needs a database URL (PGMV_DATABASE_URL or DATABASE_URL); without one it returns an error ' +
  'saying how to configure it.';

const LEGEND =
  'Meaning of the output: MATCH = every object the migration should leave behind exists as ' +
  'written. MISMATCH = at least one object is MISSING (not found), DIFFERENT (found with other ' +
  'attributes, e.g. type or nullability) or UNEXPECTED (dropped or renamed by the migration but ' +
  'still there). NOTHING TO VERIFY = no statement yields a catalog check. SUPERSEDED = a later ' +
  'migration drops or renames the object, so it is checked there instead; not a problem. ' +
  'UNVERIFIABLE = a statement that cannot be checked against the catalog (DO blocks, GRANTs, ' +
  'data changes); review it by hand.';

const SERVER_INSTRUCTIONS =
  'Checks whether Postgres/Supabase migrations were really applied, by comparing what each ' +
  'migration file should create, alter or drop with the live pg_catalog. The history table ' +
  '(supabase_migrations.schema_migrations) is often out of sync when migrations are pasted into ' +
  'the SQL editor, so verify objects instead of trusting it. Start with verify_all, or ' +
  'verify_migration for one file; diff_history compares files with the recorded history. All ' +
  'tools are read-only.';

/** Creates the server with all six tools registered against `context`. */
export function createServer(context: ToolContext): McpServer {
  const server = new McpServer(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    'list_repo_migrations',
    {
      title: 'List repository migrations',
      description:
        'List the migration files in the repository (Supabase layout <version>_<name>.sql), ' +
        'sorted by version, with the sha256 of each file. Also reports .sql files the Supabase ' +
        'CLI would skip because of their name and versions used by more than one file. Use it to ' +
        'see which migrations exist or to find the exact file name for the other tools. Needs no ' +
        `database. ${READ_ONLY_TEXT}`,
      inputSchema: listRepoMigrationsInput,
      outputSchema: listRepoMigrationsOutput,
      annotations: READ_ONLY,
    },
    (input) => respond(context, () => listRepoMigrations(context, input)),
  );

  server.registerTool(
    'list_recorded_migrations',
    {
      title: 'List recorded migrations',
      description:
        'Show which migration versions the Supabase CLI recorded as applied in ' +
        'supabase_migrations.schema_migrations. A missing or unreadable table is reported in the ' +
        "result (history.status 'missing' or 'not_readable', with the grants needed), not as an " +
        'error. This list is bookkeeping, not proof: migrations pasted into the SQL editor are ' +
        'never recorded, and a recorded one may be incomplete. Use verify_migration or ' +
        `verify_all to see whether objects exist. ${READ_ONLY_TEXT} ${NEEDS_DATABASE}`,
      inputSchema: listRecordedMigrationsInput,
      outputSchema: listRecordedMigrationsOutput,
      annotations: READ_ONLY,
    },
    () => respond(context, () => listRecordedMigrations(context)),
  );

  server.registerTool(
    'diff_history',
    {
      title: 'Compare files with recorded history',
      description:
        'Compare the repository migration files with the recorded history table by version: ' +
        'only in repo (not recorded: pending, or applied by hand without recording), only in ' +
        'database (recorded, but no file has that version: deleted, renamed or from another ' +
        'branch) and in both (a different name is flagged). Compares bookkeeping only, not ' +
        'database objects: follow up with verify_migration for versions only in the repo. ' +
        `${READ_ONLY_TEXT} ${NEEDS_DATABASE}`,
      inputSchema: diffHistoryInput,
      outputSchema: diffHistoryOutput,
      annotations: READ_ONLY,
    },
    (input) => respond(context, () => compareHistory(context, input)),
  );

  server.registerTool(
    'expected_objects',
    {
      title: 'Show what a migration should create',
      description:
        'Parse one migration with the real Postgres parser and list what it should leave in the ' +
        'database: schemas, tables, columns (type, nullability), indexes, constraints, functions, ' +
        'triggers, row level security, policies, types and enum values, each with its line, ' +
        'plus statements that cannot be checked (UNVERIFIABLE) or have no lasting effect ' +
        '(ignored, e.g. BEGIN or SET). Never connects to a database. Use it to review a ' +
        'migration before applying it, or to understand a verify_migration result. ' +
        READ_ONLY_TEXT,
      inputSchema: expectedObjectsInput,
      outputSchema: expectedObjectsOutput,
      annotations: READ_ONLY,
    },
    (input) => respond(context, () => expectedObjects(context, input)),
  );

  server.registerTool(
    'verify_migration',
    {
      title: 'Verify one migration',
      description:
        'Check whether one migration was really applied by comparing every object it should ' +
        'create, alter or drop with the live Postgres catalog, independently of the history ' +
        'table. Use it after applying a migration (e.g. by pasting it into the Supabase SQL ' +
        'editor) or whenever it is unclear whether a migration ran. Reports MATCH n/n or ' +
        'MISMATCH n/n with every problem object and the line it comes from, and whether the ' +
        `version is recorded in supabase_migrations.schema_migrations. ${LEGEND} ` +
        `${READ_ONLY_TEXT} ${NEEDS_DATABASE}`,
      inputSchema: verifyMigrationInput,
      outputSchema: verifyMigrationOutput,
      annotations: READ_ONLY,
    },
    (input) => respond(context, () => verifyMigration(context, input)),
  );

  server.registerTool(
    'verify_all',
    {
      title: 'Verify all migrations',
      description:
        'Check every repository migration against the live Postgres catalog. Returns a summary ' +
        'table (per migration: verdict, matched/checked, superseded, unverifiable, recorded in ' +
        'history) and the full report of each MISMATCH. The totals call out migrations applied ' +
        'but not recorded in history and migrations recorded but not fully applied. Use it for ' +
        'the whole picture or before a deploy; use verify_migration for one file. ' +
        `${LEGEND} ${READ_ONLY_TEXT} ${NEEDS_DATABASE}`,
      inputSchema: verifyAllInput,
      outputSchema: verifyAllOutput,
      annotations: READ_ONLY,
    },
    (input) => respond(context, () => verifyAll(context, input)),
  );

  return server;
}

/**
 * Runs a handler and converts the outcome. Failures become `isError` results rather than thrown
 * exceptions, so the model sees an explanation it can act on.
 */
async function respond(
  context: ToolContext,
  work: () => Promise<ToolResult<Record<string, unknown>>>,
): Promise<CallToolResult> {
  try {
    const { text, structured } = await work();
    return { content: [{ type: 'text', text }], structuredContent: structured };
  } catch (error) {
    return {
      isError: true,
      content: [{ type: 'text', text: errorText(error, context.config.databaseUrl) }],
    };
  }
}

/**
 * The message of a failed tool call. Catalog errors are already sanitized and other errors come
 * from file handling, but the connection string is redacted from every message regardless: it is
 * the one secret the server holds, and this is the last place to catch a leak.
 */
export function errorText(error: unknown, databaseUrl: string | null): string {
  const message =
    error instanceof DatabaseError
      ? `Database error: ${error.message}`
      : error instanceof Error
        ? error.message
        : 'Unexpected error.';
  return redactSecrets(message, databaseUrl ?? '');
}
