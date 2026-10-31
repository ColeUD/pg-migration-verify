---
name: verify-migrations
description: Check that Postgres/Supabase migrations were really applied by comparing what each migration file should create, alter or drop against the live database catalog. Use after applying migrations by hand or through the Supabase SQL editor, before deploying, or when supabase_migrations.schema_migrations seems out of sync with the repository.
argument-hint: '[migration file or version]'
allowed-tools:
  - mcp__plugin_pg-migration-verify_pgmv__list_repo_migrations
  - mcp__plugin_pg-migration-verify_pgmv__list_recorded_migrations
  - mcp__plugin_pg-migration-verify_pgmv__diff_history
  - mcp__plugin_pg-migration-verify_pgmv__expected_objects
  - mcp__plugin_pg-migration-verify_pgmv__verify_migration
  - mcp__plugin_pg-migration-verify_pgmv__verify_all
  - mcp__pgmv__list_repo_migrations
  - mcp__pgmv__list_recorded_migrations
  - mcp__pgmv__diff_history
  - mcp__pgmv__expected_objects
  - mcp__pgmv__verify_migration
  - mcp__pgmv__verify_all
---

Verify migrations with the tools of the `pgmv` MCP server. Every one of them is read-only: they
parse migration files and read `pg_catalog` inside a read-only transaction.

Target: `$ARGUMENTS` (empty means every migration).

1. If the target names a migration (file name, path, version or name), call `verify_migration`
   with it. Otherwise call `verify_all`.
2. Call `diff_history` to compare the repository with the recorded history table.
3. Present the result:
   - Start with the summary line(s): `MATCH n/n` or `MISMATCH m/n` per migration, and the totals,
     including migrations "applied but NOT recorded" and "recorded in history but MISMATCH".
   - For each `MISMATCH`, list what is `MISSING`, `DIFFERENT` or `UNEXPECTED` (dropped or renamed
     by the migration but still present), grouped by migration file, with the statement line each
     object comes from.
   - Explain `SUPERSEDED` (a later migration drops or renames the object, so it is checked there
     instead), `UNVERIFIABLE` notes (statements such as grants, comments, data changes or dynamic
     SQL in `DO` blocks that cannot be turned into catalog checks) and `NOTHING TO VERIFY` in one
     sentence each, only if they occur.
   - Report history discrepancies from `diff_history` (only in repo, only in database, renamed).
4. If something is missing, you may point out which statements of which migration would need to
   be re-applied, quoted as text for the user to review and run themselves.

Never write to the database, never run SQL, and never offer to apply a fix automatically. If no
database URL is configured, say so and explain how to provide one: the plugin's `database_url`
option (`claude plugin configure pg-migration-verify@pg-migration-verify`) or the `DATABASE_URL`
environment variable; without the plugin, `PGMV_DATABASE_URL` or `DATABASE_URL`. Recommend a
dedicated read-only role (README section "Read-only role").
