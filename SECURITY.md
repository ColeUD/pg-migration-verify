# Security

pg-migration-verify connects to production databases, so its safety rules are part of its design rather than configuration. The full description is in the [README](README.md#safety-model).

## Safety model

- **Read-only by construction.** Every query runs inside `BEGIN READ ONLY` and is rolled back. SQL exists only as vetted constant `SELECT` queries; user input only travels as bind parameters. The server never runs user-supplied SQL (migration files are parsed, never executed), and there is no write tool.
- **The connection string stays secret.** It is read only from `PGMV_DATABASE_URL` or `DATABASE_URL`, and is never logged, echoed in tool output, or included in error messages.
- **Least privilege.** The recommended [read-only role](README.md#read-only-role) needs no table privileges at all, only `CONNECT` and, optionally, read access to the migration history table. Do not grant it `pg_read_all_data`.
- **No real data.** Fixtures, tests and examples in this repository are synthetic.

Any of the following is a vulnerability and worth reporting:

- the server writing to a database, or running SQL that is not one of its constant queries;
- the connection string, its password, host or port appearing in tool output, logs or error messages;
- a tool reading anything other than `pg_catalog` and the migration history table.

## Reporting a vulnerability

Please do not open a public issue. Report it privately through GitHub: on the repository page, open **Security**, then **Report a vulnerability** (a private security advisory), at https://github.com/OWNER/pg-migration-verify/security/advisories/new.

Include the version (`npx pg-migration-verify --version`), the MCP client, and steps to reproduce. Do not include real connection strings or credentials; a synthetic example is enough.

## Supported versions

Only the latest published version receives fixes.
