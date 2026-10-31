create table public.projects (id uuid primary key);

-- ✓ the next statement has a doubled comma
create table public.broken (
  id int,,
  name text
);

create table public.todos (id bigint, title text);

create function public.answer() returns int
  language sql
  begin atomic
    select 41;
    select 42;
  end;

create index todos_title_idx on public.todos (title)
