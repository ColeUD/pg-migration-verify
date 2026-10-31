-- Public profile pages, clearer naming, and cleanup of the activity log experiment.

-- Profiles become visible to anonymous visitors too.
drop policy "Profiles are visible to signed-in users" on public.profiles;
create policy "Profiles are visible to signed-in users"
  on public.profiles for select to anon, authenticated
  using (true);

alter table public.profiles rename column display_name to full_name;

-- Replaced by an index that only covers open tasks.
drop index public.tasks_assignee_idx;
create index tasks_open_by_assignee_idx on public.tasks (assignee_id)
  where completed_at is null;

drop table public.task_events;
