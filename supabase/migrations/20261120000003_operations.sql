-- =====================================================================
-- Operations RPCs (replace PortalCallOperations / PortalActions /
-- PortalTeamDayControl / Engine.scanIncentives)
-- All are SECURITY DEFINER and check permissions explicitly.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Identity resolution (alias first, then canonical name)
-- ---------------------------------------------------------------------
create or replace function resolve_candidate_id(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select candidate_id from candidate_aliases where active and alias_key = norm_key(p_name) limit 1),
    (select id from candidates where name_key = norm_key(p_name) order by id limit 1))
$$;

create or replace function resolve_client_id(p_name text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select client_id from client_aliases where active and alias_key = norm_key(p_name) limit 1),
    (select id from clients where name_key = norm_key(p_name) order by id limit 1),
    -- "Client - Job Role": fall back to the part before the first " - "
    case when p_name like '% - %' then
      coalesce((select client_id from client_aliases where active and alias_key = norm_key(split_part(p_name,' - ',1)) limit 1),
               (select id from clients where name_key = norm_key(split_part(p_name,' - ',1)) order by id limit 1))
    end)
$$;

-- Re-link unresolved interviews after aliases/masters change
create or replace function relink_identities(p_team text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare c1 int; c2 int;
begin
  if not (can_admin_team(p_team) or in_team(p_team)) then raise exception 'ACCESS_DENIED'; end if;
  update interviews set candidate_id = resolve_candidate_id(candidate_name)
   where team_id = p_team and candidate_id is null and candidate_name is not null
     and resolve_candidate_id(candidate_name) is not null;
  get diagnostics c1 = row_count;
  update interviews set client_id = resolve_client_id(client_name)
   where team_id = p_team and client_id is null and client_name is not null
     and resolve_client_id(client_name) is not null;
  get diagnostics c2 = row_count;
  return jsonb_build_object('candidates_linked', c1, 'clients_linked', c2);
end $$;

-- Map one name to a master record (creates the master when p_id is null)
create or replace function map_identity(p_kind text, p_alias text, p_target_id text, p_new_canonical text default null)
returns text language plpgsql security definer set search_path = public as $$
declare v_id text; v_email text := (select email from app_users where id = app_user_id());
begin
  if not is_app_user() then raise exception 'ACCESS_DENIED'; end if;
  if p_kind = 'candidate' then
    v_id := p_target_id;
    if v_id is null then
      insert into candidates(canonical_name) values (coalesce(nullif(trim(p_new_canonical),''), trim(p_alias))) returning id into v_id;
    end if;
    if norm_key(p_alias) is distinct from (select name_key from candidates where id = v_id) then
      insert into candidate_aliases(alias, candidate_id, added_by) values (trim(p_alias), v_id, v_email)
      on conflict (alias_key) where active do update set candidate_id = excluded.candidate_id, added_by = excluded.added_by, added_at = now();
    end if;
    update interviews set candidate_id = v_id where candidate_id is null and norm_key(candidate_name) = norm_key(p_alias);
  elsif p_kind = 'client' then
    v_id := p_target_id;
    if v_id is null then
      insert into clients(canonical_name) values (coalesce(nullif(trim(p_new_canonical),''), trim(p_alias))) returning id into v_id;
    end if;
    if norm_key(p_alias) is distinct from (select name_key from clients where id = v_id) then
      insert into client_aliases(alias, client_id, added_by) values (trim(p_alias), v_id, v_email)
      on conflict (alias_key) where active do update set client_id = excluded.client_id, added_by = excluded.added_by, added_at = now();
    end if;
    update interviews set client_id = v_id where client_id is null and norm_key(client_name) = norm_key(p_alias);
  else
    raise exception 'INVALID_KIND';
  end if;
  perform write_audit('MAP_IDENTITY', null, p_kind, v_id, null, p_alias, null);
  return v_id;
end $$;

-- ---------------------------------------------------------------------
-- Day intake: paste → parsed rows (parsing happens in the app, same rules
-- as Parser.gs). Re-pasting a day is idempotent: identical lines are
-- matched by (normalized text, nth occurrence in the paste).
-- p_rows: [{raw_text, candidate_name, client_name, job_role, location_tag,
--           round_label, round_no, is_loop, time_label, start_min,
--           duration_min, is_night, parse_ok, parse_note}]
-- ---------------------------------------------------------------------
create or replace function ingest_day(p_team text, p_date date, p_rows jsonb, p_remove_missing boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r jsonb; i int := 0; v_norm text; v_occ int;
  seen jsonb := '{}'::jsonb;
  kept uuid[] := '{}';
  v_id uuid; v_inserted int := 0; v_updated int := 0; v_removed int := 0; v_blocked int := 0;
  v_existing boolean;
begin
  if not can_admin_team(p_team) then raise exception 'ACCESS_DENIED'; end if;
  if (select status from work_days where team_id = p_team and work_date = p_date) = 'completed' then
    raise exception 'WORK_DAY_COMPLETED';
  end if;
  insert into work_days(team_id, work_date) values (p_team, p_date) on conflict do nothing;

  for r in select * from jsonb_array_elements(p_rows) loop
    i := i + 1;
    continue when coalesce(trim(r->>'raw_text'),'') = '';
    v_norm := call_normalize(r->>'raw_text');
    v_occ := coalesce((seen->>v_norm)::int, 0) + 1;
    seen := jsonb_set(seen, array[v_norm], to_jsonb(v_occ));

    select id into v_id from interviews
     where team_id = p_team and work_date = p_date and normalized_text = v_norm and occurrence = v_occ;
    v_existing := found;

    if v_existing then
      update interviews set seq = i,
        candidate_name = r->>'candidate_name', client_name = r->>'client_name',
        candidate_id = coalesce(candidate_id, resolve_candidate_id(r->>'candidate_name')),
        client_id = coalesce(client_id, resolve_client_id(r->>'client_name')),
        job_role = r->>'job_role', location_tag = r->>'location_tag',
        round_label = r->>'round_label', round_no = (r->>'round_no')::int,
        is_loop = coalesce((r->>'is_loop')::boolean,false), time_label = r->>'time_label',
        start_min = (r->>'start_min')::int, duration_min = (r->>'duration_min')::int,
        is_night = coalesce((r->>'is_night')::boolean,false),
        parse_ok = coalesce((r->>'parse_ok')::boolean,true), parse_note = r->>'parse_note'
      where id = v_id;
      v_updated := v_updated + 1;
    else
      insert into interviews(team_id, work_date, seq, raw_text, occurrence, call_code,
        candidate_name, candidate_id, client_name, client_id, job_role, location_tag,
        round_label, round_no, is_loop, time_label, start_min, duration_min, is_night,
        parse_ok, parse_note, source, created_by)
      values (p_team, p_date, i, trim(r->>'raw_text'), v_occ, '',
        r->>'candidate_name', resolve_candidate_id(r->>'candidate_name'),
        r->>'client_name', resolve_client_id(r->>'client_name'),
        r->>'job_role', r->>'location_tag', r->>'round_label', (r->>'round_no')::int,
        coalesce((r->>'is_loop')::boolean,false), r->>'time_label', (r->>'start_min')::int,
        (r->>'duration_min')::int, coalesce((r->>'is_night')::boolean,false),
        coalesce((r->>'parse_ok')::boolean,true), r->>'parse_note', 'paste', app_user_id())
      returning id into v_id;
      v_inserted := v_inserted + 1;
    end if;
    kept := kept || v_id;
  end loop;

  if p_remove_missing then
    -- only untouched rows can be removed
    with gone as (
      delete from interviews x
       where x.team_id = p_team and x.work_date = p_date and not (x.id = any(kept))
         and x.outcome = 'scheduled'
         and not exists (select 1 from outcome_requests o where o.interview_id = x.id)
         and not exists (select 1 from reassignment_requests q where q.interview_id = x.id)
       returning 1)
    select count(*) into v_removed from gone;
    select count(*) into v_blocked from interviews x
     where x.team_id = p_team and x.work_date = p_date and not (x.id = any(kept));
  end if;

  perform write_audit('INGEST_DAY', p_team, 'Work Day', p_date::text, null,
          (v_inserted + v_updated)::text,
          jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'removed', v_removed, 'kept_missing', v_blocked));
  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'removed', v_removed, 'kept_missing', v_blocked);
end $$;

-- ---------------------------------------------------------------------
-- Assignment (scheduler output or manual edits). Admin only.
-- p_items: [{interview_id, handler_id|null, mode}]
-- ---------------------------------------------------------------------
create or replace function set_assignments(p_team text, p_items jsonb) returns int
language plpgsql security definer set search_path = public as $$
declare r jsonb; n int := 0; v_old text; v_new text;
begin
  if not can_admin_team(p_team) then raise exception 'ACCESS_DENIED'; end if;
  for r in select * from jsonb_array_elements(p_items) loop
    v_new := nullif(r->>'handler_id','');
    if v_new is not null and not exists (select 1 from handlers where id = v_new and team_id = p_team) then
      raise exception 'HANDLER_NOT_IN_TEAM:%', v_new;
    end if;
    select handler_id into v_old from interviews
     where id = (r->>'interview_id')::uuid and team_id = p_team and outcome = 'scheduled'
       and not exists (select 1 from outcome_requests o where o.interview_id = interviews.id and o.status = 'pending')
     for update;
    continue when not found;
    update interviews set handler_id = v_new, assignment_mode = coalesce(r->>'mode','manual')
     where id = (r->>'interview_id')::uuid;
    if v_old is distinct from v_new then
      n := n + 1;
      perform write_audit('ASSIGN_CALL', p_team, 'Call', r->>'interview_id', v_old, v_new,
                          jsonb_build_object('mode', r->>'mode'));
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Handler: submit outcome (submitPortalCallOutcome)
-- ---------------------------------------------------------------------
create or replace function submit_outcome(p_interview uuid, p_outcome call_outcome) returns uuid
language plpgsql security definer set search_path = public as $$
declare iv interviews; v_admin boolean; v_id uuid;
begin
  select * into iv from interviews where id = p_interview for update;
  if not found then raise exception 'CALL_NOT_FOUND'; end if;
  v_admin := can_admin_team(iv.team_id);
  if p_outcome = 'scheduled' then raise exception 'INVALID_CALL_OUTCOME'; end if;
  if iv.handler_id is null then raise exception 'UNASSIGNED_CALL_CANNOT_BE_SUBMITTED'; end if;
  if not v_admin and not (iv.handler_id = any(my_handler_ids())) then raise exception 'CALL_ACCESS_DENIED'; end if;
  if iv.outcome <> 'scheduled' then raise exception 'CALL_ALREADY_FINALIZED'; end if;
  if exists (select 1 from reassignment_requests where interview_id = p_interview and status = 'pending') then
    raise exception 'CALL_HAS_PENDING_REASSIGNMENT';
  end if;
  if not v_admin and (iv.candidate_id is null or iv.client_id is null)
     and coalesce((select require_identity from teams where id = iv.team_id), true)
     and not exists (select 1 from outcome_requests where interview_id = p_interview and status = 'pending') then
    raise exception 'CALL_IDENTITY_UNRESOLVED';
  end if;

  update outcome_requests set requested_outcome = p_outcome, submitted_at = now(),
         submitted_by = app_user_id(), submitted_email = (select email from app_users where id = app_user_id())
   where interview_id = p_interview and kind = 'outcome' and status = 'pending'
  returning id into v_id;
  if v_id is null then
    insert into outcome_requests(interview_id, team_id, kind, previous_outcome, requested_outcome, handler_id,
                                 submitted_by, submitted_email)
    values (p_interview, iv.team_id, 'outcome', 'scheduled', p_outcome, iv.handler_id,
            app_user_id(), (select email from app_users where id = app_user_id()))
    returning id into v_id;
  end if;
  perform write_audit('SUBMIT_CALL_OUTCOME', iv.team_id, 'Call Outcome', v_id::text, 'scheduled',
                      p_outcome::text || ' - pending', jsonb_build_object('call', iv.call_code));
  return v_id;
end $$;

-- Handler: request correction of an already-approved outcome
create or replace function request_outcome_correction(p_interview uuid, p_outcome call_outcome) returns uuid
language plpgsql security definer set search_path = public as $$
declare iv interviews; v_id uuid;
begin
  select * into iv from interviews where id = p_interview;
  if not found then raise exception 'CALL_NOT_FOUND'; end if;
  if not can_admin_team(iv.team_id) and not (iv.handler_id = any(my_handler_ids())) then raise exception 'CALL_ACCESS_DENIED'; end if;
  if iv.outcome = 'scheduled' then raise exception 'CALL_NOT_FINALIZED'; end if;
  if iv.outcome = p_outcome or p_outcome = 'scheduled' then raise exception 'INVALID_CORRECTION'; end if;
  insert into outcome_requests(interview_id, team_id, kind, previous_outcome, requested_outcome, handler_id, submitted_by, submitted_email)
  values (p_interview, iv.team_id, 'correction', iv.outcome, p_outcome, iv.handler_id,
          app_user_id(), (select email from app_users where id = app_user_id()))
  on conflict (interview_id, kind) where status = 'pending'
  do update set requested_outcome = excluded.requested_outcome, submitted_at = now()
  returning id into v_id;
  perform write_audit('REQUEST_OUTCOME_CORRECTION', iv.team_id, 'Call Outcome', v_id::text, iv.outcome::text, p_outcome::text, null);
  return v_id;
end $$;

-- Admin: approve / reject outcome + correction requests (batch)
create or replace function review_outcome_requests(p_ids uuid[], p_approve boolean, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare rq outcome_requests; iv interviews; n int := 0; v_me uuid := app_user_id();
        v_email text := (select email from app_users where id = app_user_id());
begin
  for rq in select * from outcome_requests where id = any(p_ids) and status = 'pending' for update loop
    if not can_admin_team(rq.team_id) then raise exception 'ACCESS_DENIED'; end if;
    select * into iv from interviews where id = rq.interview_id for update;
    if p_approve then
      if rq.kind = 'outcome' and iv.outcome <> 'scheduled' then raise exception 'CALL_ALREADY_FINALIZED:%', iv.call_code; end if;
      if rq.kind = 'correction' and iv.outcome is distinct from rq.previous_outcome then
        raise exception 'CALL_OUTCOME_CHANGED:%', iv.call_code;
      end if;
      update interviews set outcome = rq.requested_outcome, outcome_approved_at = now(), outcome_approved_by = v_me
       where id = iv.id;
    end if;
    update outcome_requests set status = case when p_approve then 'approved'::request_status else 'rejected'::request_status end,
           reviewed_by = v_me, reviewed_email = v_email, reviewed_at = now(),
           review_note = coalesce(p_note, case when p_approve then 'Approved from portal' else 'Rejected from portal' end)
     where id = rq.id;
    perform write_audit(case when p_approve then 'APPROVE_' else 'REJECT_' end || upper(rq.kind::text),
                        rq.team_id, 'Call Outcome', rq.id::text, iv.outcome::text, rq.requested_outcome::text,
                        jsonb_build_object('call', iv.call_code));
    n := n + 1;
  end loop;
  return n;
end $$;

-- Admin: reverse an approved outcome back to scheduled
create or replace function reverse_outcome(p_interview uuid, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare iv interviews;
begin
  select * into iv from interviews where id = p_interview for update;
  if not found then raise exception 'CALL_NOT_FOUND'; end if;
  if not can_admin_team(iv.team_id) then raise exception 'ACCESS_DENIED'; end if;
  update interviews set outcome = 'scheduled', outcome_approved_at = null, outcome_approved_by = null where id = p_interview;
  perform write_audit('REVERSE_CALL_OUTCOME', iv.team_id, 'Call', iv.call_code, iv.outcome::text, 'scheduled',
                      jsonb_build_object('note', p_note));
end $$;

-- ---------------------------------------------------------------------
-- Reassignment
-- ---------------------------------------------------------------------
create or replace function request_reassignment(p_interview uuid, p_to_handler text) returns uuid
language plpgsql security definer set search_path = public as $$
declare iv interviews; v_id uuid;
begin
  select * into iv from interviews where id = p_interview;
  if not found then raise exception 'CALL_NOT_FOUND'; end if;
  if not can_admin_team(iv.team_id) and not (iv.handler_id = any(my_handler_ids())) then raise exception 'CALL_ACCESS_DENIED'; end if;
  if iv.outcome <> 'scheduled' then raise exception 'CALL_ALREADY_FINALIZED'; end if;
  if iv.handler_id = p_to_handler then raise exception 'SAME_HANDLER'; end if;
  if not exists (select 1 from handlers where id = p_to_handler and team_id = iv.team_id and active) then
    raise exception 'HANDLER_NOT_IN_TEAM';
  end if;
  if exists (select 1 from outcome_requests where interview_id = p_interview and status = 'pending') then
    raise exception 'CALL_HAS_PENDING_OUTCOME';
  end if;
  insert into reassignment_requests(interview_id, team_id, from_handler_id, to_handler_id, requested_by, requested_email)
  values (p_interview, iv.team_id, iv.handler_id, p_to_handler, app_user_id(), (select email from app_users where id = app_user_id()))
  on conflict (interview_id) where status = 'pending'
  do update set to_handler_id = excluded.to_handler_id, requested_at = now()
  returning id into v_id;
  perform write_audit('REQUEST_REASSIGNMENT', iv.team_id, 'Call', iv.call_code, iv.handler_id, p_to_handler, null);
  return v_id;
end $$;

create or replace function review_reassignment(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare rq reassignment_requests; iv interviews;
begin
  select * into rq from reassignment_requests where id = p_id and status = 'pending' for update;
  if not found then raise exception 'REQUEST_NOT_PENDING'; end if;
  if not can_admin_team(rq.team_id) then raise exception 'ACCESS_DENIED'; end if;
  select * into iv from interviews where id = rq.interview_id for update;
  if p_approve then
    if iv.outcome <> 'scheduled' then raise exception 'CALL_ALREADY_FINALIZED'; end if;
    if iv.handler_id is distinct from rq.from_handler_id then raise exception 'CALL_ASSIGNMENT_CHANGED'; end if;
    update interviews set handler_id = rq.to_handler_id, assignment_mode = 'manual' where id = iv.id;
  end if;
  update reassignment_requests set status = case when p_approve then 'approved'::request_status else 'rejected'::request_status end,
         reviewed_by = app_user_id(), reviewed_email = (select email from app_users where id = app_user_id()),
         reviewed_at = now(), review_note = coalesce(p_note, case when p_approve then 'Approved from portal' else 'Rejected from portal' end)
   where id = p_id;
  perform write_audit(case when p_approve then 'APPROVE_REASSIGNMENT' else 'REJECT_REASSIGNMENT' end,
                      rq.team_id, 'Call', iv.call_code, rq.from_handler_id, rq.to_handler_id, null);
end $$;

-- ---------------------------------------------------------------------
-- Selection (submitSelectionRequest / adminMarkInterviewSelected)
-- ---------------------------------------------------------------------
create or replace function request_selection(p_interview uuid, p_selection selection_status, p_date date default null) returns uuid
language plpgsql security definer set search_path = public as $$
declare iv interviews; v_id uuid;
begin
  select * into iv from interviews where id = p_interview;
  if not found then raise exception 'CALL_NOT_FOUND'; end if;
  if not can_admin_team(iv.team_id) and not (iv.handler_id = any(my_handler_ids())) then raise exception 'CALL_ACCESS_DENIED'; end if;
  if iv.outcome <> 'completed' then raise exception 'CALL_NOT_COMPLETED'; end if;
  if iv.selection = p_selection then raise exception 'SELECTION_UNCHANGED'; end if;
  insert into selection_requests(interview_id, team_id, current_selection, requested_selection, selection_date, requested_by, requested_email)
  values (p_interview, iv.team_id, iv.selection, p_selection, coalesce(p_date, current_date), app_user_id(),
          (select email from app_users where id = app_user_id()))
  on conflict (interview_id) where status = 'pending'
  do update set requested_selection = excluded.requested_selection, selection_date = excluded.selection_date, requested_at = now()
  returning id into v_id;
  perform write_audit('REQUEST_SELECTION', iv.team_id, 'Call', iv.call_code, iv.selection::text, p_selection::text, null);
  return v_id;
end $$;

create or replace function review_selection(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public as $$
declare rq selection_requests; iv interviews;
begin
  select * into rq from selection_requests where id = p_id and status = 'pending' for update;
  if not found then raise exception 'REQUEST_NOT_PENDING'; end if;
  if not can_admin_team(rq.team_id) then raise exception 'ACCESS_DENIED'; end if;
  select * into iv from interviews where id = rq.interview_id;
  if p_approve then
    update interviews set selection = rq.requested_selection,
           selection_date = case when rq.requested_selection = 'selected' then rq.selection_date else selection_date end
     where id = rq.interview_id;
  end if;
  update selection_requests set status = case when p_approve then 'approved'::request_status else 'rejected'::request_status end,
         reviewed_by = app_user_id(), reviewed_email = (select email from app_users where id = app_user_id()),
         reviewed_at = now(), review_note = p_note
   where id = p_id;
  perform write_audit(case when p_approve then 'APPROVE_SELECTION' else 'REJECT_SELECTION' end,
                      rq.team_id, 'Call', iv.call_code, rq.current_selection::text, rq.requested_selection::text, null);
end $$;

create or replace function admin_set_selection(p_interview uuid, p_selection selection_status, p_date date default null) returns void
language plpgsql security definer set search_path = public as $$
declare iv interviews;
begin
  select * into iv from interviews where id = p_interview for update;
  if not found then raise exception 'CALL_NOT_FOUND'; end if;
  if not can_admin_team(iv.team_id) then raise exception 'ACCESS_DENIED'; end if;
  update interviews set selection = p_selection,
         selection_date = case when p_selection = 'selected' then coalesce(p_date, selection_date, current_date) else selection_date end
   where id = p_interview;
  -- close any pending request for this call
  update selection_requests set status = 'approved', reviewed_by = app_user_id(), reviewed_at = now(),
         review_note = 'Superseded by admin update'
   where interview_id = p_interview and status = 'pending';
  perform write_audit('ADMIN_SET_SELECTION', iv.team_id, 'Call', iv.call_code, iv.selection::text, p_selection::text, null);
end $$;

-- ---------------------------------------------------------------------
-- Team day control (completePortalTeamDay)
-- ---------------------------------------------------------------------
create or replace function work_day_state(p_team text, p_date date) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not in_team(p_team) then null else jsonb_build_object(
    'status', coalesce((select status::text from work_days where team_id = p_team and work_date = p_date), 'none'),
    'total', (select count(*) from interviews where team_id = p_team and work_date = p_date),
    'unassigned', (select count(*) from interviews where team_id = p_team and work_date = p_date and handler_id is null),
    'scheduled', (select count(*) from interviews where team_id = p_team and work_date = p_date and outcome = 'scheduled'),
    'pending_outcomes', (select count(*) from outcome_requests o join interviews i on i.id = o.interview_id
                          where i.team_id = p_team and i.work_date = p_date and o.status = 'pending'),
    'pending_reassignments', (select count(*) from reassignment_requests r join interviews i on i.id = r.interview_id
                          where i.team_id = p_team and i.work_date = p_date and r.status = 'pending')
  ) end
$$;

create or replace function complete_work_day(p_team text, p_date date) returns jsonb
language plpgsql security definer set search_path = public as $$
declare st jsonb;
begin
  if not can_admin_team(p_team) then raise exception 'ACCESS_DENIED'; end if;
  st := work_day_state(p_team, p_date);
  if (st->>'pending_outcomes')::int > 0 or (st->>'pending_reassignments')::int > 0 then
    raise exception 'WORK_DAY_HAS_PENDING_REQUESTS';
  end if;
  insert into work_days(team_id, work_date, status, completed_at, completed_by)
  values (p_team, p_date, 'completed', now(), app_user_id())
  on conflict (team_id, work_date) do update set status = 'completed', completed_at = now(), completed_by = app_user_id();
  perform write_audit('COMPLETE_WORK_DAY', p_team, 'Work Day', p_date::text, 'open', 'completed', st);
  return recompute_incentives(p_team);
end $$;

create or replace function reopen_work_day(p_team text, p_date date) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not can_admin_team(p_team) then raise exception 'ACCESS_DENIED'; end if;
  update work_days set status = 'open', completed_at = null, completed_by = null where team_id = p_team and work_date = p_date;
  perform write_audit('REOPEN_WORK_DAY', p_team, 'Work Day', p_date::text, 'completed', 'open', null);
end $$;
