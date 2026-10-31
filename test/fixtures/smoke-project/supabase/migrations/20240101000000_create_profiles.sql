-- Synthetic fixture for scripts/smoke.mjs.
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  username text NOT NULL UNIQUE
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
