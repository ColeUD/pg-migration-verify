# Roadmap

Ideas that are deliberately out of the current scope. None of them changes the [safety model](README.md#safety-model): the server stays read-only, and nothing here adds a tool that writes.

## Better answers

- **Suggested fix SQL.** For MISSING objects, return the statements of the migration that would create them, as text for a person to review and run. Never executed by the server.
- **Exact lines for nested objects.** Report a missing column at its own line rather than at its `CREATE TABLE`, and statements inside a `DO` block at their own line.

## More checks

- **Privileges.** Verify `GRANT` and `REVOKE` with `has_table_privilege`, `has_function_privilege` and the other `has_*_privilege` functions.
- **Comments.** Compare `COMMENT ON` text with `obj_description` and `col_description`.
- **Publications.** Check `CREATE/ALTER PUBLICATION` membership against `pg_publication_tables` (Supabase Realtime relies on it).
- **Column defaults.** Compare defaults by normalizing both sides: the parsed expression and `pg_get_expr(adbin, adrelid)`.
- **Policy expressions.** Compare `USING` and `WITH CHECK` through a normalized deparse of both sides, instead of command, roles and mode only.
- **CHECK expressions.** Compare a normalized deparse of the parsed expression with `pg_get_constraintdef`, the same approach as policy expressions, instead of the referenced columns only.
- **Partial-index predicates and `INCLUDE` columns.** The same normalized-expression comparison applied to indexes.
- **Sequences of serial columns.** Check that the implicit sequence exists and is owned by the column.

## More ecosystems

- **Other history tables.** Prisma (`_prisma_migrations`), Flyway (`flyway_schema_history`), Sqitch (`sqitch.changes`) and Drizzle (`drizzle.__drizzle_migrations`), each with its own file layout.

## More ways to run it

- **CLI with `--exit-code`.** Run `verify_all` from a CI pipeline and exit non-zero on any MISMATCH, for a deploy gate.
- **SARIF and JSON output.** Machine-readable reports for code-scanning UIs and other tools. The `structuredContent` schema is the starting point.
- **Desktop Extension (`.mcpb`).** One-click install in Claude Desktop with the database URL as a sensitive setting, replacing the hand-edited config file.
