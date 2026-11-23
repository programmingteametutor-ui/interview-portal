-- =====================================================================
-- Table privileges for logged-in users.
--
-- Older Supabase projects granted ALL on new public tables to `authenticated`
-- automatically; newer projects don't, which shows up in the app as
-- "permission denied for table handlers". Every table here has Row Level
-- Security, so these grants only let requests reach the RLS policies, which
-- still decide what each role may see or change.
--
-- `anon` (not logged in) still gets nothing. Safe to re-run.
-- =====================================================================
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'grant usage on schema public to authenticated';
    -- tables + the security_invoker views (monthly_incentive_summary, handler_call_stats, daily_call_stats)
    execute 'grant select, insert, update, delete on all tables in schema public to authenticated';
    execute 'grant usage, select on all sequences in schema public to authenticated';
    -- coverage_assignments is NOT security_invoker (it would bypass RLS): Edge Function / service role only
    execute 'revoke all on public.coverage_assignments from authenticated';
  end if;
  -- service_role (Edge Functions, e.g. coverage-desk-export) bypasses RLS but still needs grants
  if exists (select 1 from pg_roles where rolname = 'service_role') then
    execute 'grant usage on schema public to service_role';
    execute 'grant all on all tables in schema public to service_role';
    execute 'grant all on all sequences in schema public to service_role';
  end if;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on all tables in schema public from anon';
  end if;
end $$;
