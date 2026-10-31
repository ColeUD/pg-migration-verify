-- Ünïcödé header: café, naïve, 日本語, emoji 🚀🚀
create table public.notes (body text);

/* Ω block comment ✓ before a statement */ create table public.tags (label text);
-- 🚀 one more: ¿qué tal? ✓
create index notes_body_idx
  on public.notes (body);
