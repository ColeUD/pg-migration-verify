# pg-migration-verify

**An MCP server that tells your coding agent whether a Postgres/Supabase migration was really applied, by checking every object it should create against `pg_catalog`. Read-only by construction.**

[![CI](https://github.com/ColeUD/pg-migration-verify/actions/workflows/ci.yml/badge.svg)](https://github.com/ColeUD/pg-migration-verify/actions/workflows/ci.yml)
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
/plugin marketplace add ColeUD/pg-migration-verify
/plugin install pg-migration-verify@pg-migration-verify
```

The plugin has one option, `database_url`: a connection string like the ones [below](#claude-code-plain-mcp-server). It is marked sensitive, so Claude Code keeps it in its credential store rather than in `settings.json`. Claude Code may ask for it during the install; to set it (or change it later), run in Claude Code:

```text
/plugin configure pg-migration-verify@pg-migration-verify
```

From a shell, `claude plugin configure` only lists the options unless it gets `--values-stdin`. To save the value from a script, put `{"database_url": "postgresql://..."}` in a file outside the repository and pipe it in, then delete the file:

```bash
claude plugin configure pg-migration-verify@pg-migration-verify --values-stdin < pgmv-config.json
```

Reading from a file keeps the password out of your shell history and the process list, which `echo '{...}' |` or `--config database_url=...` would not.

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
claude mcp add --env "PGMV_DATABASE_URL=postgresql://pgmv_readonly:<password>@<host>:5432/postgres?sslmode=verify-full" \
  --scope local --transport stdio pgmv -- npx -y pg-migration-verify@0.1.0
```

Keep `sslmode` in the URL: without it the connection is not encrypted (see [TLS](#supabase-connection-notes); for Supabase also add `sslrootcert` as in the Desktop example below). Keep another option between `--env` and the server name `pgmv`; otherwise `claude mcp add` reads `pgmv` as a second environment variable. Migrations are looked up in `supabase/migrations` under the server's working directory. If `list_repo_migrations` shows the wrong directory, add `--env PGMV_PROJECT_DIR=/path/to/your/app`.

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
        "PGMV_DATABASE_URL": "postgresql://pgmv_readonly:<password>@db.<project-ref>.supabase.co:5432/postgres?sslmode=verify-full&sslrootcert=/absolute/path/to/supabase-ca.crt",
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
| `list_repo_migrations`     | Which migration files exist? In apply order, with sha256, misnamed `.sql` files the CLI would skip, and duplicate versions.                           | No        |

Arguments: `dir` (optional, every tool except `list_recorded_migrations`) overrides the migrations directory, relative to the project directory; it must lie inside the project directory or the configured migrations directory. `file` (`verify_migration`, `expected_objects`) accepts the file name, a path ending in it, the version or the name; only exact matches count. `verbose` (`verify_migration`, `verify_all`) also lists matching objects and ignored statements.

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
  SUPERSEDED line 19  index public.tasks_assignee_idx: dropped by 20240320090000_rework_profiles_and_tasks.sql line 12
  history: recorded in supabase_migrations.schema_migrations

MISMATCH 12/14  20240310083000_create_comments.sql
  MISSING      line 26  policy "Authors write comments" on public.comments (for INSERT, to authenticated)
  DIFFERENT    line 3   column public.comments.body: nullability expected not null, found nullable
  SUPERSEDED   line 34  table public.task_events (and 5 columns, 1 index, 2 constraints): dropped by 20240320090000_rework_profiles_and_tasks.sql line 16
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
| `MATCH*`            | A MATCH that does not show the file ran: every check would also hold without it (only drops, a policy re-created, a function replaced, `IF NOT EXISTS`).            |
| `MISMATCH m/n`      | At least one checked object is MISSING, DIFFERENT or UNEXPECTED; `m` of `n` checks passed.                                                                          |
| `MISSING`           | Expected to exist, not found.                                                                                                                                       |
| `DIFFERENT`         | Found, but an attribute the migration asserts differs: column type or nullability, index columns or method, policy command or roles, and so on.                     |
| `UNEXPECTED`        | The migration drops or renames the object, but it still exists.                                                                                                     |
| `SUPERSEDED`        | A later migration drops or rebuilds the object or what it depends on, or `IF NOT EXISTS` skipped it, so it cannot be checked against this file. Not counted in `n`. |
| `UNVERIFIABLE`      | A statement that cannot be turned into a catalog check (GRANT, COMMENT, data changes, dynamic SQL). Review it by hand.                                              |
| `NOTHING TO VERIFY` | No statement in the file yields a catalog check, as with a seed file.                                                                                               |
| `HISTORY`           | Whether the version is in `supabase_migrations.schema_migrations`: `recorded`, `NOT RECORDED`, or `-` when the history table is missing or the role cannot read it. |

**"Applied but NOT recorded"** counts migrations whose objects all exist (MATCH) while the history table has no row for their version: typically SQL pasted into the Supabase SQL editor. Only positive evidence counts: at least one check must be one that would fail had the file never run. A file that only drops things, re-creates a policy with a new `USING` (expressions are not compared), replaces a function body (bodies are not compared) or adds back a column exactly as an earlier migration defined it matches before it runs, so it is listed apart as "NOT recorded, and their MATCH does not show they ran" and marked `MATCH*`. The opposite, **"recorded in history but MISMATCH"**, lists migrations the history table claims are applied whose objects are not all there: a partial apply, or a hand edit afterwards. Those are the two cases the history table alone gets wrong.

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
 timeline across files: a later DROP -> SUPERSEDED, a later RENAME or ALTER updates the expectation
                  |
                  v
 compare with a pg_catalog snapshot  <--  one REPEATABLE READ, READ ONLY transaction per tool call
                  |                       (catalog snapshot + recorded history)
                  v
 report: MATCH n/n or MISMATCH m/n with per-object lines, as text and structuredContent
```

- **A real parser, not regexes.** [libpg-query](https://github.com/constructive-io/libpg-query-node) is the actual Postgres parser, so dollar quoting, quoted identifiers, `CREATE SCHEMA ... CREATE TABLE` and `DO $$ ... $$` bodies (through the PL/pgSQL parser) are read exactly as the server reads them. Every statement yields expected objects, an `unverifiable` or `ignored` note, or both; nothing is silently dropped.
- **`pg_catalog`, not `information_schema`.** `information_schema` hides objects the connected role has no privileges on, so a least-privilege role would see existing tables as missing. `pg_catalog` is readable by `PUBLIC`, and every query joins by name rather than casting to `::regclass`, which would need schema privileges.
- **Types in `format_type()` spelling.** Migration types are normalized to what the catalog prints (`int4` becomes `integer`, `varchar(255)` becomes `character varying(255)`, `timestamptz` becomes `timestamp with time zone`). The catalog is read with `search_path = ''`, so user types come back schema-qualified, and a bare `job_status` in a migration matches `public.job_status`.
- **Net effect per file, then a timeline.** Within one file, `CREATE TABLE`, `ALTER TABLE ... ADD COLUMN` and `DROP INDEX` fold into one expectation per object. Across files, each migration is judged on what should still hold today: a table dropped two migrations later is SUPERSEDED, not MISSING, and a column whose type a later migration changes is checked against the new type. Postgres's own side effects are applied the same way in one file and across files: what depends on a dropped object goes with it (indexes and constraints with their column, foreign keys with the table they reference, triggers with their function, columns with their type), and renames are followed (a column renamed later is checked under its new name with the type the earlier migration gave it, and the indexes, constraints, foreign keys, policies and RLS that use it follow along). When a later change is not in the database yet, the earlier migration still matches the object as it left it, and the later migration reports the difference. Files apply in file-name order, as the Supabase CLI applies them. A later rebuild (`DROP TABLE` then `CREATE TABLE`, or the rename-create-drop that removes an enum value) supersedes what the rebuild leaves out. Unnamed constraints and indexes also carry the name Postgres generates for them (`profiles_username_key`), so a later `DROP CONSTRAINT` by that name is recognized. A `CREATE TABLE IF NOT EXISTS` or `ADD COLUMN IF NOT EXISTS` of something an earlier migration created was skipped by Postgres: it is checked for existence only and never changes the earlier expectation.
- **One consistent read.** The catalog snapshot and the history table are read in a single `REPEATABLE READ, READ ONLY` transaction, on a fresh connection that is closed afterwards, so every catalog query sees the same moment even while a migration runs. (Deparsed strings such as `format_type` read the current catalog, so DDL committing at that very instant can still show up in them.)

## Safety model

These are hard rules, enforced in code and covered by tests:

- **Read-only by construction.** Every query runs inside a read-only transaction (`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`) and is rolled back, never committed. SQL exists only as vetted constant `SELECT` queries in [src/catalog/queries.ts](src/catalog/queries.ts) (the query runner accepts nothing else), and user input only travels as bind parameters. The server never runs user-supplied SQL, migration files included: they are parsed, never executed. There is no write tool.
- **The connection string stays secret.** It comes only from `PGMV_DATABASE_URL` or `DATABASE_URL`, never from a tool argument. It is never logged, echoed in tool output, or included in error messages: database errors are mapped to safe categories, and every error text is scrubbed of the URL, password, host and port before it leaves the server. Socket and TLS errors are reduced to their code, because Node names the resolved IP address in them. A test throws nine error forms at every tool and checks that none leaks.
- **Tools read only the project.** The `dir` argument comes from the model, so it must stay inside the project directory or the configured migrations directory, also after following symbolic links; `PGMV_ALLOW_OUTSIDE_PROJECT=1` lifts that. `.sql` files over 10 MB are listed but never read.
- **Every call is bounded in time.** Connecting gives up after 10 seconds, each statement after the statement timeout plus 2 seconds (also when the server or network goes silent), and closing the connection after 2 more.
- **No real data or credentials.** Everything in this repository, its tests and its examples is synthetic; passwords are placeholders such as `test-only-password`.

The read-only transaction protects against mistakes in this tool; the role you connect as is what protects your database. Use the role below.

## Read-only role

The tool needs no table, sequence or function privileges, because `pg_catalog` is readable by `PUBLIC`. Run this as an admin role (on Supabase: in the SQL editor, as `postgres`):

```sql
CREATE ROLE pgmv_readonly WITH LOGIN PASSWORD '<generated password>'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 3;
-- INHERIT is the default; keep it.
ALTER ROLE pgmv_readonly SET default_transaction_read_only = on;
ALTER ROLE pgmv_readonly SET statement_timeout = '15s';
GRANT CONNECT ON DATABASE postgres TO pgmv_readonly;

-- Only for the history column and diff_history / list_recorded_migrations:
GRANT USAGE ON SCHEMA supabase_migrations TO pgmv_readonly;
GRANT SELECT ON supabase_migrations.schema_migrations TO pgmv_readonly;
```

- **Do not grant `pg_read_all_data`.** It gives `SELECT` on every row of user data, and this tool never reads user data.
- Without the two history grants every catalog check still works; the `HISTORY` column shows `-` and the history tools explain which grant is missing.
- `default_transaction_read_only` is defence in depth, not a boundary: any session can turn it off. The real protection is that the role owns nothing and has no write privileges.
- An [integration test](test/integration/readme-role.test.ts) runs the SQL above as written (with a test password and its own database name) and verifies migrations as the role it creates. The other integration tests connect as the same kind of role with no grants at all, and a 44-statement migration covering every supported object kind still verifies as `MATCH 169/169`.
- Role names starting with `pg_` are reserved by Postgres, so pick another name if you change it.

### Supabase connection notes

- **Direct connection:** `db.<project-ref>.supabase.co:5432`, IPv6 only unless your project has the IPv4 add-on.
- **Session pooler (Supavisor):** port `5432` on the pooler host, works over IPv4. The user name carries the project ref (`pgmv_readonly.<project-ref>`). Copy the exact host and user format from the dashboard's Connect panel.
- **Transaction pooler** (port `6543`) has not been tested; prefer the direct connection or the session pooler.
- **TLS:** without `sslmode` in the URL (or `PGSSLMODE` in the environment), the `pg` driver connects **without encryption**. Unlike libpq and `psql`, it does not default to `prefer`, and the connection strings the Supabase dashboard shows have no `sslmode`. Add `?sslmode=verify-full`, which checks the server certificate against the CAs Node trusts (`pg` treats `sslmode=require` the same way). Supabase signs its certificates with its own CA, so download it from the dashboard (Database settings, SSL configuration) and add `&sslrootcert=/absolute/path/to/supabase-ca.crt`, as in the examples above. `sslmode=no-verify` encrypts without verifying the server and is not recommended; leaving out `sslmode`, or `sslmode=disable`, is only for a local server. Also consider turning on "Enforce SSL on incoming connections" in the Supabase dashboard. The startup log line says which TLS mode applies, without naming the host.

## Configuration

All configuration is read from environment variables at startup. A value that is empty, or an unexpanded `${...}` placeholder left by a client, counts as unset.

| Variable                     | Default                        | Purpose                                                                                                                                                                                                             |
| ---------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PGMV_DATABASE_URL`          | none                           | `postgres://` or `postgresql://` URL, ideally of the read-only role. Takes precedence over `DATABASE_URL`.                                                                                                          |
| `DATABASE_URL`               | none                           | Used when `PGMV_DATABASE_URL` is unset, so the app's own variable works without a second copy.                                                                                                                      |
| `PGMV_PROJECT_DIR`           | the server's working directory | Directory that relative paths (the variable below and the `dir` tool argument) are resolved against.                                                                                                                |
| `PGMV_MIGRATIONS_DIR`        | `supabase/migrations`          | Migrations directory, relative to the project directory. May lie outside it.                                                                                                                                        |
| `PGMV_DEFAULT_SCHEMA`        | `public`                       | Schema for unqualified names in migrations.                                                                                                                                                                         |
| `PGMV_STATEMENT_TIMEOUT_MS`  | `15000`                        | Per-statement timeout inside each read-only transaction. Must be a whole number from 1 to 2147483647, or startup fails. The client also gives up on a statement 2 seconds after it, in case the connection dropped. |
| `PGMV_ALLOW_OUTSIDE_PROJECT` | unset                          | `1` lets the `dir` tool argument point outside the project directory and the migrations directory.                                                                                                                  |

Without a database URL the server still starts: `list_repo_migrations` and `expected_objects` work, and the other tools return an error explaining how to configure one. On startup the server logs one line to stderr naming the variable that supplied the URL (never its value), whether the connection uses TLS (`TLS: off (...)` for a remote server is a warning) and the directories it uses. `npx pg-migration-verify --help` lists the variables; `--version` prints the version.

## Known limitations

pg-migration-verify checks schema objects, and is honest about what it cannot see. These are reported as `UNVERIFIABLE` or simply not compared:

- **Not checked:** privileges (`GRANT`, `REVOKE`, default privileges), ownership, roles, comments, publications, function bodies and attributes (only the signature is checked), column defaults, sequence options, partial-index predicates and `INCLUDE` columns, `CHECK` constraint expressions (only the columns they reference are compared), foreign key `MATCH` type, deferrability and `ON DELETE SET NULL (columns)` lists (`ON DELETE`/`ON UPDATE` actions are compared), data changes (`INSERT`, `UPDATE`, `DELETE`, `COPY`, ...), and dynamic SQL (`EXECUTE`) inside `DO` blocks.
- **Policies** are compared by command, roles and permissive/restrictive only. `USING` and `WITH CHECK` expressions are shown but never compared.
- **Unnamed constraints and indexes** are matched by table, type and columns, so two unnamed ones on the same columns cannot be told apart. A later drop or rename by the generated name is recognized only when it is the name Postgres chooses first: a collision suffix (`profiles_username_key1`) is not predicted.
- **Dependencies the parser cannot see** are not followed: a view over a dropped table, a function whose argument type is dropped. Only renames and drops the migrations spell out are applied; a rename done by hand shows as MISSING.
- **Apply order** is file-name order, as the Supabase CLI applies migrations. With versions of different lengths (`9_a.sql`, `10_b.sql`) that is not numeric order, and the tools say so.
- **`IF NOT EXISTS`** re-declarations are known to be skipped only when an earlier migration in the repository created the object; objects created outside the migrations are not known.
- **`DO` blocks:** static statements inside them are expected to have run, although an `IF NOT EXISTS` guard makes them conditional. They are flagged (`inDoBlock`) and reported at the line of the `DO` statement.
- **Serial columns** are checked as `integer`/`bigint`/`smallint NOT NULL`; the sequence behind them is not checked.
- **Columns not written out** (`LIKE`, `INHERITS`, partitions, typed tables, `CREATE TABLE AS`) are not checked.
- **History table:** only `supabase_migrations.schema_migrations` (Supabase CLI). Other tools' history tables are on the [roadmap](ROADMAP.md).
- **Line numbers** point at the start of the statement: a missing column is reported at its `CREATE TABLE` line.
- **Postgres versions tested:** 15 and 17 in CI (the versions Supabase runs) and 18 locally.

## Development

```bash
git clone https://github.com/ColeUD/pg-migration-verify.git
cd pg-migration-verify
npm ci
```

| Script                     | What it does                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `npm run build`            | Cleans `dist/` and compiles `src/` into it (the published bin is `dist/index.js`). `npm pack` and `npm publish` run it first. |
| `npm run typecheck`        | `tsc --noEmit` over sources and tests (strict).                                                                               |
| `npm run lint`             | ESLint with `typescript-eslint` strict type-checked rules.                                                                    |
| `npm run format`           | Prettier, write mode. `npm run format:check` only checks.                                                                     |
| `npm run test:unit`        | Unit tests (Vitest). No database needed.                                                                                      |
| `npm run test:integration` | Integration tests against a real Postgres, see below.                                                                         |
| `npm test`                 | Both test projects.                                                                                                           |
| `npm run test:smoke`       | After `build`: starts `dist/index.js` over stdio and talks MCP to it.                                                         |
| `npm run test:pack`        | After `build`: checks the `npm pack` file list (the bin and `npm-shrinkwrap.json`, no sources, tests or maps).                |

**Which database the integration tests use:** if `TEST_DATABASE_URL` is set (a superuser URL, as in CI), that server; otherwise an [embedded-postgres](https://github.com/leinelissen/embedded-postgres) 18 server started in the OS temp directory (about 5 seconds for `initdb`). Each test file creates and drops its own database, so a shared server stays clean. CI runs them against Postgres 15 and 17 service containers.

**Windows:** if the repository sits in a deep directory, the embedded Postgres binaries exceed the 260-character path limit and the run stops with an explanation. Map the parent directory to a drive letter (`subst P: <parent of the repo>`, then run from `P:\pg-migration-verify`; mapping the repository itself confuses Vitest), enable long paths, or set `TEST_DATABASE_URL`.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the test layout and conventions, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Roadmap

Ideas that are deliberately out of the current scope, such as suggesting the SQL for missing objects (never executing it), checking grants, other history tables and a CI exit-code mode, are in [ROADMAP.md](ROADMAP.md).

## License

[MIT](LICENSE)
