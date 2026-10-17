-- Grank (18) Citations. One source shape for every engine.
-- Apply in the Supabase SQL editor before a Citations smoke.
-- Service role writes from Pages Functions. RLS matches the other per-user tables.

create table if not exists public.citation_sources (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.checks(id) on delete cascade,
  question text not null,
  engine text not null check (engine in ('chatgpt', 'gemini')),
  url text not null,
  domain text not null,
  title text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists citation_sources_run on public.citation_sources (run_id, engine);

create table if not exists public.citation_suggestions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  run_id uuid not null references public.checks(id) on delete cascade,
  question text not null,
  engine text not null check (engine in ('chatgpt', 'gemini')),
  rendered_content text not null,
  created_at timestamptz not null default now()
);

create index if not exists citation_suggestions_run on public.citation_suggestions (run_id, engine);

alter table public.citation_sources enable row level security;
alter table public.citation_suggestions enable row level security;

drop policy if exists citation_sources_select_own on public.citation_sources;
create policy citation_sources_select_own on public.citation_sources
  for select using (auth.uid() = user_id);

drop policy if exists citation_suggestions_select_own on public.citation_suggestions;
create policy citation_suggestions_select_own on public.citation_suggestions
  for select using (auth.uid() = user_id);

grant select on public.citation_sources to authenticated;
grant select on public.citation_suggestions to authenticated;
grant all on table public.citation_sources to service_role;
grant all on table public.citation_suggestions to service_role;
