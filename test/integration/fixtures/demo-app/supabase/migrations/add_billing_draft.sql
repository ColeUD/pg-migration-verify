-- Work in progress, not a migration yet: no version prefix, so the Supabase CLI never applies it.

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id),
  amount_cents integer not null
);
