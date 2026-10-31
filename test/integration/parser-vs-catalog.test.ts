import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, loadCatalogSnapshot } from '../../src/catalog/index.js';
import type {
  CatalogSnapshot,
  MigrationFile,
  MigrationReport,
  ParsedMigration,
} from '../../src/model.js';
import { loadParser, parseMigration } from '../../src/parser/index.js';
import {
  formatMigrationReport,
  requiredSchemas,
  verifyMigrations,
} from '../../src/verify/index.js';
import { applySql, createReadOnlyRole, createTestDatabase } from './helpers/test-db.js';
import type { TestDatabase } from './helpers/test-db.js';

/**
 * The end-to-end promise of the tool: a migration that was applied verifies as MATCH n/n, with no
 * differences, against the real catalog. Every object kind and every type spelling the parser
 * normalizes appears here at least once, so any drift between the parser's spelling and
 * `format_type()` / `pg_get_indexdef()` / `pg_policy` shows up as a failing check.
 */
const MIGRATION_SQL = String.raw`
-- Supabase installs extensions into their own schema.
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA extensions;
CREATE SCHEMA app;

CREATE TYPE public.job_status AS ENUM ('draft', 'active', 'done');
ALTER TYPE public.job_status ADD VALUE 'archived' BEFORE 'done';
CREATE TYPE app."Priority" AS ENUM ('low', 'High');
CREATE TYPE public.address AS (street text, zip varchar(10));
CREATE DOMAIN public.short_text AS varchar(80) CHECK (VALUE <> '');
CREATE TYPE public.score_range AS RANGE (subtype = float8);

-- Idempotent enum creation, as Supabase migrations often do it.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'mood') THEN
    CREATE TYPE public.mood AS ENUM ('happy', 'sad');
  END IF;
END $$;

CREATE SEQUENCE app.ticket_seq;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email extensions.citext NOT NULL UNIQUE,
  username varchar(255),
  display_name text,
  bio character(10),
  initial char,
  home public.address,
  current_mood mood,
  slogan short_text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_username_len CHECK (char_length(username) >= 3)
);

CREATE TABLE public.projects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  name text NOT NULL,
  status job_status NOT NULL DEFAULT 'draft',
  tags text[] NOT NULL DEFAULT '{}',
  budget numeric(10, 2),
  ratio double precision,
  weight real,
  small_count int2,
  starts_at timestamp(3) without time zone,
  local_time time,
  duration interval hour to minute,
  scores int[][],
  flags bit varying(8),
  payload jsonb,
  active_during tstzrange,
  UNIQUE (owner_id, name),
  CHECK (budget >= 0)
);

CREATE TABLE app."Todo Items" (
  id serial PRIMARY KEY,
  "projectId" bigint NOT NULL,
  "Title" varchar(200) NOT NULL,
  priority app."Priority" NOT NULL DEFAULT 'low',
  statuses public.job_status[],
  done boolean NOT NULL DEFAULT false,
  due date,
  FOREIGN KEY ("projectId") REFERENCES public.projects (id)
);

ALTER TABLE public.profiles ADD COLUMN website text;
ALTER TABLE public.profiles ALTER COLUMN display_name TYPE varchar(120);
ALTER TABLE public.profiles RENAME COLUMN bio TO tagline;
ALTER TABLE public.profiles ALTER COLUMN username SET NOT NULL;
ALTER TABLE public.projects ADD CONSTRAINT projects_name_not_blank CHECK (name <> '');

CREATE INDEX ON app."Todo Items" ("projectId", done);
CREATE UNIQUE INDEX todo_items_title_idx ON app."Todo Items" ("projectId", lower("Title"));
CREATE INDEX projects_tags_idx ON public.projects USING gin (tags);

CREATE VIEW public.open_todos AS SELECT id, "Title" FROM app."Todo Items" WHERE NOT done;
CREATE MATERIALIZED VIEW app.project_counts AS
  SELECT "projectId", count(*) AS n FROM app."Todo Items" GROUP BY 1;

CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.project_stats(
  p_project bigint, p_label varchar(20), p_min numeric(10, 2),
  OUT total integer, OUT done_count integer
) LANGUAGE sql STABLE AS $$ SELECT 0, 0 $$;
CREATE FUNCTION app.is_active(s job_status, VARIADIC labels text[]) RETURNS boolean
  LANGUAGE sql IMMUTABLE AS $$ SELECT s = 'active' $$;
CREATE FUNCTION public.find_profiles(q extensions.citext, since timestamptz DEFAULT now())
  RETURNS SETOF public.profiles LANGUAGE sql STABLE
  AS $$ SELECT * FROM public.profiles WHERE email = q AND created_at >= since $$;
CREATE FUNCTION public.next_ids(INOUT n integer, OUT ids integer[])
  LANGUAGE sql AS $$ SELECT n, ARRAY[n] $$;
CREATE FUNCTION public.todo_titles(p_project bigint)
  RETURNS TABLE (id integer, title varchar) LANGUAGE sql STABLE
  AS $$ SELECT id, "Title" FROM app."Todo Items" WHERE "projectId" = p_project $$;
CREATE PROCEDURE app.archive_done(p_before timestamptz) LANGUAGE plpgsql
  AS $$ BEGIN NULL; END $$;

CREATE TRIGGER todo_items_touch BEFORE INSERT OR UPDATE ON app."Todo Items"
  FOR EACH ROW EXECUTE FUNCTION app.touch();
CREATE TRIGGER projects_audit AFTER DELETE OR TRUNCATE ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION app.touch();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app."Todo Items" ENABLE ROW LEVEL SECURITY;
ALTER TABLE app."Todo Items" FORCE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read" ON public.projects FOR SELECT TO authenticated, anon
  USING (owner_id = (SELECT auth.uid()));
CREATE POLICY projects_insert_own ON public.projects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY todo_items_all ON app."Todo Items" USING (true);

-- Unqualified names from here on resolve to app (and types to public, through the path).
SET search_path = app, public;
CREATE TABLE notes (
  id bigserial PRIMARY KEY,
  body text NOT NULL,
  feeling mood,
  todo_id integer REFERENCES "Todo Items" (id)
);
CREATE INDEX notes_feeling_idx ON notes (feeling) WHERE feeling IS NOT NULL;

RESET search_path;

-- Every type spelling the parser normalizes, checked against what format_type() prints.
CREATE TABLE public.type_zoo (
  a_int4 int4,
  a_integer_arr integer[3],
  a_bigint int8 GENERATED BY DEFAULT AS IDENTITY,
  a_small smallserial,
  a_float float,
  a_float24 float(24),
  a_float53 float(53),
  a_decimal decimal(5),
  a_numeric numeric,
  a_char_n char(3),
  a_bpchar bpchar,
  a_bpchar_n bpchar(4),
  a_internal_char "char",
  a_varchar varchar,
  a_charvar character varying(12),
  a_text_arr text[][],
  a_bit bit,
  a_bit3 bit(3),
  a_varbit varbit,
  a_ts timestamp,
  a_ts0 timestamp(0) with time zone,
  a_tstz6 timestamptz(6),
  a_time3 time(3),
  a_timetz timetz,
  a_timetz2 time(2) with time zone,
  a_interval interval,
  a_interval_p interval(2),
  a_interval_ds interval day to second(3),
  a_interval_y interval year,
  a_money money,
  a_inet inet,
  a_bool bool,
  a_bytea bytea,
  a_xml xml,
  a_tsvector tsvector,
  a_name name,
  a_oid oid,
  a_regclass regclass,
  a_json json,
  a_pg_text pg_catalog.text,
  a_pg_varchar pg_catalog.varchar(9),
  a_citext_arr extensions.citext[],
  a_priority_arr app."Priority"[],
  a_mood_arr mood[],
  a_point point,
  a_double_arr double precision[],
  a_tstz_arr timestamp with time zone[],
  a_int4range int4range,
  a_uuid_arr uuid[]
);
ALTER TABLE public.type_zoo ALTER COLUMN a_int4 TYPE int8;
ALTER TABLE public.type_zoo ALTER COLUMN a_varchar TYPE varchar(30), ALTER COLUMN a_bool SET NOT NULL;

CREATE FUNCTION public.type_zoo_args(
  a varchar(10), b char(2), c numeric(5, 2), d timestamp(3) with time zone, e "char",
  f float(24), g bit(3), h interval day to second, i app."Priority"[], j double precision[],
  k time(2), l bpchar, m int4range, VARIADIC n integer[]
) RETURNS void LANGUAGE sql AS $$ SELECT $$;

-- Constraint flavors: composite keys, implicit referenced columns, deferrable, exclusion.
CREATE TABLE public.memberships (
  project_id bigint NOT NULL,
  profile_id uuid NOT NULL REFERENCES public.profiles ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  during tstzrange,
  PRIMARY KEY (project_id, profile_id),
  FOREIGN KEY (project_id) REFERENCES public.projects (id),
  EXCLUDE USING gist (during WITH &&)
);
CREATE TABLE public.events (
  id bigint NOT NULL,
  happened_on date NOT NULL,
  PRIMARY KEY (id, happened_on)
) PARTITION BY RANGE (happened_on);
CREATE TABLE public.events_2026 PARTITION OF public.events
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE TRIGGER projects_status_changed AFTER UPDATE OF status ON public.projects
  FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status) EXECUTE FUNCTION app.touch();
CREATE POLICY memberships_read ON public.memberships FOR SELECT TO public USING (true);
CREATE POLICY memberships_admin ON public.memberships TO service_role, authenticated USING (true);
ALTER TABLE public.memberships ENABLE ROW LEVEL SECURITY;

-- Net effect within one file: renames and drops leave only the final state to check.
ALTER TYPE public.mood RENAME VALUE 'sad' TO 'blue';
ALTER INDEX app.notes_feeling_idx RENAME TO notes_mood_idx;
ALTER TABLE public.projects RENAME CONSTRAINT projects_name_not_blank TO projects_name_present;
ALTER TABLE public.open_todos RENAME TO pending_todos;
CREATE TABLE public.scratch (id integer PRIMARY KEY, note text);
CREATE INDEX scratch_note_idx ON public.scratch (note);
DROP TABLE public.scratch;
CREATE FUNCTION public.obsolete(x integer) RETURNS integer LANGUAGE sql AS $$ SELECT x $$;
DROP FUNCTION public.obsolete(integer);
ALTER TABLE public.profiles DROP COLUMN website;
CREATE OR REPLACE VIEW public.pending_todos AS
  SELECT id, "Title" FROM app."Todo Items" WHERE NOT done AND due IS NOT NULL;

COMMENT ON TABLE public.projects IS 'Synthetic fixture';
GRANT USAGE ON SCHEMA app TO authenticated;
`;

const FILE = synthetic('20261031120000', 'rich_schema');

/**
 * What the migration should leave behind, per kind and expectation. `absent` entries come from the
 * in-file drops and renames (old names must be gone); the scratch table's index and columns fold
 * into its DROP TABLE. Pinned so a parser change that silently stops emitting some kind of object
 * fails here instead of still reporting MATCH.
 */
const EXPECTED_BY_KIND: Record<string, number> = {
  'schema/present': 2,
  'extension/present': 1,
  'type/present': 6,
  'enum_value/present': 8,
  'enum_value/absent': 1,
  'table/present': 8,
  'table/absent': 1,
  'view/present': 1,
  'view/absent': 1,
  'materialized_view/present': 1,
  'sequence/present': 1,
  'column/present': 92,
  'column/absent': 2,
  'index/present': 4,
  'index/absent': 1,
  'constraint/present': 18,
  'constraint/absent': 1,
  'function/present': 8,
  'function/absent': 1,
  'trigger/present': 3,
  'rls/present': 3,
  'policy/present': 5,
};
const EXPECTED_CHECKS = Object.values(EXPECTED_BY_KIND).reduce((a, b) => a + b, 0);

describe('parser output verified against a real catalog', () => {
  let testDb: TestDatabase;
  let parsed: ParsedMigration;
  let snapshot: CatalogSnapshot;
  let report: MigrationReport;

  beforeAll(async () => {
    await loadParser();
    parsed = parseMigration(MIGRATION_SQL, { file: FILE.fileName });
    testDb = await createTestDatabase();
    await applySql(testDb.admin, MIGRATION_SQL);

    // Read as the unprivileged role the README recommends: pg_catalog alone must suffice.
    const readOnlyUrl = await createReadOnlyRole(testDb.url, testDb.name);
    snapshot = await loadCatalogSnapshot(
      createDatabase(readOnlyUrl),
      requiredSchemas([{ file: FILE, parsed }]),
    );
    [report] = verifyMigrations({
      migrations: [{ file: FILE, parsed }],
      snapshot,
      recordedVersions: null,
    }) as [MigrationReport];
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('parses every statement without a parse error', () => {
    expect(parsed.notes.filter((n) => n.statementType === 'ParseError')).toEqual([]);
  });

  it('loads exactly the schemas the migration touches', () => {
    expect(snapshot.coveredSchemas).toEqual(['app', 'extensions', 'public']);
  });

  it('expects every object kind the verifier checks', () => {
    const byKind: Record<string, number> = {};
    for (const { object } of report.checks) {
      const key = `${object.kind}/${object.expect}`;
      byKind[key] = (byKind[key] ?? 0) + 1;
    }
    expect(byKind).toEqual(EXPECTED_BY_KIND);
    expect(EXPECTED_CHECKS).toBe(169);
  });

  it('matches every expected object with zero differences', () => {
    const problems = report.checks.filter((c) => c.status !== 'match');
    // On failure, the formatted report says exactly which spelling drifted.
    expect(problems, formatMigrationReport(report)).toEqual([]);
    expect(report.verdict).toBe('MATCH');
    expect(report.checked).toBe(EXPECTED_CHECKS);
    expect(report.matched).toBe(EXPECTED_CHECKS);
  });

  it('predicts the name Postgres generated for every unnamed constraint and index', () => {
    const unnamed = parsed.objects.flatMap((o) =>
      (o.kind === 'constraint' || o.kind === 'index') && o.name === null && o.expect === 'present'
        ? [o]
        : [],
    );
    const missing = unnamed.filter((o) =>
      o.kind === 'constraint'
        ? !snapshot.constraints.some(
            (c) => c.schema === o.schema && c.table === o.table && c.name === o.impliedName,
          )
        : !snapshot.indexes.some((i) => i.schema === o.schema && i.name === o.impliedName),
    );
    expect(missing.map((o) => `${o.key} -> ${o.impliedName ?? '?'}`)).toEqual([]);
    expect(unnamed.length).toBeGreaterThan(10);
  });

  it('formats the report with only the statements it cannot check', () => {
    expect(formatMigrationReport(report)).toBe(
      [
        `MATCH ${EXPECTED_CHECKS}/${EXPECTED_CHECKS}  20261031120000_rich_schema.sql`,
        '  UNVERIFIABLE line 81   CreateTableAsStmt: columns come from a query and are not checked',
        '  UNVERIFIABLE line 205  CreateStmt: columns of a partition come from its parent table and are not checked',
        '  UNVERIFIABLE line 228  CommentStmt: comments are not checked',
        '  UNVERIFIABLE line 229  GrantStmt: privileges are not checked',
        '  history: unavailable',
      ].join('\n'),
    );
  });

  it('still flags drift against the same database (the match above is not vacuous)', () => {
    // A later "migration" that disagrees with what was applied, one attribute per object kind.
    const drift = parseMigration(
      String.raw`
ALTER TABLE public.profiles ALTER COLUMN username TYPE varchar(100);
CREATE INDEX ON app."Todo Items" (done, "projectId");
CREATE FUNCTION app.touch(reason text) RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE POLICY todo_items_all ON app."Todo Items" FOR SELECT TO anon USING (true);
ALTER TYPE public.mood ADD VALUE 'sad';
`,
      { file: '20261031130000_drift.sql' },
    );
    const [, driftReport] = verifyMigrations({
      migrations: [
        { file: FILE, parsed },
        { file: synthetic('20261031130000', 'drift'), parsed: drift },
      ],
      snapshot,
      recordedVersions: null,
    }) as [MigrationReport, MigrationReport];

    expect(formatMigrationReport(driftReport)).toBe(
      [
        'MISMATCH 0/5  20261031130000_drift.sql',
        '  MISSING   line 3  index on app."Todo Items" (done, "projectId") (using btree)',
        '  MISSING   line 4  function app.touch(text)',
        '                    note: found other signatures: touch()',
        `  MISSING   line 6  enum value public.mood.'sad'`,
        '  DIFFERENT line 2  column public.profiles.username: type expected character varying(100), found character varying(255)',
        '  DIFFERENT line 5  policy "todo_items_all" on app."Todo Items": command expected SELECT, found ALL; roles expected anon, found public',
        '  history: unavailable',
      ].join('\n'),
    );
  });
});

function synthetic(version: string, name: string): MigrationFile {
  const fileName = `${version}_${name}.sql`;
  return { version, name, fileName, path: `/synthetic/${fileName}`, checksum: '0'.repeat(64) };
}
