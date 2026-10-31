import pg from 'pg';
import type { Client } from 'pg';
import { DatabaseError, sanitizeDatabaseError } from './errors.js';
import type { CatalogQuery } from './queries.js';

/** Runs vetted catalog queries inside an open read-only transaction. */
export interface QueryRunner {
  run<Row>(query: CatalogQuery<Row>, params?: readonly unknown[]): Promise<Row[]>;
}

/** The only way the server touches a database: a unit of work inside `BEGIN READ ONLY`. */
export interface ReadOnlyDatabase {
  /**
   * Opens a connection, starts a read-only transaction, runs `work`, then always rolls back and
   * disconnects. Every error that escapes is a sanitized `DatabaseError`.
   */
  readOnly<T>(work: (q: QueryRunner) => Promise<T>): Promise<T>;
}

export interface DatabaseOptions {
  /** Per-statement limit, applied with SET LOCAL. Default 15000 ms. */
  statementTimeoutMs?: number;
}

const APPLICATION_NAME = 'pg-migration-verify';
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
/** Postgres stores `statement_timeout` as a 32-bit int of milliseconds. */
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;
const CONNECT_TIMEOUT_MS = 10_000;

// Transaction control. Fixed text, never built from input; the timeout travels as a parameter.
const BEGIN_READ_ONLY = 'BEGIN READ ONLY';
/** Makes format_type()/pg_get_expr() schema-qualify every user type (`public.job_status`). */
const CLEAR_SEARCH_PATH = "SET LOCAL search_path = ''";
const SET_STATEMENT_TIMEOUT = "SELECT set_config('statement_timeout', $1, true)";
const ROLLBACK = 'ROLLBACK';

/**
 * Creates a handle for a database. Nothing connects until `readOnly()` is called, and each call
 * uses a fresh `pg.Client` rather than a pool: a tool invocation makes only a couple of calls, and
 * a short-lived connection cannot leak session state between them.
 *
 * Read-only by construction: the runner accepts only `CatalogQuery` values (single vetted
 * SELECTs), every call runs inside `BEGIN READ ONLY`, and the transaction is rolled back, never
 * committed.
 *
 * @throws DatabaseError (`configuration`) when `statementTimeoutMs` is not a positive integer.
 */
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): ReadOnlyDatabase {
  const timeoutMs = options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_STATEMENT_TIMEOUT_MS) {
    throw new DatabaseError(
      'configuration',
      `statement timeout must be a whole number of milliseconds between 1 and ${MAX_STATEMENT_TIMEOUT_MS}`,
    );
  }

  return {
    async readOnly<T>(work: (q: QueryRunner) => Promise<T>): Promise<T> {
      let client: Client | undefined;
      try {
        assertPostgresUrl(connectionString);
        client = new pg.Client({
          connectionString,
          application_name: APPLICATION_NAME,
          connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
        });
        // A connection-level failure is also emitted as an 'error' event; without a listener
        // Node would crash the process. The pending query rejects with it anyway.
        client.on('error', () => undefined);
        await client.connect();
        return await inReadOnlyTransaction(client, timeoutMs, connectionString, work);
      } catch (err) {
        throw sanitizeDatabaseError(err, connectionString);
      } finally {
        // Ending can fail if the server already dropped us; there is nothing left to clean up.
        await client?.end().catch(() => undefined);
      }
    },
  };
}

async function inReadOnlyTransaction<T>(
  client: Client,
  timeoutMs: number,
  connectionString: string,
  work: (q: QueryRunner) => Promise<T>,
): Promise<T> {
  let open = true;
  const runner: QueryRunner = {
    async run<Row>(query: CatalogQuery<Row>, params: readonly unknown[] = []): Promise<Row[]> {
      if (!open) throw new DatabaseError('query', `query ${query.id} ran after its transaction`);
      try {
        const result = await client.query(query.text, [...params]);
        return result.rows as Row[];
      } catch (err) {
        throw sanitizeDatabaseError(err, connectionString);
      }
    },
  };

  await client.query(BEGIN_READ_ONLY);
  try {
    await client.query(CLEAR_SEARCH_PATH);
    await client.query(SET_STATEMENT_TIMEOUT, [String(timeoutMs)]);
    return await work(runner);
  } finally {
    open = false;
    // A failed ROLLBACK means the connection is gone; the server discards the transaction then,
    // and swallowing it keeps the original error (if any) visible.
    await client.query(ROLLBACK).catch(() => undefined);
  }
}

/**
 * Rejects anything but a postgres:// or postgresql:// URL before `pg` sees it: `pg` would
 * otherwise reinterpret odd strings (e.g. as a socket path) and produce confusing errors.
 */
function assertPostgresUrl(connectionString: string): void {
  let protocol: string;
  try {
    protocol = new URL(connectionString).protocol;
  } catch {
    protocol = '';
  }
  if (protocol !== 'postgres:' && protocol !== 'postgresql:') {
    throw new DatabaseError('configuration', 'connection string is not a valid postgres:// URL');
  }
}
