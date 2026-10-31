/**
 * Every SQL statement the server sends to the database lives in this file (apart from the
 * transaction control statements in db.ts).
 *
 * `QueryRunner.run` accepts only `CatalogQuery` values, and the only way to make one is
 * `defineCatalogQuery`, which rejects anything that is not a single SELECT. So "the server never
 * runs user-supplied SQL" holds by construction: user input (schema names) only ever travels as
 * bind parameters. The read-only transaction in db.ts is the second, independent layer.
 *
 * All catalog reads go to `pg_catalog` and join `pg_class` to `pg_namespace` by name. Both
 * `information_schema` and `::regclass` casts depend on the connected role's privileges (they hide
 * objects or fail with 42501), while `pg_catalog` is readable by PUBLIC, so a role with no grants
 * at all still sees every object. `name`, `"char"` and array columns are cast to `text`/`text[]`
 * so node-pg always returns JS strings and string arrays.
 */

declare const rowType: unique symbol;

/**
 * A vetted, constant SELECT statement whose result rows have type `Row`. The brand property is
 * never present at runtime; it carries the row type and stops other modules from building a
 * `CatalogQuery` out of an arbitrary string.
 */
export interface CatalogQuery<Row> {
  /** Short stable name, used to identify the query in errors and tests. */
  readonly id: string;
  readonly text: string;
  readonly [rowType]: Row;
}

/**
 * Creates a `CatalogQuery`, throwing (at module load, since all queries are module constants)
 * unless `text` is one statement that starts with SELECT or WITH. A data-modifying CTE
 * (`WITH x AS (DELETE ...) SELECT ...`) passes this check; the read-only transaction stops it.
 *
 * @internal Exported for tests. Production queries are defined in this module only.
 */
export function defineCatalogQuery<Row>(id: string, text: string): CatalogQuery<Row> {
  const sql = text.trim();
  if (!/^(?:SELECT|WITH)\b/i.test(sql)) {
    throw new Error(`catalog query ${id} must start with SELECT or WITH`);
  }
  if (sql.includes(';')) {
    throw new Error(`catalog query ${id} must be a single statement without ';'`);
  }
  return Object.freeze({ id, text: sql }) as CatalogQuery<Row>;
}

// ---------------------------------------------------------------------------------------------
// Catalog snapshot. Every query except schemas/extensions takes $1 = text[] of covered schemas.
// ---------------------------------------------------------------------------------------------

export const SERVER_VERSION = defineCatalogQuery<{ version_num: number }>(
  'server_version',
  `SELECT current_setting('server_version_num')::int AS version_num`,
);

export const SCHEMAS = defineCatalogQuery<{ name: string }>(
  'schemas',
  `SELECT n.nspname::text AS name FROM pg_namespace n ORDER BY n.nspname`,
);

export const EXTENSIONS = defineCatalogQuery<{ name: string; schema: string }>(
  'extensions',
  `SELECT e.extname::text AS name, n.nspname::text AS schema
   FROM pg_extension e
   JOIN pg_namespace n ON n.oid = e.extnamespace
   ORDER BY e.extname`,
);

export interface RelationRow {
  schema: string;
  name: string;
  relkind: string;
  rls_enabled: boolean;
  rls_forced: boolean;
}

/** Everything in pg_class except indexes (i, I), composite types (c) and TOAST tables (t). */
export const RELATIONS = defineCatalogQuery<RelationRow>(
  'relations',
  `SELECT n.nspname::text AS schema, c.relname::text AS name, c.relkind::text AS relkind,
          c.relrowsecurity AS rls_enabled, c.relforcerowsecurity AS rls_forced
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY ($1::text[]) AND c.relkind NOT IN ('i', 'I', 'c', 't')
   ORDER BY n.nspname, c.relname`,
);

export interface ColumnRow {
  schema: string;
  table_name: string;
  name: string;
  data_type: string;
  not_null: boolean;
}

/** User columns of tables, views, materialized views and foreign tables. */
export const COLUMNS = defineCatalogQuery<ColumnRow>(
  'columns',
  `SELECT n.nspname::text AS schema, c.relname::text AS table_name, a.attname::text AS name,
          format_type(a.atttypid, a.atttypmod) AS data_type, a.attnotnull AS not_null
   FROM pg_attribute a
   JOIN pg_class c ON c.oid = a.attrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY ($1::text[])
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
     AND a.attnum > 0 AND NOT a.attisdropped
   ORDER BY n.nspname, c.relname, a.attnum`,
);

export interface IndexRow {
  schema: string;
  table_name: string;
  name: string;
  is_unique: boolean;
  is_primary: boolean;
  method: string;
  columns: string[];
}

/**
 * Key columns only (`indnkeyatts`, not INCLUDE columns). `indkey` is an int2vector, which is
 * 0-based; a 0 entry marks an expression, rendered by `pg_get_indexdef(oid, n, true)`.
 */
export const INDEXES = defineCatalogQuery<IndexRow>(
  'indexes',
  `SELECT n.nspname::text AS schema, t.relname::text AS table_name, i.relname::text AS name,
          x.indisunique AS is_unique, x.indisprimary AS is_primary, am.amname::text AS method,
          ARRAY(
            SELECT CASE
                     WHEN x.indkey[k.n - 1] <> 0 THEN (
                       SELECT a.attname::text FROM pg_attribute a
                       WHERE a.attrelid = x.indrelid AND a.attnum = x.indkey[k.n - 1])
                     ELSE '(' || pg_get_indexdef(x.indexrelid, k.n, true) || ')'
                   END
            FROM generate_series(1, x.indnkeyatts) AS k (n)
            ORDER BY k.n
          ) AS columns
   FROM pg_index x
   JOIN pg_class i ON i.oid = x.indexrelid
   JOIN pg_class t ON t.oid = x.indrelid
   JOIN pg_namespace n ON n.oid = t.relnamespace
   JOIN pg_am am ON am.oid = i.relam
   WHERE n.nspname = ANY ($1::text[])
   ORDER BY n.nspname, i.relname`,
);

export interface ConstraintRow {
  schema: string;
  table_name: string;
  name: string;
  contype: string;
  columns: string[];
  ref_schema: string | null;
  ref_table: string | null;
  ref_columns: string[];
}

/**
 * Table constraints of the five SQL kinds. PostgreSQL 18 also records NOT NULL as constraints
 * (contype 'n'); those are excluded because nullability is checked on the column. Domain
 * constraints have conrelid = 0 and drop out at the join to pg_class.
 */
export const CONSTRAINTS = defineCatalogQuery<ConstraintRow>(
  'constraints',
  `SELECT n.nspname::text AS schema, t.relname::text AS table_name, con.conname::text AS name,
          con.contype::text AS contype,
          ARRAY(
            SELECT a.attname::text
            FROM unnest(con.conkey) WITH ORDINALITY AS k (attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
            ORDER BY k.ord
          ) AS columns,
          rn.nspname::text AS ref_schema, rt.relname::text AS ref_table,
          ARRAY(
            SELECT a.attname::text
            FROM unnest(con.confkey) WITH ORDINALITY AS k (attnum, ord)
            JOIN pg_attribute a ON a.attrelid = con.confrelid AND a.attnum = k.attnum
            ORDER BY k.ord
          ) AS ref_columns
   FROM pg_constraint con
   JOIN pg_class t ON t.oid = con.conrelid
   JOIN pg_namespace n ON n.oid = t.relnamespace
   LEFT JOIN pg_class rt ON rt.oid = con.confrelid
   LEFT JOIN pg_namespace rn ON rn.oid = rt.relnamespace
   WHERE n.nspname = ANY ($1::text[]) AND con.contype IN ('p', 'u', 'f', 'c', 'x')
   ORDER BY n.nspname, t.relname, con.conname`,
);

export interface FunctionRow {
  schema: string;
  name: string;
  prokind: string;
  arg_types: string[];
}

/**
 * Functions and procedures (not aggregates or window functions) with their identity args.
 * Functions Postgres generates for a type (range and multirange constructors) carry an internal
 * ('i') dependency and are skipped: no migration creates them by name. The `::regclass` cast here
 * names a system catalog, which needs no privileges, unlike casts of user tables.
 */
export const FUNCTIONS = defineCatalogQuery<FunctionRow>(
  'functions',
  `SELECT n.nspname::text AS schema, p.proname::text AS name, p.prokind::text AS prokind,
          ARRAY(
            SELECT format_type(arg.type_oid, NULL)
            FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS arg (type_oid, ord)
            ORDER BY arg.ord
          ) AS arg_types
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = ANY ($1::text[]) AND p.prokind IN ('f', 'p')
     AND NOT EXISTS (
       SELECT 1 FROM pg_depend d
       WHERE d.classid = 'pg_catalog.pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'i'
     )
   ORDER BY n.nspname, p.proname`,
);

export interface TriggerRow {
  schema: string;
  table_name: string;
  name: string;
  tgtype: number;
  function_schema: string;
  function_name: string;
}

/** User triggers; internal ones (e.g. those enforcing foreign keys) are excluded. */
export const TRIGGERS = defineCatalogQuery<TriggerRow>(
  'triggers',
  `SELECT n.nspname::text AS schema, c.relname::text AS table_name, tg.tgname::text AS name,
          tg.tgtype::int AS tgtype, fn.nspname::text AS function_schema,
          p.proname::text AS function_name
   FROM pg_trigger tg
   JOIN pg_class c ON c.oid = tg.tgrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   JOIN pg_proc p ON p.oid = tg.tgfoid
   JOIN pg_namespace fn ON fn.oid = p.pronamespace
   WHERE n.nspname = ANY ($1::text[]) AND NOT tg.tgisinternal
   ORDER BY n.nspname, c.relname, tg.tgname`,
);

export interface PolicyRow {
  schema: string;
  table_name: string;
  name: string;
  polcmd: string;
  permissive: boolean;
  roles: string[];
}

/**
 * RLS policies. Role oid 0 stands for PUBLIC. Role names come from `pg_roles`, the view readable
 * by everyone (`pg_authid` is superuser-only); an unresolvable oid falls back to its number.
 */
export const POLICIES = defineCatalogQuery<PolicyRow>(
  'policies',
  `SELECT n.nspname::text AS schema, c.relname::text AS table_name, pol.polname::text AS name,
          pol.polcmd::text AS polcmd, pol.polpermissive AS permissive,
          ARRAY(
            SELECT CASE WHEN r.role_oid = 0 THEN 'public'
                        ELSE coalesce(ro.rolname::text, r.role_oid::text) END
            FROM unnest(pol.polroles) AS r (role_oid)
            LEFT JOIN pg_roles ro ON ro.oid = r.role_oid
          ) AS roles
   FROM pg_policy pol
   JOIN pg_class c ON c.oid = pol.polrelid
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = ANY ($1::text[])
   ORDER BY n.nspname, c.relname, pol.polname`,
);

export interface TypeRow {
  schema: string;
  name: string;
  typtype: string;
}

/**
 * Types a migration can create: enums, domains, ranges, stand-alone composites (`CREATE TYPE ...
 * AS (...)`, whose typrelid points at a relkind 'c' relation, unlike table row types) and
 * non-array base types (e.g. from extensions). Array types, multiranges and pseudo/shell types
 * are generated or incomplete and skipped.
 */
export const TYPES = defineCatalogQuery<TypeRow>(
  'types',
  `SELECT n.nspname::text AS schema, t.typname::text AS name, t.typtype::text AS typtype
   FROM pg_type t
   JOIN pg_namespace n ON n.oid = t.typnamespace
   LEFT JOIN pg_class c ON c.oid = t.typrelid
   WHERE n.nspname = ANY ($1::text[])
     AND (
       t.typtype IN ('e', 'd', 'r')
       OR (t.typtype = 'c' AND c.relkind = 'c')
       OR (t.typtype = 'b' AND NOT EXISTS (SELECT 1 FROM pg_type el WHERE el.typarray = t.oid))
     )
   ORDER BY n.nspname, t.typname`,
);

export const ENUM_VALUES = defineCatalogQuery<{ schema: string; type_name: string; value: string }>(
  'enum_values',
  `SELECT n.nspname::text AS schema, t.typname::text AS type_name, e.enumlabel::text AS value
   FROM pg_enum e
   JOIN pg_type t ON t.oid = e.enumtypid
   JOIN pg_namespace n ON n.oid = t.typnamespace
   WHERE n.nspname = ANY ($1::text[])
   ORDER BY n.nspname, t.typname, e.enumsortorder`,
);

// ---------------------------------------------------------------------------------------------
// Recorded migration history (Supabase CLI). Identifiers cannot be bind parameters, so the table
// is fixed and the queries stay constant.
// ---------------------------------------------------------------------------------------------

export interface HistoryTableRow {
  readable: boolean;
  has_name_column: boolean;
}

/**
 * One row when the table exists, none otherwise. Existence needs no privileges (name join on
 * pg_catalog); `has_*_privilege` is called with oids so it cannot fail on a missing USAGE grant.
 */
export const HISTORY_TABLE = defineCatalogQuery<HistoryTableRow>(
  'history_table',
  `SELECT has_schema_privilege(n.oid, 'USAGE') AND has_table_privilege(c.oid, 'SELECT') AS readable,
          EXISTS (
            SELECT 1 FROM pg_attribute a
            WHERE a.attrelid = c.oid AND a.attname = 'name' AND a.attnum > 0 AND NOT a.attisdropped
          ) AS has_name_column
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'supabase_migrations' AND c.relname = 'schema_migrations'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
);

/** Current Supabase CLI layout: version, statements, name. */
export const HISTORY_WITH_NAME = defineCatalogQuery<{ version: string; name: string | null }>(
  'history_with_name',
  `SELECT m.version::text AS version, m.name::text AS name
   FROM supabase_migrations.schema_migrations m`,
);

/** Older Supabase CLI versions created the table without a name column. */
export const HISTORY_WITHOUT_NAME = defineCatalogQuery<{ version: string }>(
  'history_without_name',
  `SELECT m.version::text AS version FROM supabase_migrations.schema_migrations m`,
);
