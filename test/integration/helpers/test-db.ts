import { randomBytes } from 'node:crypto';
import pg from 'pg';
import type { Client } from 'pg';
import { inject } from 'vitest';

/**
 * Per-test databases on the shared integration server (see ../global-setup.ts).
 *
 * Databases are cheap (~0.3 s) and isolate test files from each other completely. Roles, however,
 * are cluster-wide, so everything that creates one is idempotent and tolerates another test
 * file creating the same role at the same moment.
 */

export interface TestDatabase {
  /** Database name, `pmv_test_<hex>`. */
  name: string;
  /** Superuser URL for this database. */
  url: string;
  /** Superuser connection to this database, for setting up fixtures. */
  admin: Client;
  /** Closes `admin` and drops the database (terminating any other sessions). */
  drop(): Promise<void>;
}

/** The read-only role tests connect as. Fake, test-only credentials. */
export const READ_ONLY_ROLE = 'pmv_readonly';
const READ_ONLY_PASSWORD = 'test-only-password';

/** Minimal Supabase surface migrations rely on: API roles, schema `auth`, `auth.uid()`. */
const SUPABASE_STUB_SQL = String.raw`
DO $$
DECLARE
  role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('CREATE ROLE %I NOLOGIN', role_name);
      END IF;
    EXCEPTION WHEN duplicate_object OR unique_violation THEN
      NULL; -- another test file created it concurrently
    END;
  END LOOP;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
`;

/**
 * Mirrors the role the README recommends: can log in, defaults to read-only transactions, and has
 * no grants on any schema or table. Tests that pass as this role prove pg_catalog suffices.
 */
const READ_ONLY_ROLE_SQL = String.raw`
DO $$
BEGIN
  CREATE ROLE ${READ_ONLY_ROLE} WITH LOGIN PASSWORD '${READ_ONLY_PASSWORD}'
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  ALTER ROLE ${READ_ONLY_ROLE} SET default_transaction_read_only = on;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL; -- created earlier in this run, by a previous run, or concurrently by another test file
END $$;
`;

/** Creates a fresh database with the Supabase stub applied. */
export async function createTestDatabase(
  adminUrl: string = inject('adminUrl'),
): Promise<TestDatabase> {
  const name = `pmv_test_${randomBytes(6).toString('hex')}`;
  await withClient(adminUrl, (c) => c.query(`CREATE DATABASE ${name}`));

  const url = withDatabase(adminUrl, name);
  const admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await applySql(admin, SUPABASE_STUB_SQL);

  return {
    name,
    url,
    admin,
    async drop() {
      await admin.end();
      await withClient(adminUrl, (c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/**
 * Ensures the `pmv_readonly` role exists and returns a URL that connects as it to `database`.
 */
export async function createReadOnlyRole(adminUrl: string, database: string): Promise<string> {
  await withClient(adminUrl, (c) => c.query(READ_ONLY_ROLE_SQL));
  const url = new URL(withDatabase(adminUrl, database));
  url.username = READ_ONLY_ROLE;
  url.password = READ_ONLY_PASSWORD;
  return url.toString();
}

/** Runs a multi-statement SQL script (simple query protocol, so no parameters). */
export async function applySql(client: Client, sql: string): Promise<void> {
  await client.query(sql);
}

/** `url` with its database replaced. */
export function withDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

async function withClient(url: string, work: (client: Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await work(client);
  } finally {
    await client.end();
  }
}
