-- Completion tracking, labels, fractional estimates and a search helper.

alter table public.tasks add column if not exists completed_at timestamptz;
alter table public.tasks add column if not exists labels text[] not null default '{}';

-- Estimates in hours, with quarter hours.
alter table public.tasks alter column estimate type numeric(6, 2);

-- Every project gets a description from now on.
update public.projects set description = '' where description is null;
alter table public.projects alter column description set not null;

create index tasks_labels_idx on public.tasks using gin (labels);

create or replace function public.search_tasks(query text)
returns setof public.tasks
language sql
stable
set search_path = ''
as $$
  select *
  from public.tasks t
  where t.title ilike '%' || query || '%'
  order by t.created_at desc
  limit 50;
$$;
