import type { RecordedHistory, RecordedMigration } from '../model.js';
import type { QueryRunner, ReadOnlyDatabase } from './db.js';
import { DatabaseError } from './errors.js';
import { HISTORY_TABLE, HISTORY_WITHOUT_NAME, HISTORY_WITH_NAME } from './queries.js';

/** The table the Supabase CLI records applied migrations in. */
export const HISTORY_TABLE_NAME = 'supabase_migrations.schema_migrations';

const NOT_READABLE_REASON =
  'the connected role lacks USAGE on schema supabase_migrations or SELECT on schema_migrations';

/**
 * Reads which migration versions the Supabase CLI recorded as applied, sorted by version.
 *
 * The recommended read-only role has no grants, so "cannot read" is an expected outcome, not an
 * error: privileges are checked up front, and a 42501 raised anyway (a grant revoked between the
 * check and the read) is reported the same way. Missing or unreadable history only means the
 * report cannot say whether each file was recorded; the catalog checks still run.
 */
export async function loadRecordedHistory(db: ReadOnlyDatabase): Promise<RecordedHistory> {
  return db.readOnly(readRecordedHistory);
}

/**
 * `loadRecordedHistory` inside a transaction the caller already opened.
 *
 * Run it last in that transaction: if the read fails with 42501 anyway, Postgres aborts the
 * transaction, so later queries in it would fail. (The failure itself is reported as
 * `not_readable`, like in `loadRecordedHistory`.)
 */
export async function readRecordedHistory(q: QueryRunner): Promise<RecordedHistory> {
  try {
    const [table] = await q.run(HISTORY_TABLE);
    if (table === undefined) return { status: 'missing', table: HISTORY_TABLE_NAME };
    if (!table.readable) {
      return { status: 'not_readable', table: HISTORY_TABLE_NAME, reason: NOT_READABLE_REASON };
    }
    const migrations: RecordedMigration[] = table.has_name_column
      ? (await q.run(HISTORY_WITH_NAME)).map((r) => ({ version: r.version, name: r.name }))
      : (await q.run(HISTORY_WITHOUT_NAME)).map((r) => ({ version: r.version, name: null }));
    // Code-point order: versions are digit strings, and the server's collation must not matter.
    migrations.sort((a, b) => (a.version < b.version ? -1 : a.version > b.version ? 1 : 0));
    return { status: 'ok', table: HISTORY_TABLE_NAME, migrations };
  } catch (err) {
    if (err instanceof DatabaseError && err.category === 'permission') {
      return { status: 'not_readable', table: HISTORY_TABLE_NAME, reason: NOT_READABLE_REASON };
    }
    throw err;
  }
}
