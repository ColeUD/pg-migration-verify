-- Organizations are the tenant boundary of the app: every project belongs to one.
-- Synthetic fixture for the pg-migration-verify test suite.

-- Re-runnable enum, the way the Supabase dashboard and many generators write it.
do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'member_role'
  ) then
    create type public.member_role as enum ('owner', 'admin', 'member');
  end if;
end
$$;

create table public.plans (
  id text primary key,
  name text not null,
  max_projects integer not null check (max_projects > 0)
);

create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  plan_id text not null default 'free' references public.plans (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint organizations_slug_format check (slug ~ '^[a-z0-9-]{3,48}$')
);

-- Shared by every table with an updated_at column.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger organizations_set_updated_at
  before update on public.organizations
  for each row execute function public.set_updated_at();
