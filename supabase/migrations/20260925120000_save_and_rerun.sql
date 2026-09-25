-- Grank (8) save & re-run. Apply in the Supabase SQL editor or via the CLI.
-- Auth users come from Supabase Auth (magic link). Service role writes from
-- Pages Functions. RLS keeps each person on their own rows.

create table public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free' check (plan in ('free', 'paid')),
  stripe_customer_id text,
  created_at timestamptz default now()
);

create table public.checks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  mode text not null default 'unbranded' check (mode in ('unbranded', 'branded')),
  result jsonb not null default '{}',
  created_at timestamptz default now()
);

create index checks_user_created on public.checks (user_id, created_at desc);

create table public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  anon_key text,
  kind text not null check (kind in ('check', 'save')),
  created_at timestamptz default now()
);

create index usage_events_user_created on public.usage_events (user_id, created_at desc);

alter table public.profiles enable row level security;
alter table public.checks enable row level security;
alter table public.usage_events enable row level security;

-- Users can read and write their own profile, but cannot flip plan or Stripe ids.
create or replace function public.protect_profile_billing()
returns trigger
language plpgsql
as $$
begin
  if coalesce(auth.role(), '') is distinct from 'service_role' then
    if tg_op = 'INSERT' then
      new.plan := 'free';
      new.stripe_customer_id := null;
    else
      new.plan := old.plan;
      new.stripe_customer_id := old.stripe_customer_id;
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_protect_billing
  before insert or update on public.profiles
  for each row execute function public.protect_profile_billing();

create policy profiles_select_own on public.profiles
  for select using (auth.uid() = user_id);

create policy profiles_insert_own on public.profiles
  for insert with check (auth.uid() = user_id);

create policy profiles_update_own on public.profiles
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy checks_select_own on public.checks
  for select using (auth.uid() = user_id);

create policy checks_insert_own on public.checks
  for insert with check (auth.uid() = user_id);

create policy checks_update_own on public.checks
  for update using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy checks_delete_own on public.checks
  for delete using (auth.uid() = user_id);

-- Quota rows are written by the service role. Users may read their own.
create policy usage_events_select_own on public.usage_events
  for select using (auth.uid() = user_id);

grant select, insert, update, delete on public.profiles to authenticated;
grant select, insert, update, delete on public.checks to authenticated;
grant select on public.usage_events to authenticated;

grant all on table public.profiles to service_role;
grant all on table public.checks to service_role;
grant all on table public.usage_events to service_role;
