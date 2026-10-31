# pg-migration-verify

**An MCP server that tells your coding agent whether a Postgres/Supabase migration was really applied, by checking every object it should create against `pg_catalog`. Read-only by construction.**

[![CI](https://github.com/OWNER/pg-migration-verify/actions/workflows/ci.yml/badge.svg)](https://github.com/OWNER/pg-migration-verify/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/pg-migration-verify.svg)](https://www.npmjs.com/package/pg-migration-verify)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why

On many Supabase projects, `supabase_migrations.schema_migrations` does not match the repository. Migrations pasted into the Supabase SQL editor run, but they never land in the history table; a migration recorded by the CLI can still have been edited by hand afterwards. So the history table cannot answer "is migration X applied?". Answering it by hand means writing one catalog query per table, column, index and policy, then counting until you get `MATCH 73/73`. This server does that counting for Claude Code and any other MCP client: it parses each migration with the real Postgres parser, works out what should exist today, and compares that with the live catalog.

<!-- DEMO: replace with asciinema/GIF -->

> Demo recording coming soon.

## Contents

- [30-second quickstart](#30-second-quickstart)
- [Tools](#tools)
- [Example output](#example-output)
- [How it works](#how-it-works)
- [Safety model](#safety-model)
- [Read-only role](#read-only-role)
- [Configuration](#configuration)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Roadmap](#roadmap) and [License](#license)

## 30-second quickstart

Requires Node.js 22 or later. The server runs with `npx`, so there is nothing else to install. Create a [read-only role](#read-only-role) first; any `postgres://` or `postgresql://` URL works, but a read-only role is strongly recommended.

### Claude Code: plugin (recommended)

The repository is its own plugin marketplace. In Claude Code:

```text
/plugin marketplace add OWNER/pg-migration-verify
/plugin install pg-migration-verify@pg-migration-verify
```

The plugin has one option, `database_url`. It is marked sensitive, so Claude Code keeps it in its credential store rather than in `settings.json`. Set it (or change it later) with:

```bash
claude plugin configure pg-migration-verify@pg-migration-verify
```

The plugin passes the option to the server as `PGMV_DATABASE_URL` and points `PGMV_PROJECT_DIR` at the current project, so migrations are read from `<project>/supabase/migrations`. Leave the option empty and the server falls back to `DATABASE_URL` from the environment Claude Code was started in.

Then run the bundled skill, optionally with a migration file name, version or name:

```text
/pg-migration-verify:verify-migrations
/pg-migration-verify:verify-migrations 20240305120000
```

Or just ask: "Was the create_tasks migration really applied?" The server's instructions steer the model to `verify_migration` / `verify_all` rather than the history table.

### Claude Code: plain MCP server

Without the plugin (no skill, same tools):

```bash
claude mcp add --env "PGMV_DATABASE_URL=postgresql://pg_migration_verify:<password>@<host>:5432/postgres" \
  --scope local --transport stdio pgmv -- npx -y pg-migration-verify@0.1.0
```

Keep another option between `--env` and the server name `pgmv`; otherwise `claude mcp add` reads `pgmv` as a second environment variable. Migrations are looked up in `supabase/migrations` under the server's working directory. If `list_repo_migrations` shows the wrong directory, add `--env PGMV_PROJECT_DIR=/path/to/your/app`.

Tool names, for permission rules: `mcp__plugin_pg-migration-verify_pgmv__<tool>` when installed as a plugin, `mcp__pgmv__<tool>` when added with `claude mcp add`.

### Claude Desktop

Add the server to `claude_desktop_config.json` (Settings, Developer, Edit Config; on Windows the file is `%APPDATA%\Claude\claude_desktop_config.json`, on macOS `~/Library/Application Support/Claude/claude_desktop_config.json`), then quit and restart Desktop:

```json
{
  "mcpServers": {
    "pgmv": {
      "command": "npx",
      "args": ["-y", "pg-migration-verify@0.1.0"],
      "env": {
        "PGMV_DATABASE_URL": "postgresql://pg_migration_verify:<password>@db.<project-ref>.supabase.co:5432/postgres",
        "PGMV_PROJECT_DIR": "/absolute/path/to/your/app"
      }
    }
  }
}
```

Desktop has no project directory and does not expand `${VAR}` references, so both values are written literally. This file then holds the password in plain text, which is one more reason to use a read-only role.

If the server fails to start on Windows, try wrapping `npx` in `cmd`: `"command": "cmd"` and `"args": ["/c", "npx", "-y", "pg-migration-verify@0.1.0"]`. This is a commonly reported workaround that has not been verified for this package. The server's log is `%APPDATA%\Claude\logs\mcp-server-pgmv.log`.

## Tools

Every tool is read-only and annotated `readOnlyHint: true`. Each returns readable text plus the same facts as `structuredContent` (with an `outputSchema`), so an agent can branch on a verdict without parsing text.

| Tool                       | What it answers                                                                                                                                       | Needs DB? |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| `verify_all`               | Which migrations are really applied? Summary table for every file, the full report of each MISMATCH, and totals that flag "applied but NOT recorded". | Yes       |
| `verify_migration`         | Is this one migration applied? `MATCH n/n` or `MISMATCH n/n`, each problem object with its line. `verbose: true` also lists matches.                  | Yes       |
| `diff_history`             | Do the files and `supabase_migrations.schema_migrations` agree? Versions only in the repo, only in the database, or recorded under another name.      | Yes       |
| `list_recorded_migrations` | What did the Supabase CLI record as applied? Reports a missing or unreadable history table as a result, not an error.                                 | Yes       |
| `expected_objects`         | What should this migration leave in the database? Every expected object with its line, plus statements that cannot be checked.                        | No        |
| `list_repo_migrations`     | Which migration files exist? Sorted by version, with sha256, misnamed `.sql` files the CLI would skip, and duplicate versions.                        | No        |

Arguments: `dir` (optional, every tool except `list_recorded_migrations`) overrides the migrations directory, relative to the project directory. `file` (`verify_migration`, `expected_objects`) accepts the file name, a path ending in it, the version or the name; only exact matches count. `verbose` (`verify_migration`, `verify_all`) also lists matching objects and ignored statements.

## Example output

`verify_all` against a database whose history records 4 of 8 migrations and which was then edited by hand. This text is produced by an [integration test](test/integration/demo-app.test.ts) against a real Postgres with [synthetic migrations](test/integration/fixtures/demo-app/supabase/migrations), and CI fails if it drifts from [docs/example-output.txt](docs/example-output.txt).

```text
VERSION         NAME                             RESULT             MATCHED  SUPERSEDED  UNVERIFIABLE  HISTORY
20240301090000  create_organizations             MATCH              23/23    0           0             recorded
20240301091500  create_profiles_and_memberships  MATCH              20/20    1           0             recorded
20240302100000  create_projects                  MATCH              18/18    0           0             NOT RECORDED
20240305120000  create_tasks                     MISMATCH           21/23    1           0             recorded
20240310083000  create_comments                  MISMATCH           12/14    9           2             NOT RECORDED
20240315140000  task_details_and_search          MISMATCH           5/6      0           1             recorded
20240320090000  rework_profiles_and_tasks        MATCH              6/6      0           0             NOT RECORDED
20240322100000  seed_plans                       NOTHING TO VERIFY  -        0           2             NOT RECORDED

8 migrations: 4 MATCH, 3 MISMATCH, 1 nothing to verify. 2 applied but NOT recorded in history.
2 recorded in history but MISMATCH: 20240305120000_create_tasks.sql, 20240315140000_task_details_and_search.sql
Skipped 1 .sql file not named <version>_<name>.sql (never applied by the Supabase CLI): add_billing_draft.sql

MISMATCH 21/23  20240305120000_create_tasks.sql
  MISSING    line 5   column public.tasks.due_on (date, nullable)
  MISSING    line 18  index public.tasks_project_status_idx (on public.tasks (project_id, status), using btree)
  SUPERSEDED line 19  index public.tasks_assignee_idx: dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 12
  history: recorded in supabase_migrations.schema_migrations

MISMATCH 12/14  20240310083000_create_comments.sql
  MISSING      line 26  policy "Authors write comments" on public.comments (for INSERT, to authenticated)
  DIFFERENT    line 3   column public.comments.body: nullability expected not null, found nullable
  SUPERSEDED   line 34  table public.task_events: dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  column public.task_events.id: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  primary key on public.task_events (id): table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  column public.task_events.task_id: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  foreign key on public.task_events (task_id): table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  column public.task_events.kind: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  column public.task_events.payload: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 34  column public.task_events.created_at: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  SUPERSEDED   line 42  index public.task_events_task_id_idx: table public.task_events dropped or renamed by 20240320090000_rework_profiles_and_tasks.sql line 16
  UNVERIFIABLE line 30  GrantStmt: privileges are not checked
  UNVERIFIABLE line 32  CommentStmt: comments are not checked
  history: NOT recorded in supabase_migrations.schema_migrations

MISMATCH 5/6  20240315140000_task_details_and_search.sql
  MISSING      line 15  function public.search_tasks(text)
                        note: found other signatures: search_tasks(text, integer)
  UNVERIFIABLE line 10  UpdateStmt: data change, not a schema object
  history: recorded in supabase_migrations.schema_migrations
```

How to read it:

| Word                | Meaning                                                                                                                                                             |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MATCH n/n`         | Every object the migration should leave behind exists as written. In verbose output, `MATCH` on a single object means that object checked out.                      |
| `MISMATCH m/n`      | At least one checked object is MISSING, DIFFERENT or UNEXPECTED; `m` of `n` checks passed.                                                                          |
| `MISSING`           | Expected to exist, not found.                                                                                                                                       |
| `DIFFERENT`         | Found, but an attribute the migration asserts differs: column type or nullability, index columns or method, policy command or roles, and so on.                     |
| `UNEXPECTED`        | The migration drops or renames the object, but it still exists.                                                                                                     |
| `SUPERSEDED`        | A later migration drops or renames the object, so it is checked there instead. Not a problem, and not counted in `n`.                                               |
| `UNVERIFIABLE`      | A statement that cannot be turned into a catalog check (GRANT, COMMENT, data changes, dynamic SQL). Review it by hand.                                              |
| `NOTHING TO VERIFY` | No statement in the file yields a catalog check, as with a seed file.                                                                                               |
| `HISTORY`           | Whether the version is in `supabase_migrations.schema_migrations`: `recorded`, `NOT RECORDED`, or `-` when the history table is missing or the role cannot read it. |

**"Applied but NOT recorded"** counts migrations whose objects all exist (MATCH) while the history table has no row for their version: typically SQL pasted into the Supabase SQL editor. The opposite, **"recorded in history but MISMATCH"**, lists migrations the history table claims are applied whose objects are not all there: a partial apply, or a hand edit afterwards. Those are the two cases the history table alone gets wrong.

## How it works

```text
 supabase/migrations/<version>_<name>.sql
                  |
                  v
 libpg-query: the Postgres 18 parser compiled to WASM (the SQL is parsed, never run)
                  |
                  v
 expected objects per file: net effect of its statements, each with its line
                  |
                  v
 timeline across files: a later DROP/RENAME -> SUPERSEDED, a later ALTER updates the expectation
                  |
                  v
 compare with a pg_catalog snapshot  <--  one BEGIN READ ONLY ... ROLLBACK per tool call
                  |                       (catalog snapshot + recorded history)
                  v
 report: MATCH n/n or MISMATCH m/n with per-object lines, as text and structuredContent
```

- **A real parser, not regexes.** [libpg-query](https://github.com/constructive-io/libpg-query-node) is the actual Postgres parser, so dollar quoting, quoted identifiers, `CREATE SCHEMA ... CREATE TABLE` and `DO $$ ... $$` bodies (through the PL/pgSQL parser) are read exactly as the server reads them. Every statement yields expected objects, an `unverifiable` or `ignored` note, or both; nothing is silently dropped.
- **`pg_catalog`, not `information_schema`.** `information_schema` hides objects the connected role has no privileges on, so a least-privilege role would see existing tables as missing. `pg_catalog` is readable by `PUBLIC`, and every query joins by name rather than casting to `::regclass`, which would need schema privileges.
- **Types in `format_type()` spelling.** Migration types are normalized to what the catalog prints (`int4` becomes `integer`, `varchar(255)` becomes `character varying(255)`, `timestamptz` becomes `timestamp with time zone`). The catalog is read with `search_path = ''`, so user types come back schema-qualified, and a bare `job_status` in a migration matches `public.job_status`.
- **Net effect per file, then a timeline.** Within one file, `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN` and `DROP INDEX` fold into one expectation per object. Across files, each migration is judged on what should still hold today: a table dropped two migrations later is SUPERSEDED, not MISSING, and a column whose type a later migration changes is checked against the new type.
- **One consistent read.** The catalog snapshot and the history table are read in the same read-only transaction, on a fresh connection that is closed afterwards.

## Safety model

These are hard rules, enforced in code and covered by tests:

- **Read-only by construction.** Every query runs inside `BEGIN READ ONLY` and is rolled back, never committed. SQL exists only as vetted constant `SELECT` queries in [src/catalog/queries.ts](src/catalog/queries.ts) (the query runner accepts nothing else), and user input only travels as bind parameters. The server never runs user-supplied SQL, migration files included: they are parsed, never executed. There is no write tool.
- **The connection string stays secret.** It comes only from `PGMV_DATABASE_URL` or `DATABASE_URL`, never from a tool argument. It is never logged, echoed in tool output, or included in error messages: database errors are mapped to safe categories, and every error text is scrubbed of the URL, password, host and port before it leaves the server. A test throws eight error forms at every tool and checks that none leaks.
- **No real data or credentials.** Everything in this repository, its tests and its examples is synthetic; passwords are placeholders such as `test-only-password`.

`BEGIN READ ONLY` protects against mistakes in this tool; the role you connect as is what protects your database. Use the role below.

## Read-only role

The tool needs no table, sequence or function privileges, because `pg_catalog` is readable by `PUBLIC`. Run this as an admin role (on Supabase: in the SQL editor, as `postgres`):

```sql
CREATE ROLE pg_migration_verify WITH LOGIN PASSWORD '<generated password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
-- INHERIT is the default; keep it.
ALTER ROLE pg_migration_verify SET default_transaction_read_only = on;
ALTER ROLE pg_migration_verify SET statement_timeout = '15s';
GRANT CONNECT ON DATABASE postgres TO pg_migration_verify;

-- Only for the history column and diff_history / list_recorded_migrations:
GRANT USAGE ON SCHEMA supabase_migrations TO pg_migration_verify;
GRANT SELECT ON supabase_migrations.schema_migrations TO pg_migration_verify;
```

- **Do not grant `pg_read_all_data`.** It gives `SELECT` on every row of user data, and this tool never reads user data.
- Without the two history grants every catalog check still works; the `HISTORY` column shows `-` and the history tools explain which grant is missing.
- `default_transaction_read_only` is defence in depth, not a boundary: any session can turn it off. The real protection is that the role owns nothing and has no write privileges.
- The integration tests connect as exactly this kind of role, with no grants at all, and a 44-statement migration covering every supported object kind still verifies as `MATCH 169/169`.

### Supabase connection notes

- **Direct connection:** `db.<project-ref>.supabase.co:5432`, IPv6 only unless your project has the IPv4 add-on.
- **Session pooler (Supavisor):** port `5432` on the pooler host, works over IPv4. The user name carries the project ref (`pg_migration_verify.<project-ref>`). Copy the exact host and user format from the dashboard's Connect panel.
- **Transaction pooler** (port `6543`) has not been tested; prefer the direct connection or the session pooler.
- **TLS:** the `pg` driver treats `sslmode=require` as `verify-full`, which checks the server certificate against the CAs Node trusts. If the connection fails with a certificate error, download the CA certificate from the Supabase dashboard (Database settings, SSL configuration) and use `?sslmode=verify-full&sslrootcert=/path/to/ca.crt`. `sslmode=no-verify` encrypts without verifying the server and is not recommended.

## Configuration

All configuration is read from environment variables at startup. A value that is empty, or an unexpanded `${...}` placeholder left by a client, counts as unset.

| Variable                    | Default                        | Purpose                                                                                                                 |
| --------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `PGMV_DATABASE_URL`         | none                           | `postgres://` or `postgresql://` URL, ideally of the read-only role. Takes precedence over `DATABASE_URL`.              |
| `DATABASE_URL`              | none                           | Used when `PGMV_DATABASE_URL` is unset, so the app's own variable works without a second copy.                          |
| `PGMV_PROJECT_DIR`          | the server's working directory | Directory that relative paths (the variable below and the `dir` tool argument) are resolved against.                    |
| `PGMV_MIGRATIONS_DIR`       | `supabase/migrations`          | Migrations directory, relative to the project directory.                                                                |
| `PGMV_DEFAULT_SCHEMA`       | `public`                       | Schema for unqualified names in migrations.                                                                             |
| `PGMV_STATEMENT_TIMEOUT_MS` | `15000`                        | Per-statement timeout inside each read-only transaction. Must be a whole number from 1 to 2147483647, or startup fails. |

Without a database URL the server still starts: `list_repo_migrations` and `expected_objects` work, and the other tools return an error explaining how to configure one. On startup the server logs one line to stderr naming the variable that supplied the URL (never its value) and the directories it uses. `npx pg-migration-verify --help` lists the variables; `--version` prints the version.

## Known limitations

pg-migration-verify checks schema objects, and is honest about what it cannot see. These are reported as `UNVERIFIABLE` or simply not compared:

- **Not checked:** privileges (`GRANT`, `REVOKE`, default privileges), ownership, roles, comments, publications, function bodies and attributes (only the signature is checked), column defaults, sequence options, partial-index predicates and `INCLUDE` columns, data changes (`INSERT`, `UPDATE`, `DELETE`, `COPY`, ...), and dynamic SQL (`EXECUTE`) inside `DO` blocks.
- **Policies** are compared by command, roles and permissive/restrictive only. `USING` and `WITH CHECK` expressions are shown but never compared.
- **Unnamed constraints and indexes** are matched by table, type and columns, so two unnamed ones on the same columns cannot be told apart.
- **`DO` blocks:** static statements inside them are expected to have run, although an `IF NOT EXISTS` guard makes them conditional. They are flagged (`inDoBlock`) and reported at the line of the `DO` statement.
- **Serial columns** are checked as `integer`/`bigint`/`smallint NOT NULL`; the sequence behind them is not checked.
- **Columns not written out** (`LIKE`, `INHERITS`, partitions, typed tables, `CREATE TABLE AS`) are not checked.
- **History table:** only `supabase_migrations.schema_migrations` (Supabase CLI). Other tools' history tables are on the [roadmap](ROADMAP.md).
- **Line numbers** point at the start of the statement: a missing column is reported at its `CREATE TABLE` line.
- **Postgres versions tested:** 15 and 17 in CI (the versions Supabase runs) and 18 locally.

## Development

```bash
git clone https://github.com/OWNER/pg-migration-verify.git
cd pg-migration-verify
npm ci
```

| Script                     | What it does                                                          |
| -------------------------- | --------------------------------------------------------------------- |
| `npm run build`            | Compiles `src/` to `dist/` (the published bin is `dist/index.js`).    |
| `npm run typecheck`        | `tsc --noEmit` over sources and tests (strict).                       |
| `npm run lint`             | ESLint with `typescript-eslint` strict type-checked rules.            |
| `npm run format`           | Prettier, write mode. `npm run format:check` only checks.             |
| `npm run test:unit`        | Unit tests (Vitest). No database needed.                              |
| `npm run test:integration` | Integration tests against a real Postgres, see below.                 |
| `npm test`                 | Both test projects.                                                   |
| `npm run test:smoke`       | After `build`: starts `dist/index.js` over stdio and talks MCP to it. |

**Which database the integration tests use:** if `TEST_DATABASE_URL` is set (a superuser URL, as in CI), that server; otherwise an [embedded-postgres](https://github.com/leinelissen/embedded-postgres) 18 server started in the OS temp directory (about 5 seconds for `initdb`). Each test file creates and drops its own database, so a shared server stays clean. CI runs them against Postgres 15 and 17 service containers.

**Windows:** if the repository sits in a deep directory, the embedded Postgres binaries exceed the 260-character path limit and the run stops with an explanation. Map the parent directory to a drive letter (`subst P: <parent of the repo>`, then run from `P:\pg-migration-verify`; mapping the repository itself confuses Vitest), enable long paths, or set `TEST_DATABASE_URL`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test layout and conventions, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Roadmap

Ideas that are deliberately out of the current scope, such as suggesting the SQL for missing objects (never executing it), checking grants, other history tables and a CI exit-code mode, are in [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
