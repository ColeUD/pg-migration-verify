-- Tasks inside a project.

create type public.task_status as enum ('todo', 'in_progress', 'done');

create table public.tasks (
  id bigint generated always as identity primary key,
  project_id uuid not null references public.projects (id) on delete cascade,
  title text not null,
  status public.task_status not null default 'todo',
  priority smallint not null default 2 check (priority between 1 and 4),
  assignee_id uuid references public.profiles (id) on delete set null,
  estimate integer,
  due_on date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index tasks_project_status_idx on public.tasks (project_id, status);
create index tasks_assignee_idx on public.tasks (assignee_id) where assignee_id is not null;

create trigger tasks_set_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

alter table public.tasks enable row level security;

create policy "Members manage tasks"
  on public.tasks for all to authenticated
  using (
    exists (
      select 1 from public.projects p
      where p.id = project_id and public.is_member_of(p.organization_id)
    )
  );
