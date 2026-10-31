-- Comments on tasks, and a first attempt at an activity log (replaced later).

create table public.comments (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  author_id uuid not null references public.profiles (id),
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

create index comments_task_id_created_at_idx on public.comments (task_id, created_at);

alter table public.comments enable row level security;

create policy "Members read comments"
  on public.comments for select to authenticated
  using (
    exists (
      select 1
      from public.tasks t
      join public.projects p on p.id = t.project_id
      where t.id = task_id and public.is_member_of(p.organization_id)
    )
  );

create policy "Authors write comments"
  on public.comments for insert to authenticated
  with check (author_id = (select auth.uid()));

grant select, insert on public.comments to authenticated;

comment on table public.comments is 'Discussion on a task, newest last.';

create table public.task_events (
  id bigint generated always as identity primary key,
  task_id bigint not null references public.tasks (id) on delete cascade,
  kind text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

create index task_events_task_id_idx on public.task_events (task_id);
