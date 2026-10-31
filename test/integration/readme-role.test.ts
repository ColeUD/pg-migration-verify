/**
 * The README's "Read-only role" SQL, run as written: the first step of the quickstart. Only the
 * password placeholder and the database name are replaced. The tools then verify migrations and
 * read the history table as the role it creates, so the documented role and the documented
 * grants are known to be enough.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { readConfig } from '../../src/config.js';
import { createServer } from '../../src/server.js';
import { createToolContext } from '../../src/tools/context.js';
import type { ListRecordedMigrationsOutput, VerifyAllOutput } from '../../src/tools/schemas.js';
import { createdRoles, readOnlyRoleSql } from '../helpers/repo-files.js';
import { applySql, createTestDatabase, type TestDatabase } from './helpers/test-db.js';

/** Fake, test-only password in place of the README's `<generated password>`. */
const PASSWORD = 'test-only-password';

const MIGRATIONS: Record<string, string> = {
  '20240101000000_create_profiles.sql': `
CREATE TABLE profiles (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE
);
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
`,
  '20240102000000_create_todos.sql': `
CREATE TABLE todos (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_id uuid NOT NULL REFERENCES profiles (id),
  title text NOT NULL
);
CREATE INDEX todos_owner_idx ON todos (owner_id);
`,
};

const adminUrl = inject('adminUrl');
const roleSql = readOnlyRoleSql();
const [role] = createdRoles(roleSql);

let testDb: TestDatabase;
let projectDir: string;
let roleUrl: string;

beforeAll(async () => {
  testDb = await createTestDatabase();
  // Both migrations applied; only the second recorded, as after pasting the first into the editor.
  await applySql(testDb.admin, Object.values(MIGRATIONS).join('\n'));
  await applySql(
    testDb.admin,
    `CREATE SCHEMA supabase_migrations;
     CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, statements text[], name text);
     INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ('20240102000000', 'create_todos');`,
  );

  // Roles are cluster-wide: clear one left behind by an aborted run of this file.
  await withAdmin((c) => c.query(`DROP ROLE IF EXISTS ${role!}`));
  const sql = replaceOnce(
    replaceOnce(roleSql, `'<generated password>'`, `'${PASSWORD}'`),
    'ON DATABASE postgres TO',
    `ON DATABASE ${testDb.name} TO`,
  );
  // The block as one script, in the database the grants are meant for.
  await applySql(testDb.admin, sql);

  const url = new URL(testDb.url);
  url.username = role!;
  url.password = PASSWORD;
  roleUrl = url.toString();

  projectDir = await mkdtemp(path.join(os.tmpdir(), 'pgmv-role-'));
  const migrationsDir = path.join(projectDir, 'supabase', 'migrations');
  await mkdir(migrationsDir, { recursive: true });
  for (const [fileName, sql] of Object.entries(MIGRATIONS)) {
    await writeFile(path.join(migrationsDir, fileName), sql);
  }
});

afterAll(async () => {
  // The database goes first: it holds the role's CONNECT and schema grants.
  await testDb.drop();
  await withAdmin((c) => c.query(`DROP ROLE IF EXISTS ${role!}`));
  await rm(projectDir, { recursive: true, force: true });
});

describe('the README read-only role', () => {
  it('is created by the documented SQL, with the documented session defaults', async () => {
    const client = new pg.Client({ connectionString: roleUrl });
    await client.connect();
    try {
      const readOnly = await client.query<{ default_transaction_read_only: string }>(
        'SHOW default_transaction_read_only',
      );
      const timeout = await client.query<{ statement_timeout: string }>('SHOW statement_timeout');
      const flags = await client.query<{ rolsuper: boolean; rolconnlimit: number }>(
        'SELECT rolsuper, rolconnlimit FROM pg_roles WHERE rolname = current_user',
      );

      expect(readOnly.rows[0]?.default_transaction_read_only).toBe('on');
      expect(timeout.rows[0]?.statement_timeout).toBe('15s');
      expect(flags.rows[0]).toEqual({ rolsuper: false, rolconnlimit: 3 });
    } finally {
      await client.end();
    }
  });

  it('verifies migrations and reads the history table through the tools', async () => {
    const context = createToolContext(readConfig({ PGMV_DATABASE_URL: roleUrl }, projectDir));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await createServer(context).connect(serverTransport);
    const client = new Client({ name: 'pgmv-readme-role', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      const recorded = await client.callTool({ name: 'list_recorded_migrations', arguments: {} });
      expect(recorded.isError).not.toBe(true);
      const history = recorded.structuredContent as ListRecordedMigrationsOutput;
      expect(history.history.status).toBe('ok');
      expect(history.migrations).toEqual([{ version: '20240102000000', name: 'create_todos' }]);

      const all = await client.callTool({ name: 'verify_all', arguments: {} });
      expect(all.isError).not.toBe(true);
      const structured = all.structuredContent as VerifyAllOutput;
      expect(structured.migrations.map((m) => [m.file, m.verdict, m.recorded])).toEqual([
        ['20240101000000_create_profiles.sql', 'MATCH', false],
        ['20240102000000_create_todos.sql', 'MATCH', true],
      ]);
      expect(structured.totals.appliedNotRecorded).toBe(1);
    } finally {
      await client.close();
    }
  });
});

/** `text` with `search` replaced, failing if the README no longer contains it exactly once. */
function replaceOnce(text: string, search: string, replacement: string): string {
  expect(text.split(search)).toHaveLength(2);
  return text.replace(search, replacement);
}

async function withAdmin(work: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}
