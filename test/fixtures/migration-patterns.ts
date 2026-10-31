/**
 * Synthetic migrations, in version order, using patterns that drop, rebuild, rename or re-declare
 * objects. Applied in this order they all succeed, and each one should verify as MATCH against the
 * resulting database. Shared by test/unit/migration-patterns.test.ts (hand-written catalog) and
 * test/integration/migration-patterns.test.ts (real Postgres).
 */
export const PATTERN_MIGRATIONS: Readonly<Record<string, string>> = {
  // Postgres has no DROP VALUE: an enum value is removed by rebuilding the type. Tables are
  // rebuilt by DROP and CREATE.
  '20240101000000_tasks_and_settings.sql': `create type public.task_status as enum ('todo', 'doing', 'blocked', 'done');
create table public.tasks (id int primary key, status public.task_status not null);
create table public.settings (id int primary key, theme text, beta boolean);
create policy "read settings" on public.settings for select using (true);
`,
  '20240102000000_rebuild_enum_and_table.sql': `alter type public.task_status rename to task_status_old;
create type public.task_status as enum ('todo', 'doing', 'done');
alter table public.tasks alter column status type public.task_status using status::text::public.task_status;
drop type public.task_status_old;
drop table if exists public.settings;
create table public.settings (id int primary key, theme text not null);
`,

  // Unnamed constraints and indexes dropped by the names Postgres generated for them, in the same
  // file and in a later one (as \`supabase db diff\` writes such drops).
  '20240201000000_profiles.sql': `create table public.profiles (id uuid primary key, username text unique, email text, age int check (age > 0));
create index on public.profiles (email);
create table public.inl (id int primary key, code text unique);
alter table public.inl drop constraint inl_code_key;
`,
  '20240202000000_drop_generated_names.sql': `alter table public.profiles drop constraint profiles_username_key;
alter table public.profiles drop constraint profiles_age_check;
drop index public.profiles_email_idx;
`,

  // The zero-downtime way to add a key: build the index first, then attach it, which renames it.
  '20240301000000_widgets_using_index.sql': `create table public.widgets (id int not null, code text);
create unique index widgets_code_idx on public.widgets (code);
alter table public.widgets add constraint widgets_code_key unique using index widgets_code_idx;
`,
  '20240302000000_gadgets_index.sql': `create table public.gadgets (id int not null);
create unique index gadgets_id_idx on public.gadgets (id);
`,
  '20240303000000_gadgets_primary_key.sql': `alter table public.gadgets add constraint gadgets_pkey primary key using index gadgets_id_idx;
`,

  // A type and a trigger function renamed after use: Postgres follows them by OID.
  '20240401000000_diary_renames.sql': `create type public.mood as enum ('ok', 'meh');
create table public.diary (id int primary key, m mood);
alter type public.mood rename to feeling;
create function public.f_touch() returns trigger language plpgsql as $$ begin return new; end $$;
create trigger diary_touch before update on public.diary for each row execute function public.f_touch();
alter function public.f_touch() rename to f_touch2;
`,

  // An idempotent re-declaration that drifted from the original: Postgres skips it.
  '20240501000000_ine.sql': `create table ine (id int primary key, a int not null);
`,
  '20240502000000_ine_if_not_exists.sql': `create table if not exists ine (id int primary key, a bigint);
alter table ine add column if not exists a text;
`,
};
