# Contributing

Thanks for helping. Bug reports with a synthetic migration that reproduces the problem are the most useful contribution of all.

## Setup

Node.js 22 or later.

```bash
npm ci
npm run build
```

## Checks

Run these before opening a pull request; CI runs the same ones.

```bash
npm run typecheck
npm run lint
npm run format:check   # npm run format fixes it
npm run test:unit
npm run test:integration
npm run build && npm run test:smoke
```

Integration tests use `TEST_DATABASE_URL` when it is set, otherwise an embedded Postgres 18 (see [Development](README.md#development) for the Windows path-length workaround). CI also runs them against Postgres 15 and 17, and validates the plugin with `npx -y @anthropic-ai/claude-code@2.1.316 plugin validate . --strict`.

## Layout

| Path                          | Contents                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| `src/model.ts`                | The shared data model; start here.                                                        |
| `src/parser/`                 | Migration SQL to expected objects, via libpg-query.                                       |
| `src/catalog/`                | The read-only connection, the constant catalog queries, error sanitizing.                 |
| `src/verify/`                 | Timeline across migrations, comparison with the catalog, report formatting.               |
| `src/migrations/`             | Listing migration files and diffing them with the history table.                          |
| `src/tools/`, `src/server.ts` | The six MCP tools, their zod schemas, and the server.                                     |
| `test/unit/`                  | Fast tests, no database. Parser fixtures are in `test/unit/parser/fixtures/`.             |
| `test/integration/`           | Real Postgres: parser/catalog agreement, catalog reads as a no-grants role, the demo app. |
| `scripts/smoke.mjs`           | Starts the built bin over stdio and calls it as an MCP client.                            |

`docs/example-output.txt` is written by `test/integration/demo-app.test.ts`. If you change the report format on purpose, refresh it with `npx vitest run --project integration -u` and review the diff.

## Rules

- **Read-only stays read-only.** New SQL goes into `src/catalog/queries.ts` as a constant `SELECT` defined with `defineCatalogQuery`; user input only as bind parameters. No tool may write.
- **The connection string never appears in output.** Not in tool results, logs or errors. Any new error path needs a test that it does not leak.
- **Never `console.log` in `src/`.** stdout carries the MCP protocol; diagnostics go to stderr.
- **Fixtures are synthetic.** No real schemas, data, connection strings or credentials anywhere in the repository. Use made-up names and passwords such as `test-only-password`.

## Code style

Strict TypeScript, ESM with `.js` import extensions, explicit return types on exported functions, and doc comments that explain why rather than what. ESLint and Prettier settle the rest.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/), as in the existing history: `feat(parser): ...`, `feat(verify): ...`, `test: ...`, `ci: ...`, `chore: ...`, `docs: ...`. The subject says what changed; the body says why.
