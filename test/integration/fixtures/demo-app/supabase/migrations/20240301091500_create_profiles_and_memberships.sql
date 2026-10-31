-- Profiles (one per signed-in user) and their membership in organizations.

create table public.profiles (
  id uuid primary key,
  display_name text not null,
  avatar_url text,
  created_at timestamptz not null default now()
);

create table public.memberships (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  profile_id uuid not null references public.profiles (id) on delete cascade,
  role public.member_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (organization_id, profile_id)
);

create index memberships_profile_id_idx on public.memberships (profile_id);

alter table public.profiles enable row level security;
alter table public.memberships enable row level security;

create policy "Profiles are visible to signed-in users"
  on public.profiles for select to authenticated
  using (true);

create policy "Users update their own profile"
  on public.profiles for update to authenticated
  using ((select auth.uid()) = id)
  with check ((select auth.uid()) = id);

create policy "Members see their memberships"
  on public.memberships for select to authenticated
  using (profile_id = (select auth.uid()));

-- Used by the policies of every tenant table. Security definer, so the policies on memberships
-- do not apply recursively.
create or replace function public.is_member_of(org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.organization_id = org_id
      and m.profile_id = (select auth.uid())
  );
$$;
