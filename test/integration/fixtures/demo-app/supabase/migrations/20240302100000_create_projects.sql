-- Projects group the tasks of an organization.

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  name varchar(80) not null,
  description text,
  archived_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_organization_name_key unique (organization_id, name)
);

-- Most screens only list active projects.
create index projects_active_idx on public.projects (organization_id) where archived_at is null;
create index projects_metadata_idx on public.projects using gin (metadata);

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();

alter table public.projects enable row level security;

create policy "Members read projects"
  on public.projects for select to authenticated
  using (public.is_member_of(organization_id));

create policy "Members write projects"
  on public.projects for all to authenticated
  using (public.is_member_of(organization_id))
  with check (public.is_member_of(organization_id));
