-- Grank (10) full report allotment.
-- Counts live in usage_events so a person cannot reset the free report by
-- deleting a saved check. Safe to re-run.

do $$
declare
  constraint_name text;
begin
  for constraint_name in
    select con.conname
    from pg_constraint con
    join pg_class rel on rel.oid = con.conrelid
    join pg_namespace nsp on nsp.oid = rel.relnamespace
    where nsp.nspname = 'public'
      and rel.relname = 'usage_events'
      and con.contype = 'c'
      and pg_get_constraintdef(con.oid) ilike '%kind%'
  loop
    execute format('alter table public.usage_events drop constraint %I', constraint_name);
  end loop;
end $$;

alter table public.usage_events
  add constraint usage_events_kind_check
  check (kind in ('check', 'save', 'full_report'));
