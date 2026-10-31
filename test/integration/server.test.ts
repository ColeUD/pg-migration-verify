/**
 * The tools against a real Postgres, connected as the recommended read-only role (no grants at
 * all): the scenario this project exists for. One migration was pasted into the SQL editor (its
 * objects exist, history does not know it); another was recorded but only partly applied.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { createToolContext } from '../../src/tools/context.js';
import type {
  ListRecordedMigrationsOutput,
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

const CREATE_PROFILES = `
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Profiles are public" ON profiles FOR SELECT USING (true);
`;

const CREATE_TODOS_TABLE = `
CREATE TABLE todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES profiles (id),
  title text NOT NULL
);
`;
const CREATE_TODOS_INDEX = `CREATE INDEX todos_owner_idx ON todos (owner_id);\n`;

const MIGRATIONS: Record<string, string> = {
  '20240101000000_create_profiles.sql': CREATE_PROFILES,
  '20240102000000_create_todos.sql': CREATE_TODOS_TABLE + CREATE_TODOS_INDEX,
};

let testDb: TestDatabase;
let projectDir: string;
let readOnlyUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // 0001 pasted into the SQL editor: applied, never recorded. 0002 recorded, but the index is missing.
  await applySql(testDb.admin, CREATE_PROFILES + CREATE_TODOS_TABLE);
  await applySql(
    testDb.admin,
    `CREATE SCHEMA supabase_migrations;
     CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
     INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20240102000000', 'create_todos');`,
  );
  readOnlyUrl = await createReadOnlyRole(inject('adminUrl'), testDb.name);

  projectDir = await mkdtemp(path.join(os.tmpdir(), 'pgmv-it-'));
  const migrationsDir = path.join(projectDir, 'supabase', 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  for (const [fileName, sql] of Object.entries(MIGRATIONS)) {
    await writeFile(path.join(migrationsDir, fileName), sql);
  }
});

afterAll(async () => {
  await testDb.drop();
  await rm(projectDir, { recursive: true, force: true });
});

const clients: Client[] = [];

async function connect(databaseUrl: string): Promise<Client> {
  const context = createToolContext(readConfig({ PGMV_DATABASE_URL: databaseUrl }, projectDir));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await createServer(context).connect(serverTransport);
  const client = new Client({ name: 'pgmv-integration', version: '0.0.0' });
  await client.connect(clientTransport);
  clients.push(client);
  return client;
}

afterEach(async () => {
  await Promise.all(clients.splice(0).map((c) => c.close()));
});

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<{ text: string; structured: unknown; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  return {
    text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
    structured: result.structuredContent,
    isError: result.isError === true,
  };
}

describe('MCP tools against Postgres as a role without grants', () => {
  it('verifies objects through pg_catalog while history is not readable', async () => {
    const client = await connect(readOnlyUrl);

    const recorded = await call(client, 'list_recorded_migrations');
    expect(recorded.isError).toBe(false);
    expect((recorded.structured as ListRecordedMigrationsOutput).history.status).toBe(
      'not_readable',
    );

    const all = await call(client, 'verify_all');
    const structured = all.structured as VerifyAllOutput;
    expect(all.isError).toBe(false);
    expect(structured.history.status).toBe('not_readable');
    expect(structured.migrations.map((m) => [m.file, m.verdict, m.recorded])).toEqual([
      ['20240101000000_create_profiles.sql', 'MATCH', null],
      ['20240102000000_create_todos.sql', 'MISMATCH', null],
    ]);
    expect(structured.migrations[1]?.problems.map((p) => [p.status, p.object])).toEqual([
      ['missing', 'index public.todos_owner_idx'],
    ]);
    expect(all.text).toContain('cannot be read');
  });

  it('reports history once the role may read it', async () => {
    await applySql(
      testDb.admin,
      `GRANT USAGE ON SCHEMA supabase_migrations TO ${READ_ONLY_ROLE};
       GRANT SELECT ON supabase_migrations.schema_migrations TO ${READ_ONLY_ROLE};`,
    );
    const client = await connect(readOnlyUrl);

    const all = await call(client, 'verify_all');
    expect((all.structured as VerifyAllOutput).totals).toEqual({
      migrations: 2,
      match: 1,
      mismatch: 1,
      nothingToVerify: 0,
      appliedNotRecorded: 1,
      unprovenNotRecorded: 0,
      recordedButMismatch: 1,
    });

    const one = await call(client, 'verify_migration', { file: 'create_profiles' });
    const report = one.structured as VerifyMigrationOutput;
    expect(one.text).toMatch(/^MATCH (\d+)\/\1 {2}20240101000000_create_profiles\.sql/);
    expect(one.text).toContain('history: NOT recorded in supabase_migrations.schema_migrations');
    expect(report.migration).toMatchObject({ verdict: 'MATCH', recorded: false });

    const diff = await call(client, 'diff_history');
    expect(diff.text).toContain('only in repo');
  });

  it('reports an unreachable server without connection details', async () => {
    // Port 1 on loopback: nothing listens there. Fake, test-only credentials.
    const client = await connect('postgres://pmv_readonly:test-only-password@127.0.0.1:1/app');
    const result = await call(client, 'verify_all');
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/^Database error: could not connect to the database server/);
    expect(result.text).not.toContain('127.0.0.1');
    expect(result.text).not.toContain('test-only-password');
  });
});
