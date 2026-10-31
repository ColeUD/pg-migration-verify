import { realpath } from 'node:fs/promises';
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
  /**
   * Whether the `dir` argument of a tool may point outside the project directory and the
   * configured migrations directory (`PGMV_ALLOW_OUTSIDE_PROJECT=1`). Off by default: the
   * argument comes from the model, which a prompt injection can steer.
   */
  allowOutsideProject: boolean;
  /** Whether the connection will use TLS; null without a database URL. */
  tls: TlsSetting | null;
}

/**
 * What the `pg` driver will do about TLS for the configured URL. Unlike libpq (`sslmode=prefer`),
 * `pg` connects without encryption unless the URL or `PGSSLMODE` asks for TLS, so the startup log
 * says which one applies.
 */
export interface TlsSetting {
  /** true: encrypted; false: plain TCP; null: the URL could not be read to tell. */
  encrypted: boolean | null;
  /**
   * Where the decision comes from, safe to log: only parameter names and recognized `sslmode`
   * values, never the URL, its host or anything else from it.
   */
  detail: string;
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
 * - `PGMV_DEFAULT_SCHEMA` (default `public`) and `PGMV_STATEMENT_TIMEOUT_MS` (default 15000);
 * - `PGMV_ALLOW_OUTSIDE_PROJECT` (`1` or `true`) lets tools read directories anywhere.
 *
 * @throws Error when `PGMV_STATEMENT_TIMEOUT_MS` is set but is not a positive integer.
 */
export function readConfig(env: NodeJS.ProcessEnv, cwd: string): Config {
  const dedicatedUrl = setting(env, 'PGMV_DATABASE_URL');
  const genericUrl = setting(env, 'DATABASE_URL');
  const projectDir = path.resolve(cwd, setting(env, 'PGMV_PROJECT_DIR') ?? '.');
  const databaseUrl = dedicatedUrl ?? genericUrl;

  return {
    databaseUrl,
    databaseUrlSource:
      dedicatedUrl !== null ? 'PGMV_DATABASE_URL' : genericUrl !== null ? 'DATABASE_URL' : null,
    projectDir,
    migrationsDir: path.resolve(
      projectDir,
      setting(env, 'PGMV_MIGRATIONS_DIR') ?? DEFAULT_MIGRATIONS_DIR,
    ),
    defaultSchema: setting(env, 'PGMV_DEFAULT_SCHEMA') ?? DEFAULT_SCHEMA,
    statementTimeoutMs: parseTimeout(setting(env, 'PGMV_STATEMENT_TIMEOUT_MS')),
    allowOutsideProject: /^(1|true)$/i.test(setting(env, 'PGMV_ALLOW_OUTSIDE_PROJECT') ?? ''),
    tls: databaseUrl === null ? null : readTlsSetting(databaseUrl, env.PGSSLMODE),
  };
}

/** The `sslmode` values `pg` understands; anything else is not repeated in logs. */
const SSL_MODES = new Set([
  'disable',
  'prefer',
  'require',
  'verify-ca',
  'verify-full',
  'no-verify',
]);
const LOCAL_HOSTS = new Set(['', 'localhost', '127.0.0.1', '[::1]']);

/**
 * Mirrors how `pg` 8 (pg-connection-string, then ConnectionParameters) decides on TLS: the URL's
 * `sslmode`, `ssl`, `sslrootcert`/`sslcert`/`sslkey` and `sslnegotiation=direct` parameters, and
 * only when the URL sets none of them, the `PGSSLMODE` environment variable; otherwise no TLS.
 */
export function readTlsSetting(databaseUrl: string, pgSslMode: string | undefined): TlsSetting {
  const url = parseUrl(databaseUrl);
  if (url === null) {
    return { encrypted: null, detail: 'the connection string could not be read to tell' };
  }
  const params = url.searchParams;

  const sslmode = params.get('sslmode');
  if (sslmode !== null) return fromSslMode(sslmode, 'in the connection string');
  for (const name of ['sslrootcert', 'sslcert', 'sslkey']) {
    if (params.has(name)) return { encrypted: true, detail: `${name} in the connection string` };
  }
  const ssl = params.get('ssl');
  if (ssl === '0') return { encrypted: false, detail: 'ssl=0 in the connection string' };
  if (ssl !== null) return { encrypted: true, detail: 'ssl parameter in the connection string' };
  if (params.get('sslnegotiation') === 'direct') {
    return { encrypted: true, detail: 'sslnegotiation=direct in the connection string' };
  }
  if (pgSslMode !== undefined && SSL_MODES.has(pgSslMode)) {
    return fromSslMode(pgSslMode, 'from PGSSLMODE');
  }

  // A `host` parameter replaces the URL's host; one starting with / is a Unix socket.
  const host = params.get('host') ?? (url.hostname === EMPTY_HOST ? '' : url.hostname);
  const local = LOCAL_HOSTS.has(host) || host === '::1' || host.startsWith('/');
  return {
    encrypted: false,
    detail: local
      ? 'no sslmode in the connection string or PGSSLMODE; fine for a local server'
      : 'no sslmode in the connection string or PGSSLMODE, so traffic to the database server ' +
        'is unencrypted; add sslmode=verify-full',
  };
}

const EMPTY_HOST = 'empty-host.invalid';

/**
 * `new URL`, also for `postgres://user@/db?host=/socket`, which pg accepts but WHATWG URLs reject
 * for having credentials without a host.
 */
function parseUrl(databaseUrl: string): URL | null {
  try {
    return new URL(databaseUrl);
  } catch {
    try {
      return new URL(databaseUrl.replace('@/', `@${EMPTY_HOST}/`));
    } catch {
      return null;
    }
  }
}

function fromSslMode(mode: string, where: string): TlsSetting {
  if (mode === 'disable') return { encrypted: false, detail: `sslmode=disable ${where}` };
  if (!SSL_MODES.has(mode)) return { encrypted: true, detail: `unrecognized sslmode ${where}` };
  const unverified = mode === 'no-verify' ? '; the server certificate is not verified' : '';
  return { encrypted: true, detail: `sslmode=${mode} ${where}${unverified}` };
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
 *
 * The argument comes from the model, so it must stay inside the project directory or the
 * configured migrations directory (which the user chose and may lie elsewhere), also after
 * following symbolic links and junctions. Otherwise any directory of `.sql` files on the machine,
 * such as database dumps, could be read through the tools' statement excerpts.
 *
 * @throws Error, without the resolved path, when the directory is outside both.
 */
export async function resolveDirectory(config: Config, dir?: string): Promise<string> {
  const trimmed = dir?.trim();
  if (trimmed === undefined || trimmed === '') return config.migrationsDir;
  const resolved = path.resolve(config.projectDir, trimmed);
  if (config.allowOutsideProject) return resolved;

  const roots = [config.projectDir, config.migrationsDir];
  let allowed = roots.some((root) => isWithin(resolved, root));
  const real = await realpath(resolved).catch(() => null);
  if (allowed && real !== null) {
    const realRoots = await Promise.all(roots.map((root) => realpath(root).catch(() => root)));
    allowed = realRoots.some((root) => isWithin(real, root));
  }
  if (!allowed) {
    throw new Error(
      'dir must be inside the project directory (PGMV_PROJECT_DIR) or the configured migrations ' +
        'directory (PGMV_MIGRATIONS_DIR); set PGMV_ALLOW_OUTSIDE_PROJECT=1 to allow other directories.',
    );
  }
  return resolved;
}

/** Whether `target` is `root` or below it. A different drive on Windows is never within. */
function isWithin(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * A multi-line summary that is safe to show in tool output and logs: it names the variable that
 * supplied the database URL but never includes the URL, which may embed a password, and says
 * whether the connection is encrypted without naming the host.
 */
export function describeConfig(config: Config): string {
  const database =
    config.databaseUrlSource === null
      ? 'not set (set PGMV_DATABASE_URL or DATABASE_URL; a read-only role is recommended)'
      : `from ${config.databaseUrlSource} (value hidden)`;
  const tls = config.tls === null ? [] : [`TLS: ${describeTls(config.tls)}`];
  return [
    `Database URL: ${database}`,
    ...tls,
    `Project directory: ${config.projectDir}`,
    `Migrations directory: ${config.migrationsDir}`,
    `Default schema: ${config.defaultSchema}`,
    `Statement timeout: ${config.statementTimeoutMs} ms`,
  ].join('\n');
}

function describeTls(tls: TlsSetting): string {
  const state = tls.encrypted === null ? 'unknown' : tls.encrypted ? 'on' : 'off';
  return `${state} (${tls.detail})`;
}
