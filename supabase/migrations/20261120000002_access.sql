-- =====================================================================
-- Access control: identity helpers + Row Level Security
-- Mirrors PortalAccessControl.gs:
--   SUPER_ADMIN  -> everything, all teams, administration
--   ADMIN        -> own team: approvals, intake, incentives, reports
--   HANDLER      -> own calls / own incentives; submits requests
--   SETUP_SUPPORT, TECH_SUPPORT -> read team schedule + reports
-- =====================================================================

-- Current portal user (null when the login email is not registered/active)
create or replace function app_user_id() returns uuid
language sql stable security definer set search_path = public as $$
  select id from app_users where auth_user_id = auth.uid() and active limit 1
$$;

create or replace function has_role(r app_role, t text default null) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from user_roles ur
    join app_users u on u.id = ur.user_id
    where u.auth_user_id = auth.uid() and u.active and ur.active
      and ur.role = r
      and (t is null or ur.team_id is null or ur.team_id = t)
  )
$$;

create or replace function is_super_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select has_role('SUPER_ADMIN')
$$;

create or replace function can_admin_team(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_super_admin() or exists (
    select 1 from user_roles ur join app_users u on u.id = ur.user_id
    where u.auth_user_id = auth.uid() and u.active and ur.active
      and ur.role = 'ADMIN' and ur.team_id = t)
$$;

create or replace function in_team(t text) returns boolean
language sql stable security definer set search_path = public as $$
  select is_super_admin() or exists (
    select 1 from user_roles ur join app_users u on u.id = ur.user_id
    where u.auth_user_id = auth.uid() and u.active and ur.active
      and (ur.team_id = t or (ur.team_id is null and u.primary_team_id = t)))
$$;

create or replace function my_handler_ids() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(distinct ur.handler_id), '{}')
  from user_roles ur join app_users u on u.id = ur.user_id
  where u.auth_user_id = auth.uid() and u.active and ur.active
    and ur.role = 'HANDLER' and ur.handler_id is not null
$$;

create or replace function is_app_user() returns boolean
language sql stable security definer set search_path = public as $$
  select app_user_id() is not null
$$;

-- ---------------------------------------------------------------------
-- Link a Supabase auth user to the pre-registered portal user by email.
-- Called by the app right after OTP login (and by the auth trigger).
-- ---------------------------------------------------------------------
create or replace function link_auth_user(p_auth_id uuid, p_email text) returns void
language sql security definer set search_path = public as $$
  update app_users set auth_user_id = p_auth_id
  where lower(email) = lower(p_email) and (auth_user_id is null or auth_user_id = p_auth_id);
$$;

-- Only the trigger / claim_my_account may call this (it trusts its arguments).
revoke execute on function link_auth_user(uuid, text) from public;

create or replace function on_auth_user_created() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform link_auth_user(new.id, new.email);
  return new;
end $$;

do $$ begin
  if exists (select 1 from information_schema.tables where table_schema='auth' and table_name='users') then
    execute 'drop trigger if exists portal_link_user on auth.users';
    execute 'create trigger portal_link_user after insert on auth.users
             for each row execute function public.on_auth_user_created()';
  end if;
end $$;

-- Session context for the UI (replaces getPortalAccessContext)
create or replace function my_context() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  u app_users;
  v_email text := coalesce(auth.jwt() ->> 'email', '');
begin
  select * into u from app_users where auth_user_id = auth.uid() and active;
  if not found then
    -- first login: try to link by email
    perform 1 from app_users where lower(email) = lower(v_email) and active and auth_user_id is null;
    if found then
      return jsonb_build_object('linked', false, 'needs_link', true);
    end if;
    return jsonb_build_object('linked', false, 'needs_link', false);
  end if;

  return jsonb_build_object(
    'linked', true,
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'name', u.official_name,
                               'primary_team_id', u.primary_team_id),
    'roles', coalesce((
      select jsonb_agg(jsonb_build_object(
               'role', ur.role, 'team_id', ur.team_id, 'handler_id', ur.handler_id,
               'handler_name', h.name, 'team_name', t.name) order by ur.role)
      from user_roles ur
      left join handlers h on h.id = ur.handler_id
      left join teams t on t.id = ur.team_id
      where ur.user_id = u.id and ur.active), '[]'::jsonb),
    'teams', coalesce((
      select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name)
      from teams t where t.active and in_team(t.id)), '[]'::jsonb)
  );
end $$;

create or replace function claim_my_account() returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  perform link_auth_user(auth.uid(), auth.jwt() ->> 'email');
  return my_context();
end $$;

-- Audit helper
create or replace function write_audit(p_action text, p_team text, p_target_type text, p_target_id text,
                                       p_old text, p_new text, p_details jsonb default null)
returns void language sql security definer set search_path = public as $$
  insert into audit_log(actor_id, actor_email, team_id, action, target_type, target_id, old_value, new_value, details)
  select app_user_id(), (select email from app_users where id = app_user_id()),
         p_team, p_action, p_target_type, p_target_id, p_old, p_new, p_details
$$;
revoke execute on function write_audit(text,text,text,text,text,text,jsonb) from public;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------
alter table teams                 enable row level security;
alter table handlers              enable row level security;
alter table app_users             enable row level security;
alter table user_roles            enable row level security;
alter table candidates            enable row level security;
alter table candidate_aliases     enable row level security;
alter table clients               enable row level security;
alter table client_aliases        enable row level security;
alter table handler_preferences   enable row level security;
alter table work_days             enable row level security;
alter table interviews            enable row level security;
alter table handler_leaves        enable row level security;
alter table outcome_requests      enable row level security;
alter table reassignment_requests enable row level security;
alter table selection_requests    enable row level security;
alter table incentive_rules       enable row level security;
alter table incentives            enable row level security;
alter table audit_log             enable row level security;

-- teams
create policy teams_read  on teams for select using (is_app_user());
create policy teams_write on teams for all using (is_super_admin()) with check (is_super_admin());

-- handlers
create policy handlers_read  on handlers for select using (in_team(team_id));
create policy handlers_write on handlers for all using (can_admin_team(team_id)) with check (can_admin_team(team_id));

-- users / roles (administration is SUPER_ADMIN only, like manageAdministration)
create policy app_users_read on app_users for select
  using (auth_user_id = auth.uid() or is_super_admin()
         or (primary_team_id is not null and can_admin_team(primary_team_id)));
create policy app_users_write on app_users for all using (is_super_admin()) with check (is_super_admin());

create policy user_roles_read on user_roles for select
  using (user_id = app_user_id() or is_super_admin());
create policy user_roles_write on user_roles for all using (is_super_admin()) with check (is_super_admin());

-- identity masters: readable by every portal user; handlers may add mappings
create policy candidates_read   on candidates for select using (is_app_user());
create policy candidates_insert on candidates for insert with check (is_app_user());
create policy candidates_admin  on candidates for update using (is_super_admin() or has_role('ADMIN'));
create policy candidates_delete on candidates for delete using (is_super_admin());

create policy cand_alias_read   on candidate_aliases for select using (is_app_user());
create policy cand_alias_insert on candidate_aliases for insert with check (is_app_user());
create policy cand_alias_admin  on candidate_aliases for update using (is_super_admin() or has_role('ADMIN'));
create policy cand_alias_delete on candidate_aliases for delete using (is_super_admin() or has_role('ADMIN'));

create policy clients_read   on clients for select using (is_app_user());
create policy clients_insert on clients for insert with check (is_app_user());
create policy clients_admin  on clients for update using (is_super_admin() or has_role('ADMIN'));
create policy clients_delete on clients for delete using (is_super_admin());

create policy client_alias_read   on client_aliases for select using (is_app_user());
create policy client_alias_insert on client_aliases for insert with check (is_app_user());
create policy client_alias_admin  on client_aliases for update using (is_super_admin() or has_role('ADMIN'));
create policy client_alias_delete on client_aliases for delete using (is_super_admin() or has_role('ADMIN'));

-- preferences
create policy prefs_read  on handler_preferences for select using (in_team(team_id));
create policy prefs_write on handler_preferences for all using (can_admin_team(team_id)) with check (can_admin_team(team_id));

-- work days
create policy work_days_read  on work_days for select using (in_team(team_id));
create policy work_days_write on work_days for all using (can_admin_team(team_id)) with check (can_admin_team(team_id));

-- interviews: whole team can read the schedule; only admins write directly.
-- Handlers change state through the request RPCs below.
create policy interviews_read  on interviews for select using (in_team(team_id));
create policy interviews_write on interviews for all using (can_admin_team(team_id)) with check (can_admin_team(team_id));

-- leaves
create policy leaves_read on handler_leaves for select
  using (exists (select 1 from handlers h where h.id = handler_id and in_team(h.team_id)));
create policy leaves_write on handler_leaves for all
  using (exists (select 1 from handlers h where h.id = handler_id and can_admin_team(h.team_id)))
  with check (exists (select 1 from handlers h where h.id = handler_id and can_admin_team(h.team_id)));

-- requests: visible to team admins, the requester and the call owner. Writes via RPC only.
create policy outcome_req_read on outcome_requests for select
  using (can_admin_team(team_id) or submitted_by = app_user_id() or handler_id = any(my_handler_ids()));
create policy reassign_req_read on reassignment_requests for select
  using (can_admin_team(team_id) or requested_by = app_user_id()
         or from_handler_id = any(my_handler_ids()) or to_handler_id = any(my_handler_ids()));
create policy selection_req_read on selection_requests for select
  using (can_admin_team(team_id) or requested_by = app_user_id()
         or exists (select 1 from interviews i where i.id = interview_id and i.handler_id = any(my_handler_ids())));

-- incentive rules
create policy rules_read  on incentive_rules for select using (is_app_user());
create policy rules_write on incentive_rules for all using (is_super_admin()) with check (is_super_admin());

-- incentives: admins see the team, handlers see only their own (viewOwn)
create policy incentives_read on incentives for select
  using (can_admin_team(team_id) or handler_id = any(my_handler_ids()));

-- audit
create policy audit_read on audit_log for select
  using (is_super_admin() or (team_id is not null and can_admin_team(team_id)));
