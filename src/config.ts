import path from 'node:path';

/**
 * Server configuration, read once from the environment. The database URL is the only secret the
 * server holds: it lives in `databaseUrl` and nowhere else, and `describeConfig` is the only
 * sanctioned way to talk about it (by the variable that supplied it, never by value).
 */
export interface Config {
  /** null when no usable URL was supplied; tools that need the database then explain how to set one. */
  databaseUrl: string | null;
  databaseUrlSource: 'PGMV_DATABASE_URL' | 'DATABASE_URL' | null;
  /** Absolute directory that relative paths (from env or tool arguments) are resolved against. */
  projectDir: string;
  /** Absolute path of the default migrations directory. */
  migrationsDir: string;
  /** Schema assumed for unqualified names in migrations. */
  defaultSchema: string;
  statementTimeoutMs: number;
}

const DEFAULT_MIGRATIONS_DIR = path.join('supabase', 'migrations');
const DEFAULT_SCHEMA = 'public';
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
/** Postgres stores `statement_timeout` as a 32-bit int of milliseconds. */
const MAX_STATEMENT_TIMEOUT_MS = 2_147_483_647;

/**
 * Returns a trimmed setting, or null when it is effectively unset. Claude Code leaves an unset
 * `${VAR}` in a plugin's `.mcp.json` as literal text, and an empty plugin option arrives as an
 * empty string; neither must shadow a real value from a fallback variable.
 */
function setting(env: NodeJS.ProcessEnv, name: string): string | null {
  const value = env[name]?.trim();
  if (value === undefined || value === '' || value.startsWith('${')) return null;
  return value;
}

/**
 * Builds the configuration from environment variables:
 * - database URL: `PGMV_DATABASE_URL`, else `DATABASE_URL` (the dedicated variable wins so a
 *   read-only URL can be given to this server without changing the app's own `DATABASE_URL`);
 * - project dir: `PGMV_PROJECT_DIR`, else `cwd`;
 * - migrations dir: `PGMV_MIGRATIONS_DIR` relative to the project dir, else `supabase/migrations`;
 * - `PGMV_DEFAULT_SCHEMA` (default `public`) and `PGMV_STATEMENT_TIMEOUT_MS` (default 15000).
 *
 * @throws Error when `PGMV_STATEMENT_TIMEOUT_MS` is set but is not a positive integer.
 */
export function readConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
  const dedicatedUrl = setting(env, 'PGMV_DATABASE_URL');
  const genericUrl = setting(env, 'DATABASE_URL');
  const projectDir = path.resolve(cwd, setting(env, 'PGMV_PROJECT_DIR') ?? '.');

  return {
    databaseUrl: dedicatedUrl ?? genericUrl,
    databaseUrlSource:
      dedicatedUrl !== null ? 'PGMV_DATABASE_URL' : genericUrl !== null ? 'DATABASE_URL' : null,
    projectDir,
    migrationsDir: path.resolve(
      projectDir,
      setting(env, 'PGMV_MIGRATIONS_DIR') ?? DEFAULT_MIGRATIONS_DIR,
    ),
    defaultSchema: setting(env, 'PGMV_DEFAULT_SCHEMA') ?? DEFAULT_SCHEMA,
    statementTimeoutMs: parseTimeout(setting(env, 'PGMV_STATEMENT_TIMEOUT_MS')),
  };
}

function parseTimeout(raw: string | null): number {
  if (raw === null) return DEFAULT_STATEMENT_TIMEOUT_MS;
  const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!(value >= 1 && value <= MAX_STATEMENT_TIMEOUT_MS)) {
    throw new Error(
      `PGMV_STATEMENT_TIMEOUT_MS must be a whole number of milliseconds between 1 and ` +
        `${MAX_STATEMENT_TIMEOUT_MS}, got "${raw}".`,
    );
  }
  return value;
}

/**
 * Resolves a directory passed to a tool. Relative paths are taken from the project directory, not
 * the server's working directory, because MCP clients start servers from arbitrary places.
 */
export function resolveDirectory(config: Config, dir?: string): string {
  const trimmed = dir?.trim();
  return trimmed === undefined || trimmed === ''
    ? config.migrationsDir
    : path.resolve(config.projectDir, trimmed);
}

/**
 * A multi-line summary that is safe to show in tool output and logs: it names the variable that
 * supplied the database URL but never includes the URL, which may embed a password.
 */
export function describeConfig(config: Config): string {
  const database =
    config.databaseUrlSource === null
      ? 'not set (set PGMV_DATABASE_URL or DATABASE_URL; a read-only role is recommended)'
      : `from ${config.databaseUrlSource} (value hidden)`;
  return [
    `Database URL: ${database}`,
    `Project directory: ${config.projectDir}`,
    `Migrations directory: ${config.migrationsDir}`,
    `Default schema: ${config.defaultSchema}`,
    `Statement timeout: ${config.statementTimeoutMs} ms`,
  ].join('\n');
}
