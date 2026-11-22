-- =====================================================================
-- Auth gate: only emails registered in app_users may create a login.
-- Enable in Supabase Dashboard → Authentication → Hooks →
--   "Before User Created" → Postgres function → public.hook_before_user_created
-- (Without the hook, unregistered people could create an auth user but RLS
--  still gives them nothing.)
-- =====================================================================
create or replace function public.hook_before_user_created(event jsonb) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_email text := lower(coalesce(event #>> '{user,email}', ''));
begin
  if exists (select 1 from app_users where lower(email) = v_email and active) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', 'This email is not registered for the portal'));
end $$;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    execute 'grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin';
    execute 'grant select on public.app_users to supabase_auth_admin';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke execute on function public.hook_before_user_created(jsonb) from authenticated, anon, public';
  end if;
end $$;
