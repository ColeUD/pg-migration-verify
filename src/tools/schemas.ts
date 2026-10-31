/**
 * Input and output schemas of the MCP tools, in zod v4 (what the MCP SDK validates with and turns
 * into the JSON Schema clients see).
 *
 * The text content of a tool result is written for reading; `structuredContent` carries the same
 * facts as data, so an agent can branch on a verdict or count problems without parsing the text.
 * Every output schema is rooted at `z.object`, as the MCP spec requires for `outputSchema`, and the
 * SDK checks each result against it before sending it.
 */
import * as z from 'zod/v4';
import type {
  CheckStatus,
  Expectation,
  MigrationVerdict,
  Note,
  ObjectKind,
  RecordedHistory,
} from '../model.js';

/**
 * `z.enum` built from a record keyed by every member of a model union, so a member added to the
 * model without being listed here is a compile error rather than a runtime validation failure.
 */
function enumOf<T extends string>(members: Record<T, true>): z.ZodEnum<{ [K in T]: K }> {
  return z.enum(Object.keys(members) as [T, ...T[]]);
}

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

const dir = z
  .string()
  .optional()
  .describe(
    'Migrations directory. Relative paths are resolved against the project directory. ' +
      'Omit to use the configured directory (PGMV_MIGRATIONS_DIR, default supabase/migrations).',
  );

const file = z
  .string()
  .min(1)
  .describe(
    'The migration: its file name (20240101120000_create_profiles.sql), a path ending in it, ' +
      'its version (20240101120000) or its name (create_profiles). Only exact matches count.',
  );

const verbose = z
  .boolean()
  .optional()
  .describe(
    'Also list objects that match and statements that were ignored. Default false: only ' +
      'problems, superseded objects and unverifiable statements are listed.',
  );

export const listRepoMigrationsInput = z.object({ dir });
export const listRecordedMigrationsInput = z.object({});
export const diffHistoryInput = z.object({ dir });
export const expectedObjectsInput = z.object({ file, dir });
export const verifyMigrationInput = z.object({ file, dir, verbose });
export const verifyAllInput = z.object({ dir, verbose });

export type ListRepoMigrationsInput = z.output<typeof listRepoMigrationsInput>;
export type DiffHistoryInput = z.output<typeof diffHistoryInput>;
export type ExpectedObjectsInput = z.output<typeof expectedObjectsInput>;
export type VerifyMigrationInput = z.output<typeof verifyMigrationInput>;
export type VerifyAllInput = z.output<typeof verifyAllInput>;

// ---------------------------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------------------------

const objectKind = enumOf<ObjectKind>({
  schema: true,
  extension: true,
  table: true,
  view: true,
  materialized_view: true,
  sequence: true,
  column: true,
  index: true,
  constraint: true,
  function: true,
  trigger: true,
  rls: true,
  policy: true,
  type: true,
  enum_value: true,
});

const line = z.number().int().describe('1-based line in the migration file');
const inDoBlock = z
  .boolean()
  .describe('True when the statement sits inside a DO block, so it may be conditional');

const directory = z
  .string()
  .describe('Migrations directory, relative to the project directory when it is inside it');

const historyInfo = z
  .object({
    table: z.string().describe('The history table, supabase_migrations.schema_migrations'),
    status: enumOf<RecordedHistory['status']>({ ok: true, missing: true, not_readable: true }),
    reason: z
      .string()
      .nullable()
      .describe('Why the table cannot be read (status not_readable), otherwise null'),
  })
  .describe('Whether the recorded migration history could be read');

const noteEntry = z.object({
  category: enumOf<Note['category']>({ unverifiable: true, ignored: true }),
  statementType: z.string().describe('Postgres parse node, e.g. DoStmt, GrantStmt, ParseError'),
  reason: z.string(),
  line,
  inDoBlock,
  excerpt: z.string().describe('The statement, whitespace-collapsed and truncated'),
});

const checkEntry = z.object({
  status: enumOf<CheckStatus>({
    match: true,
    missing: true,
    different: true,
    unexpected: true,
    superseded: true,
  }),
  object: z.string().describe('The object, e.g. column public.todos.due_date'),
  expect: enumOf<Expectation>({ present: true, absent: true }).describe(
    'present: the object should exist; absent: the migration drops or renames it away, so ' +
      'status match means it is gone',
  ),
  expected: z
    .string()
    .describe('The object with the attributes the migration asserts, e.g. (date, nullable)'),
  kind: objectKind,
  key: z.string().describe('Stable identity of the object'),
  line,
  inDoBlock,
  differences: z
    .array(z.object({ attribute: z.string(), expected: z.string(), actual: z.string() }))
    .describe('For status different: each attribute that differs'),
  notes: z.array(z.string()).describe('E.g. attributes whose expected value a later file changed'),
  supersededBy: z
    .object({ file: z.string(), reason: z.string() })
    .nullable()
    .describe('For status superseded: the later migration that drops or renames the object'),
});

const migrationEntry = z.object({
  version: z.string(),
  name: z.string(),
  file: z.string(),
  verdict: enumOf<MigrationVerdict>({ MATCH: true, MISMATCH: true, NOTHING_TO_VERIFY: true }),
  matched: z.number().int(),
  checked: z.number().int().describe('Objects checked; superseded objects are not counted'),
  superseded: z.number().int(),
  unverifiable: z.number().int().describe('Statements that cannot be checked against the catalog'),
  recorded: z
    .boolean()
    .nullable()
    .describe('Whether the history table records this version; null when it cannot be read'),
  problems: z.array(checkEntry).describe('Checks with status missing, different or unexpected'),
});

// ---------------------------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------------------------

export const listRepoMigrationsOutput = z.object({
  directory,
  files: z.array(
    z.object({
      version: z.string(),
      name: z.string(),
      fileName: z.string(),
      checksum: z.string().describe('sha256 of the file bytes, lowercase hex'),
    }),
  ),
  skipped: z
    .array(z.object({ fileName: z.string(), reason: z.string() }))
    .describe('.sql files the Supabase CLI never applies because of their name'),
  duplicateVersions: z.array(z.string()).describe('Versions used by more than one file'),
});

export const listRecordedMigrationsOutput = z.object({
  history: historyInfo,
  migrations: z
    .array(z.object({ version: z.string(), name: z.string().nullable() }))
    .describe('Recorded versions, sorted; empty unless history.status is ok'),
});

export const diffHistoryOutput = z.object({
  directory,
  history: historyInfo,
  diff: z
    .object({
      agree: z.boolean().describe('True when every version is on both sides with the same name'),
      inBoth: z.array(
        z.object({
          version: z.string(),
          fileName: z.string(),
          repoName: z.string(),
          recordedName: z.string().nullable(),
          nameMatches: z
            .boolean()
            .nullable()
            .describe('null when the history row has no name (older Supabase CLI)'),
        }),
      ),
      onlyInRepo: z
        .array(z.object({ version: z.string(), name: z.string(), fileName: z.string() }))
        .describe('Not recorded as applied: pending, or applied by hand without recording'),
      onlyInDatabase: z
        .array(z.object({ version: z.string(), name: z.string().nullable() }))
        .describe('Recorded as applied, but no file has that version'),
    })
    .nullable()
    .describe('null when the history table is missing or cannot be read'),
});

export const expectedObjectsOutput = z.object({
  file: z.string(),
  statementCount: z.number().int(),
  objects: z.array(
    z.object({
      kind: objectKind,
      key: z.string(),
      expect: enumOf<Expectation>({ present: true, absent: true }).describe(
        'present: the migration leaves the object existing; absent: it drops or renames it away',
      ),
      description: z.string(),
      line,
      inDoBlock,
    }),
  ),
  notes: z.array(noteEntry).describe('Statements that are not turned into catalog checks'),
});

export const verifyMigrationOutput = z.object({
  migration: migrationEntry,
  checks: z.array(checkEntry).describe('Every check of this migration, matching ones included'),
  notes: z.array(noteEntry),
  history: historyInfo,
});

export const verifyAllOutput = z.object({
  directory,
  history: historyInfo,
  totals: z.object({
    migrations: z.number().int(),
    match: z.number().int(),
    mismatch: z.number().int(),
    nothingToVerify: z.number().int(),
    appliedNotRecorded: z
      .number()
      .int()
      .describe('MATCH, but the history table does not record the version (applied by hand)'),
    recordedButMismatch: z
      .number()
      .int()
      .describe('Recorded as applied in the history table, but MISMATCH'),
  }),
  migrations: z.array(migrationEntry),
});

export type HistoryInfo = z.output<typeof historyInfo>;
export type NoteEntry = z.output<typeof noteEntry>;
export type CheckEntry = z.output<typeof checkEntry>;
export type MigrationEntry = z.output<typeof migrationEntry>;
export type ListRepoMigrationsOutput = z.output<typeof listRepoMigrationsOutput>;
export type ListRecordedMigrationsOutput = z.output<typeof listRecordedMigrationsOutput>;
export type DiffHistoryOutput = z.output<typeof diffHistoryOutput>;
export type ExpectedObjectsOutput = z.output<typeof expectedObjectsOutput>;
export type VerifyMigrationOutput = z.output<typeof verifyMigrationOutput>;
export type VerifyAllOutput = z.output<typeof verifyAllOutput>;
