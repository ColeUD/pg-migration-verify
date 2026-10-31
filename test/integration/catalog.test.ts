import net from 'node:net';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import {
  DatabaseError,
  createDatabase,
  loadCatalogSnapshot,
  loadRecordedHistory,
} from '../../src/catalog/index.js';
import type { QueryRunner, ReadOnlyDatabase } from '../../src/catalog/index.js';
import { defineCatalogQuery } from '../../src/catalog/queries.js';
import type { CatalogSnapshot } from '../../src/model.js';
import {
  READ_ONLY_ROLE,
  applySql,
  createReadOnlyRole,
  createTestDatabase,
} from './helpers/test-db.js';
import type { TestDatabase } from './helpers/test-db.js';

const COVERED = ['public', 'app'];

/** One object of every kind the snapshot reports, including the awkward ones. */
const FIXTURE_SQL = String.raw`
CREATE SCHEMA app;

CREATE TYPE public.job_status AS ENUM ('draft', 'active', 'done');
CREATE TYPE public.address AS (street text, zip varchar(10));
CREATE DOMAIN public.email AS text CHECK (VALUE LIKE '%@%');
CREATE TYPE public.score_range AS RANGE (subtype = float8);
CREATE SEQUENCE public.ticket_seq;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  email public.email NOT NULL UNIQUE,
  username varchar(40),
  display_name text,
  home public.address,
  CONSTRAINT profiles_username_len CHECK (char_length(username) >= 3)
);

CREATE TABLE public.projects (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES public.profiles (id) ON DELETE CASCADE,
  name text NOT NULL,
  status public.job_status NOT NULL DEFAULT 'draft',
  tags text[] NOT NULL DEFAULT '{}',
  budget numeric(12, 2),
  active_during tstzrange,
  CONSTRAINT projects_owner_name_key UNIQUE (owner_id, name),
  CONSTRAINT projects_no_overlap EXCLUDE USING gist (active_during WITH &&)
);

CREATE TABLE public.todos (
  id serial PRIMARY KEY,
  project_id bigint NOT NULL,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id) REFERENCES public.projects (id)
);

CREATE TABLE public.events (
  id bigint NOT NULL,
  happened_on date NOT NULL,
  payload jsonb
) PARTITION BY RANGE (happened_on);
CREATE TABLE public.events_2026 PARTITION OF public.events
  FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');

CREATE TABLE app."Orders" (
  id integer PRIMARY KEY,
  "Display Name" text NOT NULL,
  status public.job_status NOT NULL
);

CREATE UNIQUE INDEX todos_open_title_idx ON public.todos (project_id, title) WHERE NOT done;
CREATE INDEX ON public.profiles (lower(display_name));
CREATE INDEX projects_tags_idx ON public.projects USING gin (tags);
CREATE INDEX projects_status_name_idx ON public.projects (status, lower(name));

CREATE VIEW public.open_todos AS SELECT id, title FROM public.todos WHERE NOT done;
CREATE MATERIALIZED VIEW public.project_counts AS
  SELECT project_id, count(*) AS todo_count FROM public.todos GROUP BY project_id;

CREATE FUNCTION app.touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.open_todos_insert() RETURNS trigger LANGUAGE plpgsql
  AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION public.project_stats(
  p_project bigint, p_label varchar(20), p_min numeric(10, 2),
  OUT total integer, OUT done_count integer
) LANGUAGE sql STABLE AS $$ SELECT 0, 0 $$;
CREATE FUNCTION app.is_active(s public.job_status) RETURNS boolean LANGUAGE sql IMMUTABLE
  AS $$ SELECT s = 'active' $$;
CREATE PROCEDURE public.archive_done(p_before timestamptz) LANGUAGE plpgsql
  AS $$ BEGIN NULL; END $$;

CREATE TRIGGER todos_touch BEFORE UPDATE OR INSERT ON public.todos
  FOR EACH ROW EXECUTE FUNCTION app.touch();
CREATE TRIGGER projects_audit AFTER TRUNCATE OR DELETE OR INSERT ON public.projects
  FOR EACH STATEMENT EXECUTE FUNCTION app.touch();
CREATE TRIGGER open_todos_insert INSTEAD OF INSERT ON public.open_todos
  FOR EACH ROW EXECUTE FUNCTION public.open_todos_insert();

ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todos ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.todos FORCE ROW LEVEL SECURITY;

CREATE POLICY "Owners can read" ON public.projects FOR SELECT TO authenticated, anon
  USING (owner_id = auth.uid());
CREATE POLICY projects_insert_own ON public.projects AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (owner_id = auth.uid());
CREATE POLICY todos_all ON public.todos USING (true);
CREATE POLICY todos_delete ON public.todos FOR DELETE TO service_role USING (true);
CREATE POLICY todos_update ON public.todos FOR UPDATE TO authenticated USING (true);
`;

/** Sorted copy, so expectations do not depend on the server's ORDER BY collation. */
function sorted<T>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

const col = (schema: string, table: string, name: string, dataType: string, notNull: boolean) => ({
  schema,
  table,
  name,
  dataType,
  notNull,
});

describe('loadCatalogSnapshot', () => {
  let testDb: TestDatabase;
  let snapshot: CatalogSnapshot;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await applySql(testDb.admin, FIXTURE_SQL);
    // Its own statement: a value added by ADD VALUE cannot be used in the same transaction.
    await applySql(testDb.admin, `ALTER TYPE public.job_status ADD VALUE 'archived' BEFORE 'done'`);
    snapshot = await loadCatalogSnapshot(createDatabase(testDb.url), COVERED);
  });

  afterAll(async () => {
    await testDb.drop();
  });

  it('reports the server version and the covered schemas', async () => {
    const { rows } = await testDb.admin.query<{ v: string }>(
      `SELECT current_setting('server_version_num') AS v`,
    );
    expect(snapshot.serverVersionNum).toBe(Number(rows[0]!.v));
    expect(snapshot.coveredSchemas).toEqual(COVERED);
  });

  it('lists every schema and extension, not only the covered ones', () => {
    expect(snapshot.schemas).toEqual(expect.arrayContaining(['public', 'app', 'auth']));
    expect(snapshot.schemas).toContain('pg_catalog');
    expect(snapshot.extensions).toContainEqual({ name: 'plpgsql', schema: 'pg_catalog' });
  });

  it('reads relations with their kind and RLS flags, skipping indexes and composite types', () => {
    const rel = (
      schema: string,
      name: string,
      kind: string,
      rlsEnabled = false,
      rlsForced = false,
    ) => ({
      schema,
      name,
      kind,
      rlsEnabled,
      rlsForced,
    });
    expect(sorted(snapshot.relations)).toEqual(
      sorted([
        rel('app', 'Orders', 'table'),
        rel('public', 'events', 'partitioned_table'),
        rel('public', 'events_2026', 'table'),
        rel('public', 'open_todos', 'view'),
        rel('public', 'profiles', 'table'),
        rel('public', 'project_counts', 'materialized_view'),
        rel('public', 'projects', 'table', true, false),
        rel('public', 'projects_id_seq', 'sequence'),
        rel('public', 'ticket_seq', 'sequence'),
        rel('public', 'todos', 'table', true, true),
        rel('public', 'todos_id_seq', 'sequence'),
      ]),
    );
  });

  it('reads columns with format_type spelling and schema-qualified user types', () => {
    expect(sorted(snapshot.columns)).toEqual(
      sorted([
        col('app', 'Orders', 'id', 'integer', true),
        col('app', 'Orders', 'Display Name', 'text', true),
        col('app', 'Orders', 'status', 'public.job_status', true),
        col('public', 'events', 'id', 'bigint', true),
        col('public', 'events', 'happened_on', 'date', true),
        col('public', 'events', 'payload', 'jsonb', false),
        col('public', 'events_2026', 'id', 'bigint', true),
        col('public', 'events_2026', 'happened_on', 'date', true),
        col('public', 'events_2026', 'payload', 'jsonb', false),
        col('public', 'open_todos', 'id', 'integer', false),
        col('public', 'open_todos', 'title', 'text', false),
        col('public', 'profiles', 'id', 'uuid', true),
        col('public', 'profiles', 'email', 'public.email', true),
        col('public', 'profiles', 'username', 'character varying(40)', false),
        col('public', 'profiles', 'display_name', 'text', false),
        col('public', 'profiles', 'home', 'public.address', false),
        col('public', 'project_counts', 'project_id', 'bigint', false),
        col('public', 'project_counts', 'todo_count', 'bigint', false),
        col('public', 'projects', 'id', 'bigint', true),
        col('public', 'projects', 'owner_id', 'uuid', true),
        col('public', 'projects', 'name', 'text', true),
        col('public', 'projects', 'status', 'public.job_status', true),
        col('public', 'projects', 'tags', 'text[]', true),
        col('public', 'projects', 'budget', 'numeric(12,2)', false),
        col('public', 'projects', 'active_during', 'tstzrange', false),
        col('public', 'todos', 'id', 'integer', true),
        col('public', 'todos', 'project_id', 'bigint', true),
        col('public', 'todos', 'title', 'text', true),
        col('public', 'todos', 'done', 'boolean', true),
        col('public', 'todos', 'created_at', 'timestamp with time zone', true),
      ]),
    );
  });

  it('keeps columns in attnum order within a table', () => {
    const projectColumns = snapshot.columns
      .filter((c) => c.table === 'projects')
      .map((c) => c.name);
    expect(projectColumns).toEqual([
      'id',
      'owner_id',
      'name',
      'status',
      'tags',
      'budget',
      'active_during',
    ]);
  });

  it('reads indexes with method, uniqueness and key columns including expressions', () => {
    const idx = (
      schema: string,
      table: string,
      name: string,
      columns: string[],
      { unique = false, primary = false, method = 'btree' } = {},
    ) => ({ schema, table, name, unique, primary, method, columns });
    expect(sorted(snapshot.indexes)).toEqual(
      sorted([
        idx('app', 'Orders', 'Orders_pkey', ['id'], { unique: true, primary: true }),
        idx('public', 'profiles', 'profiles_pkey', ['id'], { unique: true, primary: true }),
        idx('public', 'profiles', 'profiles_email_key', ['email'], { unique: true }),
        idx('public', 'profiles', 'profiles_lower_idx', ['(lower(display_name))']),
        idx('public', 'projects', 'projects_pkey', ['id'], { unique: true, primary: true }),
        idx('public', 'projects', 'projects_owner_name_key', ['owner_id', 'name'], {
          unique: true,
        }),
        idx('public', 'projects', 'projects_no_overlap', ['active_during'], { method: 'gist' }),
        idx('public', 'projects', 'projects_tags_idx', ['tags'], { method: 'gin' }),
        idx('public', 'projects', 'projects_status_name_idx', ['status', '(lower(name))']),
        idx('public', 'todos', 'todos_pkey', ['id'], { unique: true, primary: true }),
        idx('public', 'todos', 'todos_open_title_idx', ['project_id', 'title'], { unique: true }),
      ]),
    );
  });

  it('reads the five constraint kinds, named and unnamed, but not NOT NULL or domain checks', () => {
    const con = (
      schema: string,
      table: string,
      name: string,
      type: string,
      columns: string[],
      references: { schema: string; table: string; columns: string[] } | null = null,
    ) => ({ schema, table, name, type, columns, references });
    expect(sorted(snapshot.constraints)).toEqual(
      sorted([
        con('app', 'Orders', 'Orders_pkey', 'primary_key', ['id']),
        con('public', 'profiles', 'profiles_pkey', 'primary_key', ['id']),
        con('public', 'profiles', 'profiles_email_key', 'unique', ['email']),
        con('public', 'profiles', 'profiles_username_len', 'check', ['username']),
        con('public', 'projects', 'projects_pkey', 'primary_key', ['id']),
        con('public', 'projects', 'projects_owner_id_fkey', 'foreign_key', ['owner_id'], {
          schema: 'public',
          table: 'profiles',
          columns: ['id'],
        }),
        con('public', 'projects', 'projects_owner_name_key', 'unique', ['owner_id', 'name']),
        con('public', 'projects', 'projects_no_overlap', 'exclusion', ['active_during']),
        con('public', 'todos', 'todos_pkey', 'primary_key', ['id']),
        con('public', 'todos', 'todos_project_id_fkey', 'foreign_key', ['project_id'], {
          schema: 'public',
          table: 'projects',
          columns: ['id'],
        }),
      ]),
    );
  });

  it('reads functions and procedures with identity args, skipping range constructors', () => {
    expect(sorted(snapshot.functions)).toEqual(
      sorted([
        { schema: 'app', name: 'is_active', argTypes: ['public.job_status'], isProcedure: false },
        { schema: 'app', name: 'touch', argTypes: [], isProcedure: false },
        { schema: 'public', name: 'open_todos_insert', argTypes: [], isProcedure: false },
        {
          schema: 'public',
          name: 'project_stats',
          argTypes: ['bigint', 'character varying', 'numeric'],
          isProcedure: false,
        },
        {
          schema: 'public',
          name: 'archive_done',
          argTypes: ['timestamp with time zone'],
          isProcedure: true,
        },
      ]),
    );
  });

  it('decodes trigger timing, events and level, skipping internal FK triggers', () => {
    expect(sorted(snapshot.triggers)).toEqual(
      sorted([
        {
          schema: 'public',
          table: 'todos',
          name: 'todos_touch',
          timing: 'BEFORE',
          events: ['INSERT', 'UPDATE'],
          forEachRow: true,
          function: { schema: 'app', name: 'touch' },
        },
        {
          schema: 'public',
          table: 'projects',
          name: 'projects_audit',
          timing: 'AFTER',
          events: ['INSERT', 'DELETE', 'TRUNCATE'],
          forEachRow: false,
          function: { schema: 'app', name: 'touch' },
        },
        {
          schema: 'public',
          table: 'open_todos',
          name: 'open_todos_insert',
          timing: 'INSTEAD OF',
          events: ['INSERT'],
          forEachRow: true,
          function: { schema: 'public', name: 'open_todos_insert' },
        },
      ]),
    );
  });

  it('reads policies with command, permissiveness and sorted roles (PUBLIC as public)', () => {
    const pol = (
      table: string,
      name: string,
      command: string,
      roles: string[],
      permissive = true,
    ) => ({ schema: 'public', table, name, command, permissive, roles });
    expect(sorted(snapshot.policies)).toEqual(
      sorted([
        pol('projects', 'Owners can read', 'SELECT', ['anon', 'authenticated']),
        pol('projects', 'projects_insert_own', 'INSERT', ['authenticated'], false),
        pol('todos', 'todos_all', 'ALL', ['public']),
        pol('todos', 'todos_delete', 'DELETE', ['service_role']),
        pol('todos', 'todos_update', 'UPDATE', ['authenticated']),
      ]),
    );
  });

  it('reads user-defined types, skipping row, array and multirange types', () => {
    expect(sorted(snapshot.types)).toEqual(
      sorted([
        { schema: 'public', name: 'address', typeKind: 'composite' },
        { schema: 'public', name: 'email', typeKind: 'domain' },
        { schema: 'public', name: 'job_status', typeKind: 'enum' },
        { schema: 'public', name: 'score_range', typeKind: 'range' },
      ]),
    );
  });

  it('reads enum values in sort order, including values added later', () => {
    expect(snapshot.enumValues).toEqual(
      ['draft', 'active', 'archived', 'done'].map((value) => ({
        schema: 'public',
        typeName: 'job_status',
        value,
      })),
    );
  });

  it('ignores schemas that are not covered', () => {
    const outside = [
      ...snapshot.relations,
      ...snapshot.columns,
      ...snapshot.functions,
      ...snapshot.types,
    ].filter((o) => !COVERED.includes(o.schema));
    expect(outside).toEqual([]);
  });

  it('sees exactly the same catalog as a role with no grants at all', async () => {
    const readOnlyUrl = await createReadOnlyRole(inject('adminUrl'), testDb.name);
    const asReadOnly = await loadCatalogSnapshot(createDatabase(readOnlyUrl), COVERED);
    expect(asReadOnly).toEqual(snapshot);
  });
});

describe('createDatabase', () => {
  let testDb: TestDatabase;
  let db: ReadOnlyDatabase;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    await applySql(testDb.admin, 'CREATE TABLE public.todos (id int PRIMARY KEY, title text)');
    db = createDatabase(testDb.url, { statementTimeoutMs: 1234 });
  });

  afterAll(async () => {
    await testDb.drop();
  });

  // Test-only queries: production SQL lives in src/catalog/queries.ts.
  const SESSION_SETTINGS = defineCatalogQuery<{
    read_only: string;
    search_path: string;
    statement_timeout: string;
    application_name: string;
  }>(
    'test_session_settings',
    `SELECT current_setting('transaction_read_only') AS read_only,
            current_setting('search_path') AS search_path,
            current_setting('statement_timeout') AS statement_timeout,
            current_setting('application_name') AS application_name`,
  );
  const WRITING_CTE = defineCatalogQuery<{ id: number }>(
    'test_writing_cte',
    `WITH inserted AS (INSERT INTO public.todos VALUES (1, 'x') RETURNING id) SELECT id FROM inserted`,
  );
  const SLOW = defineCatalogQuery('test_slow', 'SELECT pg_sleep(2)');

  it('runs work in a read-only transaction with an empty search_path and the timeout', async () => {
    const [settings] = await db.readOnly((q) => q.run(SESSION_SETTINGS));
    expect(settings).toEqual({
      read_only: 'on',
      search_path: '""',
      statement_timeout: '1234ms',
      application_name: 'pg-migration-verify',
    });
  });

  it('blocks a write smuggled through a data-modifying CTE', async () => {
    const attempt = db.readOnly((q) => q.run(WRITING_CTE));
    await expect(attempt).rejects.toThrow(DatabaseError);
    await expect(attempt).rejects.toMatchObject({
      category: 'query',
      sqlState: '25006',
      message: 'read-only transaction blocked a write',
    });
    const { rows } = await testDb.admin.query('SELECT count(*)::int AS n FROM public.todos');
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('reports a statement timeout as a timeout error', async () => {
    const quick = createDatabase(testDb.url, { statementTimeoutMs: 50 });
    await expect(quick.readOnly((q) => q.run(SLOW))).rejects.toMatchObject({
      category: 'timeout',
    });
  });

  it('refuses to run a query after its transaction has ended', async () => {
    let leaked: QueryRunner | undefined;
    await db.readOnly(async (q) => {
      leaked = q;
      await Promise.resolve();
    });
    await expect(leaked!.run(SESSION_SETTINGS)).rejects.toThrow(/after its transaction/);
  });
});

describe('loadRecordedHistory', () => {
  const databases: TestDatabase[] = [];
  async function freshDatabase(): Promise<TestDatabase> {
    const created = await createTestDatabase();
    databases.push(created);
    return created;
  }

  afterAll(async () => {
    await Promise.all(databases.map((d) => d.drop()));
  });

  const CREATE_HISTORY = (withName: boolean) => `
    CREATE SCHEMA supabase_migrations;
    CREATE TABLE supabase_migrations.schema_migrations (
      version text PRIMARY KEY,
      statements text[]${withName ? ',\n      name text' : ''}
    );`;

  it('reports a missing history table', async () => {
    const { url } = await freshDatabase();
    expect(await loadRecordedHistory(createDatabase(url))).toEqual({
      status: 'missing',
      table: 'supabase_migrations.schema_migrations',
    });
  });

  it('returns versions sorted, with names, from the current CLI layout', async () => {
    const { url, admin } = await freshDatabase();
    await applySql(
      admin,
      `${CREATE_HISTORY(true)}
       INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES
         ('20240301000000', 'add_todos'), ('20240101000000', 'create_profiles'),
         ('20240201000000', NULL);`,
    );
    expect(await loadRecordedHistory(createDatabase(url))).toEqual({
      status: 'ok',
      table: 'supabase_migrations.schema_migrations',
      migrations: [
        { version: '20240101000000', name: 'create_profiles' },
        { version: '20240201000000', name: null },
        { version: '20240301000000', name: 'add_todos' },
      ],
    });
  });

  it('returns versions without names from the older layout that lacks a name column', async () => {
    const { url, admin } = await freshDatabase();
    await applySql(
      admin,
      `${CREATE_HISTORY(false)}
       INSERT INTO supabase_migrations.schema_migrations (version) VALUES
         ('20240201000000'), ('20240101000000');`,
    );
    expect(await loadRecordedHistory(createDatabase(url))).toEqual({
      status: 'ok',
      table: 'supabase_migrations.schema_migrations',
      migrations: [
        { version: '20240101000000', name: null },
        { version: '20240201000000', name: null },
      ],
    });
  });

  it('reports not_readable for a role without grants, and ok once granted', async () => {
    const { admin, name } = await freshDatabase();
    await applySql(
      admin,
      `${CREATE_HISTORY(true)}
       INSERT INTO supabase_migrations.schema_migrations (version, name)
         VALUES ('20240101000000', 'create_profiles');`,
    );
    const readOnly = createDatabase(await createReadOnlyRole(inject('adminUrl'), name));

    expect(await loadRecordedHistory(readOnly)).toEqual({
      status: 'not_readable',
      table: 'supabase_migrations.schema_migrations',
      reason:
        'the connected role lacks USAGE on schema supabase_migrations or SELECT on schema_migrations',
    });

    await applySql(
      admin,
      `GRANT USAGE ON SCHEMA supabase_migrations TO ${READ_ONLY_ROLE};
       GRANT SELECT ON supabase_migrations.schema_migrations TO ${READ_ONLY_ROLE};`,
    );
    expect(await loadRecordedHistory(readOnly)).toMatchObject({
      status: 'ok',
      migrations: [{ version: '20240101000000', name: 'create_profiles' }],
    });
  });
});

describe('error sanitization against a real server', () => {
  const WRONG_PASSWORD = 'wrong-test-only-p@ss/word';

  /** Everything about the connection that must never appear in a message. */
  function forbiddenFragments(url: string): string[] {
    const parsed = new URL(url);
    return [
      url,
      parsed.password,
      decodeURIComponent(parsed.password),
      parsed.hostname,
      parsed.port,
    ];
  }

  async function failure(url: string): Promise<DatabaseError> {
    const error: unknown = await createDatabase(url)
      .readOnly(() => Promise.resolve('connected'))
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(error).toBeInstanceOf(DatabaseError);
    return error as DatabaseError;
  }

  function expectClean(error: DatabaseError, url: string): void {
    for (const fragment of forbiddenFragments(url)) {
      expect(error.message).not.toContain(fragment);
    }
  }

  it('reports a wrong password as an authentication error without echoing it', async (ctx) => {
    const url = new URL(inject('adminUrl'));
    url.password = encodeURIComponent(WRONG_PASSWORD);
    const badUrl = url.toString();

    // A server configured with trust auth accepts any password; there is nothing to test then.
    const probe = new pg.Client({ connectionString: badUrl });
    const accepted = await probe.connect().then(
      () => true,
      () => false,
    );
    await probe.end().catch(() => undefined);
    if (accepted) ctx.skip();

    const error = await failure(badUrl);
    expect(error.category).toBe('authentication');
    expect(error.sqlState).toBe('28P01');
    expectClean(error, badUrl);
    expect(error.message).not.toContain(WRONG_PASSWORD);
  });

  it('reports an unreachable port as a connection error without host or port', async () => {
    const url = new URL(inject('adminUrl'));
    url.hostname = '127.0.0.1';
    url.port = String(await closedPort());
    const badUrl = url.toString();

    const error = await failure(badUrl);
    expect(error.category).toBe('connection');
    expect(error.message).toBe('could not connect to the database server (connection refused)');
    expectClean(error, badUrl);
  });

  it('reports a database that does not exist as a configuration error', async () => {
    const url = new URL(inject('adminUrl'));
    url.pathname = '/pmv_no_such_database';
    const error = await failure(url.toString());
    expect(error.category).toBe('configuration');
    expect(error.message).toMatch(/^database does not exist/);
    expect(error.message).not.toContain('pmv_no_such_database');
    expectClean(error, url.toString());
  });

  it.each([
    ['not a url', 'not a url at all'],
    ['wrong scheme', 'mysql://user:test-only-password@localhost/db'],
    ['broken URL with a password', 'postgres://user:test only password@[bad/db'],
  ])('reports a garbage connection string (%s) as a configuration error', async (_, garbage) => {
    const error = await failure(garbage);
    expect(error.category).toBe('configuration');
    expect(error.message).toBe('connection string is not a valid postgres:// URL');
    expect(error.message).not.toContain('password');
  });
});

/** A port nothing listens on: bind an ephemeral port, then release it. */
function closedPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (address !== null && typeof address === 'object') resolve(address.port);
        else reject(new Error('could not determine a free port'));
      });
    });
  });
}
