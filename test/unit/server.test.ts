/**
 * The MCP layer end to end, in process: a real Client talks to `createServer()` over the SDK's
 * in-memory transport, so arguments go through the SDK's input validation and results through
 * its output-schema check exactly as they would over stdio. The database is a fake QueryRunner
 * returning canned pg_catalog rows by query id; the migrations are synthetic files in a temp dir.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DatabaseError, type QueryRunner, type ReadOnlyDatabase } from '../../src/catalog/index.js';
import type { CatalogQuery } from '../../src/catalog/index.js';
import { readConfig, type Config } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { NO_DATABASE_MESSAGE, type ToolContext } from '../../src/tools/context.js';
import type {
  DiffHistoryOutput,
  ExpectedObjectsOutput,
  ListRecordedMigrationsOutput,
  ListRepoMigrationsOutput,
  VerifyAllOutput,
  VerifyMigrationOutput,
} from '../../src/tools/schemas.js';

const TOOL_NAMES = [
  'list_repo_migrations',
  'list_recorded_migrations',
  'diff_history',
  'expected_objects',
  'verify_migration',
  'verify_all',
];
const DATABASE_TOOLS = [
  'list_recorded_migrations',
  'diff_history',
  'verify_migration',
  'verify_all',
];

const MIGRATIONS: Record<string, string> = {
  '20240101000000_create_profiles.sql': `
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  username text NOT NULL
);
`,
  '20240102000000_create_todos.sql': `
CREATE TABLE todos (
  id bigint PRIMARY KEY,
  title text NOT NULL,
  legacy boolean
);
GRANT SELECT ON todos TO authenticated;
`,
  '20240103000000_drop_legacy.sql': `
ALTER TABLE todos DROP COLUMN legacy;
`,
  // Not a migration by name: listed as skipped, never verified.
  'notes.sql': `SELECT 1;`,
};

/**
 * pg_catalog as someone left it: profiles complete; todos created without its title column (a
 * partial paste into the SQL editor); legacy dropped. History records the first two files (the
 * first under an older name) and a version that has no file, but not the third.
 */
const CATALOG_ROWS: Record<string, unknown[]> = {
  server_version: [{ version_num: 170004 }],
  schemas: [{ name: 'public' }, { name: 'supabase_migrations' }],
  extensions: [],
  relations: [
    { schema: 'public', name: 'profiles', relkind: 'r', rls_enabled: false, rls_forced: false },
    { schema: 'public', name: 'todos', relkind: 'r', rls_enabled: false, rls_forced: false },
  ],
  columns: [
    { schema: 'public', table_name: 'profiles', name: 'id', data_type: 'uuid', not_null: true },
    {
      schema: 'public',
      table_name: 'profiles',
      name: 'username',
      data_type: 'text',
      not_null: true,
    },
    { schema: 'public', table_name: 'todos', name: 'id', data_type: 'bigint', not_null: true },
  ],
  indexes: [pkeyIndex('profiles'), pkeyIndex('todos')],
  constraints: [pkeyConstraint('profiles'), pkeyConstraint('todos')],
  history_table: [{ readable: true, has_name_column: true }],
  history_with_name: [
    { version: '20231201000000', name: 'old_init' },
    { version: '20240101000000', name: 'create_profile' },
    { version: '20240102000000', name: 'create_todos' },
  ],
};

function pkeyIndex(table: string): Record<string, unknown> {
  return {
    schema: 'public',
    table_name: table,
    name: `${table}_pkey`,
    is_unique: true,
    is_primary: true,
    method: 'btree',
    columns: ['id'],
  };
}

function pkeyConstraint(table: string): Record<string, unknown> {
  return {
    schema: 'public',
    table_name: table,
    name: `${table}_pkey`,
    contype: 'p',
    columns: ['id'],
    ref_schema: null,
    ref_table: null,
    ref_columns: [],
  };
}

interface FakeDatabase extends ReadOnlyDatabase {
  /** Number of `readOnly()` calls, i.e. connections a real database would have opened. */
  transactions: number;
  /** Query ids in the order they ran. */
  queries: string[];
}

/** Answers each vetted query with canned rows by id; `fail` makes every transaction throw. */
function fakeDatabase(rows: Record<string, unknown[]>, fail?: () => unknown): FakeDatabase {
  const fake: FakeDatabase = {
    transactions: 0,
    queries: [],
    async readOnly<T>(work: (q: QueryRunner) => Promise<T>): Promise<T> {
      fake.transactions++;
      if (fail !== undefined) throw fail();
      const runner: QueryRunner = {
        run<Row>(query: CatalogQuery<Row>): Promise<Row[]> {
          fake.queries.push(query.id);
          return Promise.resolve((rows[query.id] ?? []) as Row[]);
        },
      };
      return work(runner);
    },
  };
  return fake;
}

let projectDir: string;

beforeAll(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), 'pgmv-server-'));
  const migrationsDir = path.join(projectDir, 'supabase', 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  for (const [fileName, sql] of Object.entries(MIGRATIONS)) {
    await writeFile(path.join(migrationsDir, fileName), sql);
  }
  const otherDir = path.join(projectDir, 'db', 'other');
  await mkdir(otherDir, { recursive: true });
  await writeFile(path.join(otherDir, '0001_init.sql'), 'CREATE TABLE t (id int);');
});

afterAll(async () => {
  await rm(projectDir, { recursive: true, force: true });
});

function config(databaseUrl: string | null): Config {
  const env = databaseUrl === null ? {} : { PGMV_DATABASE_URL: databaseUrl };
  return readConfig(env, projectDir);
}

const FAKE_URL = 'postgres://app_user:test-only-password@db.example.test:5432/app';

function contextWith(
  database: ReadOnlyDatabase | null,
  url: string | null = FAKE_URL,
): ToolContext {
  return { config: config(database === null ? null : url), openDatabase: () => database };
}

const open: Client[] = [];

async function connect(context: ToolContext): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(context).connect(serverTransport);
  const client = new Client({ name: 'pgmv-test', version: '0.0.0' });
  await client.connect(clientTransport);
  open.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});

interface CallResult {
  text: string;
  structured: unknown;
  isError: boolean;
  /** Everything the client received, for leak checks. */
  raw: string;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<CallResult> {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
  return {
    text,
    structured: result.structuredContent,
    isError: result.isError === true,
    raw: JSON.stringify(result),
  };
}

describe('tools/list', () => {
  it('lists the six tools, all read-only, each with an output schema and described inputs', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      expect(tool.title).toBeTruthy();
      expect(tool.description).toMatch(/read-only/i);
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.outputSchema?.type).toBe('object');
      const properties = (tool.inputSchema.properties ?? {}) as Record<
        string,
        { description?: string }
      >;
      for (const [field, schema] of Object.entries(properties)) {
        expect(schema.description, `${tool.name}.${field}`).toBeTruthy();
      }
    }
  });

  it('explains the verdict words in the verify tool descriptions', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const { tools } = await client.listTools();
    for (const name of ['verify_migration', 'verify_all']) {
      const description = tools.find((t) => t.name === name)?.description ?? '';
      for (const word of ['MATCH', 'MISMATCH', 'SUPERSEDED', 'UNVERIFIABLE']) {
        expect(description).toContain(`${word} =`);
      }
    }
  });
});

describe('list_repo_migrations', () => {
  it('lists files with full checksums, skipped files and duplicates', async () => {
    const client = await connect(contextWith(null));
    const result = await call(client, 'list_repo_migrations');
    const structured = result.structured as ListRepoMigrationsOutput;

    expect(result.isError).toBe(false);
    expect(result.text).toContain('3 migration files in supabase/migrations');
    expect(structured.directory).toBe('supabase/migrations');
    expect(structured.files.map((f) => f.fileName)).toEqual([
      '20240101000000_create_profiles.sql',
      '20240102000000_create_todos.sql',
      '20240103000000_drop_legacy.sql',
    ]);
    expect(structured.files[0]).toMatchObject({
      version: '20240101000000',
      name: 'create_profiles',
    });
    for (const f of structured.files) expect(f.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(structured.skipped.map((s) => s.fileName)).toEqual(['notes.sql']);
    expect(structured.duplicateVersions).toEqual([]);
  });

  it('resolves a relative dir against the project directory', async () => {
    const client = await connect(contextWith(null));
    const result = await call(client, 'list_repo_migrations', { dir: 'db/other' });
    const structured = result.structured as ListRepoMigrationsOutput;
    expect(structured.directory).toBe('db/other');
    expect(structured.files.map((f) => f.version)).toEqual(['0001']);
  });

  it('reports a missing directory as a tool error', async () => {
    const client = await connect(contextWith(null));
    const result = await call(client, 'list_repo_migrations', { dir: 'nope' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Migrations directory not found');
  });
});

describe('list_recorded_migrations', () => {
  it('returns the recorded versions', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const result = await call(client, 'list_recorded_migrations');
    const structured = result.structured as ListRecordedMigrationsOutput;

    expect(result.text).toContain('3 migrations recorded in supabase_migrations.schema_migrations');
    expect(structured.history).toEqual({
      table: 'supabase_migrations.schema_migrations',
      status: 'ok',
      reason: null,
    });
    expect(structured.migrations.map((m) => m.version)).toEqual([
      '20231201000000',
      '20240101000000',
      '20240102000000',
    ]);
  });

  it.each([
    ['missing', [], /does not exist/],
    ['not_readable', [{ readable: false, has_name_column: true }], /GRANT USAGE ON SCHEMA/],
  ] as const)('explains a %s history table without failing', async (status, rows, text) => {
    const db = fakeDatabase({ ...CATALOG_ROWS, history_table: [...rows] });
    const client = await connect(contextWith(db));
    const result = await call(client, 'list_recorded_migrations');
    const structured = result.structured as ListRecordedMigrationsOutput;

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(text);
    expect(structured.history.status).toBe(status);
    expect(structured.migrations).toEqual([]);
  });
});

describe('diff_history', () => {
  it('splits versions into only in repo, only in database and in both, flagging renames', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const result = await call(client, 'diff_history');
    const { diff } = result.structured as DiffHistoryOutput;

    expect(result.text).toContain('only in repo');
    expect(result.text).toContain('name differs');
    expect(diff).toEqual({
      agree: false,
      inBoth: [
        {
          version: '20240101000000',
          fileName: '20240101000000_create_profiles.sql',
          repoName: 'create_profiles',
          recordedName: 'create_profile',
          nameMatches: false,
        },
        {
          version: '20240102000000',
          fileName: '20240102000000_create_todos.sql',
          repoName: 'create_todos',
          recordedName: 'create_todos',
          nameMatches: true,
        },
      ],
      onlyInRepo: [
        {
          version: '20240103000000',
          name: 'drop_legacy',
          fileName: '20240103000000_drop_legacy.sql',
        },
      ],
      onlyInDatabase: [{ version: '20231201000000', name: 'old_init' }],
    });
  });

  it('returns no diff when the history table is missing', async () => {
    const client = await connect(contextWith(fakeDatabase({ ...CATALOG_ROWS, history_table: [] })));
    const result = await call(client, 'diff_history');
    const structured = result.structured as DiffHistoryOutput;
    expect(result.isError).toBe(false);
    expect(structured.history.status).toBe('missing');
    expect(structured.diff).toBeNull();
  });
});

describe('expected_objects', () => {
  it('lists what one migration should create, without a database', async () => {
    const client = await connect(contextWith(null));
    const result = await call(client, 'expected_objects', { file: '20240102000000' });
    const structured = result.structured as ExpectedObjectsOutput;

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^20240102000000_create_todos\.sql: 2 statements/);
    expect(structured.file).toBe('20240102000000_create_todos.sql');
    expect(structured.statementCount).toBe(2);
    expect(structured.objects).toContainEqual({
      kind: 'column',
      key: 'column:public.todos.title',
      expect: 'present',
      description: 'column public.todos.title (text, not null)',
      line: 2,
      inDoBlock: false,
    });
    expect(structured.notes).toEqual([
      expect.objectContaining({
        category: 'unverifiable',
        statementType: 'GrantStmt',
        line: 7,
        excerpt: 'GRANT SELECT ON todos TO authenticated',
      }),
    ]);
  });

  it.each([
    'create_todos',
    '20240102000000_create_todos.sql',
    'supabase/migrations/20240102000000_create_todos.sql',
  ])('accepts %s as the migration', async (file) => {
    const client = await connect(contextWith(null));
    const result = await call(client, 'expected_objects', { file });
    expect((result.structured as ExpectedObjectsOutput).file).toBe(
      '20240102000000_create_todos.sql',
    );
  });

  it('reports an unknown migration with candidates', async () => {
    const client = await connect(contextWith(null));
    const result = await call(client, 'expected_objects', { file: 'todos' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('No migration matches "todos"');
    expect(result.text).toContain('20240102000000_create_todos.sql');
  });
});

describe('verify_migration', () => {
  it('reports a partially applied migration as MISMATCH, in one transaction', async () => {
    const db = fakeDatabase(CATALOG_ROWS);
    const client = await connect(contextWith(db));
    const result = await call(client, 'verify_migration', { file: 'create_todos' });
    const structured = result.structured as VerifyMigrationOutput;

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^MISMATCH \d+\/\d+ {2}20240102000000_create_todos\.sql/);
    expect(result.text).toContain('MISSING');
    expect(result.text).toContain('column public.todos.title (text, not null)');
    expect(result.text).toContain('SUPERSEDED');
    expect(result.text).toContain('UNVERIFIABLE');
    expect(result.text).toContain('history: recorded in supabase_migrations.schema_migrations');

    expect(structured.migration).toMatchObject({
      version: '20240102000000',
      file: '20240102000000_create_todos.sql',
      verdict: 'MISMATCH',
      superseded: 1,
      unverifiable: 1,
      recorded: true,
    });
    expect(structured.migration.matched).toBe(structured.migration.checked - 1);
    expect(structured.migration.problems).toEqual([
      expect.objectContaining({
        status: 'missing',
        object: 'column public.todos.title',
        kind: 'column',
        line: 2, // the CREATE TABLE statement
        differences: [],
      }),
    ]);
    expect(structured.checks.find((c) => c.status === 'superseded')).toMatchObject({
      object: 'column public.todos.legacy',
      supersededBy: { file: '20240103000000_drop_legacy.sql' },
    });
    expect(structured.checks.length).toBe(structured.migration.checked + 1);
    expect(structured.notes.map((n) => n.statementType)).toEqual(['GrantStmt']);
    expect(structured.history.status).toBe('ok');

    expect(db.transactions).toBe(1);
    // History last, see readRecordedHistory.
    expect(db.queries.at(-1)).toBe('history_with_name');
  });

  it('reports an applied migration as MATCH and lists matches when verbose', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const result = await call(client, 'verify_migration', {
      file: '20240101000000_create_profiles.sql',
      verbose: true,
    });
    const structured = result.structured as VerifyMigrationOutput;

    expect(result.text).toMatch(/^MATCH (\d+)\/\1 {2}20240101000000_create_profiles\.sql/);
    expect(result.text).toContain('  MATCH');
    expect(structured.migration.verdict).toBe('MATCH');
    expect(structured.migration.problems).toEqual([]);
    expect(structured.checks.every((c) => c.status === 'match')).toBe(true);
  });

  it('explains why history is unavailable', async () => {
    const db = fakeDatabase({ ...CATALOG_ROWS, history_table: [] });
    const client = await connect(contextWith(db));
    const result = await call(client, 'verify_migration', { file: '20240101000000' });

    expect(result.text).toContain('history: unavailable');
    expect(result.text).toContain('supabase_migrations.schema_migrations does not exist');
    expect((result.structured as VerifyMigrationOutput).migration.recorded).toBeNull();
  });

  it('rejects a missing file argument through input validation', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const result = await call(client, 'verify_migration', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Input validation error');
  });
});

describe('verify_all', () => {
  it('returns the summary, the totals and the full report of each MISMATCH only', async () => {
    const db = fakeDatabase(CATALOG_ROWS);
    const client = await connect(contextWith(db));
    const result = await call(client, 'verify_all');
    const structured = result.structured as VerifyAllOutput;

    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/^VERSION +NAME +RESULT/);
    expect(result.text).toContain('3 migrations: 2 MATCH, 1 MISMATCH, 0 nothing to verify.');
    expect(result.text).toContain('1 applied but NOT recorded in history.');
    expect(result.text).toContain('Skipped 1 .sql file');
    expect(result.text).toMatch(/\n\nMISMATCH \d+\/\d+ {2}20240102000000_create_todos\.sql/);
    expect(result.text).not.toMatch(/\nMATCH \d+\/\d+ {2}20240101000000/);

    expect(structured.totals).toEqual({
      migrations: 3,
      match: 2,
      mismatch: 1,
      nothingToVerify: 0,
      appliedNotRecorded: 1,
      recordedButMismatch: 1,
    });
    expect(structured.migrations.map((m) => [m.version, m.verdict, m.recorded])).toEqual([
      ['20240101000000', 'MATCH', true],
      ['20240102000000', 'MISMATCH', true],
      ['20240103000000', 'MATCH', false],
    ]);
    expect(structured.migrations[1]?.problems.map((p) => p.object)).toEqual([
      'column public.todos.title',
    ]);
    expect(db.transactions).toBe(1);
  });

  it('includes every report when verbose', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS)));
    const result = await call(client, 'verify_all', { verbose: true });
    for (const file of Object.keys(MIGRATIONS).filter((f) => f !== 'notes.sql')) {
      expect(result.text).toMatch(new RegExp(`\\n\\n(MATCH|MISMATCH) \\d+/\\d+ {2}${file}`));
    }
  });
});

describe('without a database URL', () => {
  it.each(DATABASE_TOOLS)('%s explains how to configure one', async (name) => {
    const client = await connect(contextWith(null));
    const args = name === 'verify_migration' ? { file: 'create_todos' } : {};
    const result = await call(client, name, args);
    expect(result.isError).toBe(true);
    expect(result.text).toBe(NO_DATABASE_MESSAGE);
  });
});

describe('database errors', () => {
  it.each(DATABASE_TOOLS)('%s surfaces a DatabaseError as a tool error', async (name) => {
    const db = fakeDatabase(
      CATALOG_ROWS,
      () =>
        new DatabaseError(
          'connection',
          'could not connect to the database server (connection refused)',
        ),
    );
    const client = await connect(contextWith(db));
    const args = name === 'verify_migration' ? { file: 'create_todos' } : {};
    const result = await call(client, name, args);
    expect(result.isError).toBe(true);
    expect(result.text).toBe(
      'Database error: could not connect to the database server (connection refused)',
    );
  });
});

describe('secrets', () => {
  // Synthetic: no such host, user or password exists.
  const PASSWORD = 'Sup3r-Secret-P@ss';
  const ENCODED_PASSWORD = 'Sup3r-Secret-P%40ss';
  const HOST = 'db.internal.example';
  const SECRET_URL = `postgres://pmv_user:${ENCODED_PASSWORD}@${HOST}:6543/app`;
  const FORBIDDEN = [
    SECRET_URL,
    PASSWORD,
    ENCODED_PASSWORD,
    'Sup3r-Secret',
    `pmv_user:${ENCODED_PASSWORD}`,
    `pmv_user:${PASSWORD}`,
    HOST,
  ];

  /** Errors as careless drivers, sockets and libraries write them. */
  const LEAKY_ERRORS: (() => unknown)[] = [
    () => new Error(`connect ECONNREFUSED ${HOST}:6543`),
    () => new Error(`invalid connection string "${SECRET_URL}"`),
    () => new Error(`password authentication failed for user "pmv_user" (tried ${PASSWORD})`),
    () => new Error(`bad option in ${encodeURIComponent(SECRET_URL)}`),
    () => new DatabaseError('query', `lost pmv_user:${ENCODED_PASSWORD}@${HOST}`),
    () => new DatabaseError('connection', `tls: certificate is not valid for ${HOST}`),
    () => Object.assign(new Error(`getaddrinfo ENOTFOUND ${HOST}`), { input: SECRET_URL }),
    () => SECRET_URL,
  ];

  /** Calls that reach handlers, and calls the SDK rejects before any handler runs. */
  const CALLS: [string, Record<string, unknown>][] = [
    ['list_repo_migrations', {}],
    ['list_repo_migrations', { dir: SECRET_URL }],
    ['list_repo_migrations', { dir: 6543 }],
    ['list_recorded_migrations', {}],
    ['list_recorded_migrations', { unexpected: SECRET_URL }],
    ['diff_history', {}],
    ['diff_history', { dir: SECRET_URL }],
    ['expected_objects', { file: SECRET_URL }],
    ['expected_objects', { file: 'create_todos', dir: SECRET_URL }],
    ['expected_objects', { file: ['postgres', SECRET_URL] }],
    ['verify_migration', { file: 'create_todos' }],
    ['verify_migration', { file: SECRET_URL }],
    ['verify_migration', { file: 'create_todos', verbose: SECRET_URL }],
    ['verify_all', {}],
    ['verify_all', { verbose: true }],
    ['verify_all', { dir: { url: SECRET_URL } }],
    ['no_such_tool', {}],
  ];

  function expectNoSecrets(output: string, label: string): void {
    for (const fragment of FORBIDDEN) {
      expect(output.includes(fragment), `${label} leaks ${fragment}`).toBe(false);
    }
  }

  it.each(LEAKY_ERRORS.map((fail, i) => [i, fail] as const))(
    'never echoes the connection string, password or host (error form %i)',
    async (_, fail) => {
      const db = fakeDatabase(CATALOG_ROWS, fail);
      const client = await connect(contextWith(db, SECRET_URL));
      let errors = 0;
      for (const [name, args] of CALLS) {
        const result = await client
          .callTool({ name, arguments: args })
          .then((r) => JSON.stringify(r))
          .catch((error: unknown) => (error instanceof Error ? error.message : String(error)));
        expectNoSecrets(result, `${name} ${JSON.stringify(Object.keys(args))}`);
        if (result.includes('"isError":true')) errors++;
      }
      // Guard against a vacuous pass: the database calls and bad arguments did fail.
      expect(errors).toBeGreaterThanOrEqual(12);
      expect(db.transactions).toBeGreaterThan(0);
    },
  );

  it('keeps secrets out of successful results too', async () => {
    const client = await connect(contextWith(fakeDatabase(CATALOG_ROWS), SECRET_URL));
    for (const name of TOOL_NAMES) {
      const args =
        name === 'expected_objects' || name === 'verify_migration'
          ? { file: '20240102000000' }
          : {};
      const result = await call(client, name, args);
      expect(result.isError, name).toBe(false);
      expectNoSecrets(result.raw, name);
    }
    const { tools } = await client.listTools();
    expectNoSecrets(JSON.stringify(tools), 'tools/list');
  });
});
