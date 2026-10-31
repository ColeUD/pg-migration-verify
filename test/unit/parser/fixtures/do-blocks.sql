-- Re-runnable migration in the style Supabase projects often use.
do $$
begin
  if not exists (select 1 from pg_type where typname = 'task_priority') then
    create type public.task_priority as enum ('low', 'medium', 'high');
  end if;
end
$$;

do $$
begin
  alter table public.todos add column priority public.task_priority not null default 'medium';
exception
  when duplicate_column then null;
end
$$;

do $$
declare
  t text;
begin
  foreach t in array array['todos', 'projects'] loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end
$$;
