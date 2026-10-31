/**
 * Command-line arguments of the bin. Without arguments it is an MCP server on stdio; `--help` and
 * `--version` print to stdout and exit, which is safe because no MCP session is running then.
 */
import { PACKAGE_NAME, PACKAGE_VERSION } from './package-info.js';

export type CliCommand =
  { kind: 'serve' } | { kind: 'help' } | { kind: 'version' } | { kind: 'error'; message: string };

export function parseCliArgs(args: readonly string[]): CliCommand {
  const [first, ...rest] = args;
  if (first === undefined) return { kind: 'serve' };
  if (rest.length > 0) return usageError(`unexpected arguments: ${args.join(' ')}`);
  switch (first) {
    case '--help':
    case '-h':
      return { kind: 'help' };
    case '--version':
    case '-v':
      return { kind: 'version' };
    default:
      return usageError(`unknown argument: ${first}`);
  }
}

function usageError(problem: string): CliCommand {
  return { kind: 'error', message: `${PACKAGE_NAME}: ${problem}. Run with --help for usage.` };
}

export function helpText(): string {
  return `${PACKAGE_NAME} ${PACKAGE_VERSION}

MCP server (stdio) that checks whether Postgres/Supabase migrations were really applied, by
comparing what each migration file should create with the live pg_catalog. Read-only by
construction: every query runs in a READ ONLY transaction and no migration SQL is ever executed.

Usage:
  ${PACKAGE_NAME}            start the MCP server on stdin/stdout (normally run by an MCP client)
  ${PACKAGE_NAME} --help     show this help
  ${PACKAGE_NAME} --version  print the version

Environment:
  PGMV_DATABASE_URL          postgres:// URL, ideally of a read-only role (preferred)
  DATABASE_URL               used when PGMV_DATABASE_URL is not set
  PGMV_PROJECT_DIR           project directory (default: the current directory)
  PGMV_MIGRATIONS_DIR        migrations directory, relative to the project (default: supabase/migrations)
  PGMV_DEFAULT_SCHEMA        schema for unqualified names (default: public)
  PGMV_STATEMENT_TIMEOUT_MS  per-query timeout in milliseconds (default: 15000)

Tools: list_repo_migrations, list_recorded_migrations, diff_history, expected_objects,
verify_migration, verify_all.
`;
}
