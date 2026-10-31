-- Reference data: the plans an organization can be on.

insert into public.plans (id, name, max_projects) values
  ('free', 'Free', 3),
  ('team', 'Team', 50)
on conflict (id) do nothing;

insert into public.plans (id, name, max_projects) values ('enterprise', 'Enterprise', 1000)
on conflict (id) do update set max_projects = excluded.max_projects;
