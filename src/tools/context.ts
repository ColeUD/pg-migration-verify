import { createDatabase, type ReadOnlyDatabase } from '../catalog/index.js';
import type { Config } from '../config.js';

/**
 * What a tool handler may use. Handlers never read the environment or create connections
 * themselves, so tests can hand them a fake database and a temporary project directory.
 */
export interface ToolContext {
  config: Config;
  /** The configured database, or null when no URL is configured. Nothing connects until used. */
  openDatabase(): ReadOnlyDatabase | null;
}

/** A handler's result: text for people (and models) to read, and the same facts as data. */
export interface ToolResult<Structured> {
  text: string;
  structured: Structured;
}

export const NO_DATABASE_MESSAGE =
  'No database connection configured. Set PGMV_DATABASE_URL (preferred) or DATABASE_URL to a ' +
  'postgres:// URL for a read-only role; see the README section "Read-only role".';

/** Thrown when a tool that reads the catalog runs without a configured database URL. */
export class NoDatabaseError extends Error {
  override readonly name = 'NoDatabaseError';

  constructor() {
    super(NO_DATABASE_MESSAGE);
  }
}

/**
 * The production context: the database handle is created on first use and reused, which is cheap
 * because a `ReadOnlyDatabase` opens a fresh connection per `readOnly()` call anyway.
 */
export function createToolContext(config: Config): ToolContext {
  let database: ReadOnlyDatabase | undefined;
  return {
    config,
    openDatabase(): ReadOnlyDatabase | null {
      if (config.databaseUrl === null) return null;
      database ??= createDatabase(config.databaseUrl, {
        statementTimeoutMs: config.statementTimeoutMs,
      });
      return database;
    },
  };
}

/** @throws NoDatabaseError when no database URL is configured. */
export function requireDatabase(context: ToolContext): ReadOnlyDatabase {
  const database = context.openDatabase();
  if (database === null) throw new NoDatabaseError();
  return database;
}
