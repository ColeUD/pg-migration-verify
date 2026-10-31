/**
 * Shared data model. Every other module speaks in these types:
 *
 *   parser   : SQL text            -> ParsedMigration (ExpectedObject[] + Note[])
 *   catalog  : live database       -> CatalogSnapshot (what actually exists)
 *   verify   : expected + snapshot -> MigrationReport
 *   server   : reports             -> MCP tool results
 *
 * Naming conventions used throughout:
 * - Identifiers are stored exactly as Postgres stores them: unquoted names lower-cased,
 *   quoted names verbatim and without quotes.
 * - Type names use `format_type()` spelling, e.g. `integer`, `character varying(255)`,
 *   `timestamp with time zone`, `text[]`. User-defined types keep their schema only when
 *   the migration wrote one (`public.job_status`); otherwise they stay bare (`job_status`).
 */

/** Where an expected object or note came from. */
export interface SourceRef {
  /** Migration file name, e.g. `20240101120000_create_profiles.sql`. */
  file: string;
  /** 0-based index of the top-level statement in the file. */
  statementIndex: number;
  /** 1-based line where the statement starts. */
  line: number;
  /** The statement text, whitespace-collapsed and truncated to ~160 characters. */
  excerpt: string;
  /** True when the statement was found inside a `DO $$ ... $$` block (it may be conditional). */
  inDoBlock?: boolean;
}

/** Whether the migration leaves the object existing (`present`) or removes it (`absent`). */
export type Expectation = 'present' | 'absent';

export type ObjectKind =
  | 'schema'
  | 'extension'
  | 'table'
  | 'view'
  | 'materialized_view'
  | 'sequence'
  | 'column'
  | 'index'
  | 'constraint'
  | 'function'
  | 'trigger'
  | 'rls'
  | 'policy'
  | 'type'
  | 'enum_value';

interface ObjectBase {
  /** Stable identity, see `objectKey()` in keys.ts. Same key = same database object. */
  key: string;
  expect: Expectation;
  /** Schema the object lives in. For `schema` objects this is the schema's own name. */
  schema: string;
  source: SourceRef;
}

export interface SchemaObject extends ObjectBase {
  kind: 'schema';
  name: string;
}

export interface ExtensionObject extends ObjectBase {
  kind: 'extension';
  name: string;
}

/** Tables, views, materialized views and sequences: existence only. */
export interface RelationObject extends ObjectBase {
  kind: 'table' | 'view' | 'materialized_view' | 'sequence';
  name: string;
}

export interface ColumnObject extends ObjectBase {
  kind: 'column';
  table: string;
  name: string;
  /** Normalized type, or null when this statement does not assert one (e.g. `SET NOT NULL`). */
  dataType: string | null;
  /** null when this statement does not assert nullability. */
  notNull: boolean | null;
}

export interface IndexObject extends ObjectBase {
  kind: 'index';
  table: string;
  /** null for `CREATE INDEX ON t (...)` without a name; matched by table + columns instead. */
  name: string | null;
  unique: boolean | null;
  /** Access method, e.g. `btree`, `gin`. null = not asserted. */
  method: string | null;
  /** Key columns in order: plain column names, expressions as deparsed SQL wrapped in parentheses. */
  columns: string[] | null;
}

export type ConstraintType = 'primary_key' | 'unique' | 'foreign_key' | 'check' | 'exclusion';

export interface ConstraintObject extends ObjectBase {
  kind: 'constraint';
  table: string;
  /** null when the migration did not name it; matched by table + type + columns instead. */
  name: string | null;
  constraintType: ConstraintType | null;
  /** Constrained columns (for a check constraint: the columns its expression references). */
  columns: string[] | null;
  /** For foreign keys only. */
  references: { schema: string; table: string; columns: string[] | null } | null;
}

export interface FunctionObject extends ObjectBase {
  kind: 'function';
  name: string;
  /**
   * Identity argument types (IN, INOUT and VARIADIC; never OUT or TABLE), normalized and without
   * typmods, exactly like `format_type(t, NULL)` per element of `pg_proc.proargtypes`.
   * null only for an `absent` expectation written without an argument list (`DROP FUNCTION f`).
   */
  argTypes: string[] | null;
  isProcedure: boolean;
}

export type TriggerEvent = 'INSERT' | 'UPDATE' | 'DELETE' | 'TRUNCATE';

export interface TriggerObject extends ObjectBase {
  kind: 'trigger';
  table: string;
  name: string;
  timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF' | null;
  /** Sorted in the order INSERT, UPDATE, DELETE, TRUNCATE. */
  events: TriggerEvent[] | null;
  forEachRow: boolean | null;
  /** Function the trigger executes, schema as written (null schema = unqualified). */
  function: { schema: string | null; name: string } | null;
}

/** Row level security switch on a table (`ALTER TABLE ... ENABLE/DISABLE/FORCE ROW LEVEL SECURITY`). */
export interface RlsObject extends ObjectBase {
  kind: 'rls';
  table: string;
  /** null when only FORCE/NO FORCE was stated. */
  enabled: boolean | null;
  /** null when only ENABLE/DISABLE was stated. */
  forced: boolean | null;
}

export type PolicyCommand = 'ALL' | 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE';

export interface PolicyObject extends ObjectBase {
  kind: 'policy';
  table: string;
  name: string;
  command: PolicyCommand | null;
  permissive: boolean | null;
  /** Role names, sorted. `public` stands for PUBLIC (no TO clause). */
  roles: string[] | null;
  /** Deparsed USING / WITH CHECK expressions, for display only. Never string-compared. */
  using: string | null;
  withCheck: string | null;
}

export type TypeKind = 'enum' | 'composite' | 'domain' | 'range' | 'other';

export interface TypeObject extends ObjectBase {
  kind: 'type';
  name: string;
  typeKind: TypeKind | null;
}

export interface EnumValueObject extends ObjectBase {
  kind: 'enum_value';
  /** The enum type's name (its schema is `schema`). */
  typeName: string;
  value: string;
}

export type ExpectedObject =
  | SchemaObject
  | ExtensionObject
  | RelationObject
  | ColumnObject
  | IndexObject
  | ConstraintObject
  | FunctionObject
  | TriggerObject
  | RlsObject
  | PolicyObject
  | TypeObject
  | EnumValueObject;

/**
 * A statement the parser understood but cannot turn into catalog checks (`unverifiable`), or
 * deliberately skips because it has no lasting schema effect (`ignored`: BEGIN/COMMIT, SET, ...).
 * Nothing in a migration is silently dropped: every statement yields objects, notes, or both.
 */
export interface Note {
  category: 'unverifiable' | 'ignored';
  /** libpg-query node name, e.g. `DoStmt`, `GrantStmt`, or `ParseError`. */
  statementType: string;
  reason: string;
  source: SourceRef;
}

export interface ParsedMigration {
  file: string;
  /** Net expectations after applying the file's statements in order (one entry per key). */
  objects: ExpectedObject[];
  notes: Note[];
  statementCount: number;
}

// ---------------------------------------------------------------------------------------------
// Repository files and recorded history
// ---------------------------------------------------------------------------------------------

export interface MigrationFile {
  /** Leading digits of the file name (Supabase uses a 14-digit timestamp). */
  version: string;
  /** Rest of the file name without the extension, e.g. `create_profiles`. */
  name: string;
  fileName: string;
  /** Absolute path on disk. */
  path: string;
  /** sha256 of the file bytes, lowercase hex. */
  checksum: string;
}

export interface RecordedMigration {
  version: string;
  name: string | null;
}

export type RecordedHistory =
  | { status: 'ok'; table: string; migrations: RecordedMigration[] }
  | { status: 'missing'; table: string }
  | { status: 'not_readable'; table: string; reason: string };

// ---------------------------------------------------------------------------------------------
// What actually exists in the database (read from pg_catalog only)
// ---------------------------------------------------------------------------------------------

export type RelationKind =
  | 'table'
  | 'partitioned_table'
  | 'view'
  | 'materialized_view'
  | 'sequence'
  | 'foreign_table'
  | 'other';

export interface CatalogSnapshot {
  /** e.g. 170004 */
  serverVersionNum: number;
  /** Schemas the snapshot covers. Objects in other schemas are not loaded. */
  coveredSchemas: string[];
  schemas: string[];
  extensions: { name: string; schema: string }[];
  relations: {
    schema: string;
    name: string;
    kind: RelationKind;
    rlsEnabled: boolean;
    rlsForced: boolean;
  }[];
  columns: {
    schema: string;
    table: string;
    name: string;
    /** `format_type(atttypid, atttypmod)` with `search_path = ''` (user types schema-qualified). */
    dataType: string;
    notNull: boolean;
  }[];
  indexes: {
    schema: string;
    table: string;
    name: string;
    unique: boolean;
    primary: boolean;
    method: string;
    /** Key columns in order: plain column names, expressions as `(${pg_get_indexdef(oid, n, true)})`. */
    columns: string[];
  }[];
  constraints: {
    schema: string;
    table: string;
    name: string;
    type: ConstraintType;
    columns: string[];
    references: { schema: string; table: string; columns: string[] } | null;
  }[];
  functions: {
    schema: string;
    name: string;
    /** `format_type(t, NULL)` for each of `proargtypes`, with `search_path = ''`. */
    argTypes: string[];
    isProcedure: boolean;
  }[];
  triggers: {
    schema: string;
    table: string;
    name: string;
    timing: 'BEFORE' | 'AFTER' | 'INSTEAD OF';
    events: TriggerEvent[];
    forEachRow: boolean;
    function: { schema: string; name: string };
  }[];
  policies: {
    schema: string;
    table: string;
    name: string;
    command: PolicyCommand;
    permissive: boolean;
    roles: string[];
  }[];
  types: { schema: string; name: string; typeKind: TypeKind }[];
  enumValues: { schema: string; typeName: string; value: string }[];
}

// ---------------------------------------------------------------------------------------------
// Verification results
// ---------------------------------------------------------------------------------------------

/**
 * - `match`      : the object is as the migration (plus any later alterations) says.
 * - `missing`    : expected present, not found.
 * - `different`  : found, but an asserted attribute differs (see `differences`).
 * - `unexpected` : expected absent (dropped/renamed away), but still exists.
 * - `superseded` : a later migration drops or renames it, so it is not checked against this one.
 */
export type CheckStatus = 'match' | 'missing' | 'different' | 'unexpected' | 'superseded';

export interface Difference {
  attribute: string;
  expected: string;
  actual: string;
}

export interface ObjectCheck {
  object: ExpectedObject;
  status: CheckStatus;
  differences: Difference[];
  /** For `superseded`: the later migration responsible. */
  supersededBy?: { file: string; reason: string };
  /** Attributes whose expected value came from a later migration (e.g. `type changed by 0005`). */
  notes: string[];
}

export type MigrationVerdict = 'MATCH' | 'MISMATCH' | 'NOTHING_TO_VERIFY';

export interface MigrationReport {
  file: string;
  version: string;
  name: string;
  verdict: MigrationVerdict;
  /** Checks that count toward `matched / checked` (everything except `superseded`). */
  checked: number;
  matched: number;
  checks: ObjectCheck[];
  notes: Note[];
  /** Whether the version appears in the recorded history table (null = history unavailable). */
  recorded: boolean | null;
}
