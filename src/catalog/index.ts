/**
 * Database access for pg-migration-verify: read-only connections, the pg_catalog snapshot and
 * the recorded migration history. Query text and decoders stay internal to this directory.
 */
export { createDatabase } from './db.js';
export type { DatabaseOptions, QueryRunner, ReadOnlyDatabase } from './db.js';
export { DatabaseError, redactSecrets, sanitizeDatabaseError } from './errors.js';
export type { DatabaseErrorCategory } from './errors.js';
export { HISTORY_TABLE_NAME, loadRecordedHistory } from './history.js';
export type { CatalogQuery } from './queries.js';
export { loadCatalogSnapshot } from './snapshot.js';
