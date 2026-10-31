# Demo app migrations

Synthetic migrations of a small task-tracking SaaS (organizations, profiles, projects, tasks,
comments), used by `test/integration/demo-app.test.ts`. No real data.

- `add_billing_draft.sql` has no version prefix: the Supabase CLI skips it, and so does
  pg-migration-verify (with a warning).
- This README is not a `.sql` file and is ignored.
