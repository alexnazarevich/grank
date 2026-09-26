-- Grank (9) free quota + one paid plan.
-- profiles.plan, profiles.stripe_customer_id, and usage_events are created in
-- 20260925120000_save_and_rerun.sql. Everything here is safe to re-run.

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'free',
  stripe_customer_id text,
  created_at timestamptz default now(),
  constraint profiles_plan_check check (plan in ('free', 'paid'))
);

alter table public.profiles add column if not exists plan text not null default 'free';
alter table public.profiles add column if not exists stripe_customer_id text;

create table if not exists public.usage_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  anon_key text,
  kind text not null check (kind in ('check', 'save')),
  created_at timestamptz default now()
);

create index if not exists usage_events_user_created on public.usage_events (user_id, created_at desc);
create index if not exists usage_events_anon_created on public.usage_events (anon_key, created_at desc);
create index if not exists profiles_stripe_customer on public.profiles (stripe_customer_id);

alter table public.profiles enable row level security;
alter table public.usage_events enable row level security;

-- Users can read their profile, but cannot flip plan or the Stripe customer id.
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

drop trigger if exists profiles_protect_billing on public.profiles;
create trigger profiles_protect_billing
  before insert or update on public.profiles
  for each row execute function public.protect_profile_billing();

do $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_select_own'
  ) then
    create policy profiles_select_own on public.profiles
      for select using (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_insert_own'
  ) then
    create policy profiles_insert_own on public.profiles
      for insert with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles' and policyname = 'profiles_update_own'
  ) then
    create policy profiles_update_own on public.profiles
      for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
  end if;
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'usage_events' and policyname = 'usage_events_select_own'
  ) then
    create policy usage_events_select_own on public.usage_events
      for select using (auth.uid() = user_id);
  end if;
end $$;

grant select, insert, update, delete on public.profiles to authenticated;
grant select on public.usage_events to authenticated;
grant all on table public.profiles to service_role;
grant all on table public.usage_events to service_role;
