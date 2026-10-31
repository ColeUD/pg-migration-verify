import { Socket } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import type { Client } from 'pg';
import { connectTimeoutError, DatabaseError, sanitizeDatabaseError } from './errors.js';
import type { CatalogQuery } from './queries.js';

/** Runs vetted catalog queries inside an open read-only transaction. */
export interface QueryRunner {
  run<Row>(query: CatalogQuery<Row>, params?: readonly unknown[]): Promise<Row[]>;
}

/** The only way the server touches a database: a unit of work inside a read-only transaction. */
export interface ReadOnlyDatabase {
  /**
   * Opens a connection, starts a REPEATABLE READ, READ ONLY transaction, runs `work`, then always
   * rolls back and disconnects. Every error that escapes is a sanitized `DatabaseError`.
   */
  readOnly<T>(work: (q: QueryRunner) => Promise<T>): Promise<T>;
}

export interface DatabaseOptions {
  /**
   * Per-statement limit, applied with SET LOCAL. Default 15000 ms. The client also gives up on a
   * statement whose reply has not arrived a few seconds after that (a dropped connection).
   */
  statementTimeoutMs?: number;
  /** How long to wait for the connection and its startup handshake. Default 10000 ms. */
  connectTimeoutMs?: number;
}

const APPLICATION_NAME = 'pg-migration-verify';
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
/** Postgres stores `statement_timeout` as a 32-bit int of milliseconds. */
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;
/** setTimeout's limit; longer delays fire immediately. */
const MAX_TIMER_MS = 2_147_483_647;
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/**
 * Extra time the client waits for a reply beyond the server's statement timeout. The server
 * cancels a slow statement itself; this only catches a server or network that went silent.
 */
const REPLY_GRACE_MS = 2_000;
/** How long closing the connection may take before the socket is destroyed. */
const CLOSE_TIMEOUT_MS = 2_000;

// Transaction control. Fixed text, never built from input; the timeout travels as a parameter.
// REPEATABLE READ: every catalog query of one call sees the same snapshot, so a migration running
// at the same moment cannot tear it (READ COMMITTED takes a new snapshot per statement).
const BEGIN_SNAPSHOT_READ_ONLY = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';
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
 * SELECTs), every call runs inside a READ ONLY transaction, and the transaction is rolled back,
 * never committed.
 *
 * Every call is bounded in time: connecting by `connectTimeoutMs`, each statement (including
 * BEGIN and the setup statements) by the statement timeout plus a short grace period, and closing
 * the connection by a few seconds after which the socket is destroyed.
 *
 * @throws DatabaseError (`configuration`) when a timeout is not a positive integer.
 */
export function createDatabase(
  connectionString: string,
  options: DatabaseOptions = {},
): ReadOnlyDatabase {
  const timeoutMs = validTimeout(
    options.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS,
    'statement timeout',
  );
  const connectTimeoutMs = validTimeout(
    options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    'connect timeout',
  );

  return {
    async readOnly<T>(work: (q: QueryRunner) => Promise<T>): Promise<T> {
      let client: Client | undefined;
      let socket: Socket | undefined;
      try {
        assertPostgresUrl(connectionString);
        client = new pg.Client({
          connectionString,
          application_name: APPLICATION_NAME,
          // Our own socket, so that cleanup can destroy it when the peer never closes.
          stream: () => (socket = new Socket()),
          // Bounds every statement, also BEGIN and SET, which run before statement_timeout holds
          // and which a dead connection would otherwise leave waiting forever.
          query_timeout: Math.min(timeoutMs + REPLY_GRACE_MS, MAX_TIMER_MS),
          keepAlive: true,
          keepAliveInitialDelayMillis: 10_000,
        });
        // A connection-level failure is also emitted as an 'error' event; without a listener
        // Node would crash the process. The pending query rejects with it anyway.
        client.on('error', () => undefined);
        await connectWithin(client, connectTimeoutMs, () => socket?.destroy());
        return await inReadOnlyTransaction(client, timeoutMs, connectionString, work);
      } catch (err) {
        throw sanitizeDatabaseError(err, connectionString);
      } finally {
        if (client !== undefined) {
          // Ending can fail if the server already dropped us, or never finish if the peer went
          // silent; either way there is nothing left to clean up but the socket.
          await Promise.race([client.end().catch(() => undefined), delay(CLOSE_TIMEOUT_MS)]);
          socket?.destroy();
        }
      }
    },
  };
}

/**
 * `client.connect()`, bounded by our own timer: the driver's connectionTimeoutMillis reports a
 * bare "timeout expired". On timeout the socket is destroyed, which also ends the pending connect.
 */
async function connectWithin(
  client: Client,
  timeoutMs: number,
  destroySocket: () => void,
): Promise<void> {
  const connecting = client.connect();
  let timer: NodeJS.Timeout | undefined;
  const timedOut = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(connectTimeoutError(timeoutMs));
    }, timeoutMs);
  });
  try {
    await Promise.race([connecting, timedOut]);
  } catch (err) {
    // The losing connect attempt rejects once its socket is gone; nobody is waiting for it.
    connecting.catch(() => undefined);
    destroySocket();
    throw err;
  } finally {
    clearTimeout(timer);
  }
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

  await client.query(BEGIN_SNAPSHOT_READ_ONLY);
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

function validTimeout(ms: number, what: string): number {
  if (!Number.isInteger(ms) || ms < 1 || ms > MAX_STATEMENT_TIMEOUT_MS) {
    throw new DatabaseError(
      'configuration',
      `${what} must be a whole number of milliseconds between 1 and ${MAX_STATEMENT_TIMEOUT_MS}`,
    );
  }
  return ms;
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
