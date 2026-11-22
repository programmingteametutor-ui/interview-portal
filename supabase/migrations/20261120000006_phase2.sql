-- =====================================================================
-- Phase 2: Promotion Recovery, Coverage Desk export, view-as preview,
--          initial-assignee tracking, data-health checks
-- =====================================================================

-- ---------------------------------------------------------------------
-- Initial assignee (Coverage Desk "initialAssignee")
-- ---------------------------------------------------------------------
alter table interviews add column if not exists initial_handler_id text references handlers(id);
update interviews set initial_handler_id = handler_id where initial_handler_id is null and handler_id is not null;

create or replace function interviews_initial_handler() returns trigger language plpgsql as $$
begin
  if new.initial_handler_id is null and new.handler_id is not null then
    new.initial_handler_id := new.handler_id;
  end if;
  return new;
end $$;
drop trigger if exists interviews_initial on interviews;
create trigger interviews_initial before insert or update of handler_id on interviews
  for each row execute function interviews_initial_handler();

-- ---------------------------------------------------------------------
-- Promotion Recovery (Promotion Recovery + Recovery Exceptions +
-- Recovery Evidence + Recovery Applied Log)
-- ---------------------------------------------------------------------
create table promotion_recoveries (
  id                     text primary key,            -- REC|earning|evidence  or  EXC|kind|earning
  team_id                text not null references teams(id),
  kind                   text not null check (kind in ('recovery','same_day','ambiguous')),
  earning_interview_id   uuid not null references interviews(id) on delete cascade,
  evidence_interview_id  uuid not null references interviews(id) on delete cascade,
  second_evidence_id     uuid references interviews(id) on delete set null,
  candidate_score        int not null,
  client_score           int not null,
  confidence             int not null,
  from_round_no          int not null,
  to_round_no            int not null,
  amount                 numeric(12,2) not null,
  reason                 text,
  status                 text not null default 'pending' check (status in ('pending','applied','rejected','dismissed')),
  incentive_id           uuid references incentives(id) on delete set null,
  first_seen_at          timestamptz not null default now(),
  last_seen_at           timestamptz not null default now(),
  reviewed_by            uuid references app_users(id),
  reviewed_at            timestamptz,
  review_note            text
);
create index promotion_recoveries_team on promotion_recoveries(team_id, status);
alter table promotion_recoveries enable row level security;

-- Decisions already taken in the Sheets system (Promotion Recovery / Recovery Exceptions),
-- so rejected items do not come back as pending after migration.
create table legacy_recovery_decisions (
  id             bigserial primary key,
  team_id        text not null references teams(id),
  candidate_key  text not null,
  team_date      date not null,
  from_round_no  int not null,
  status         text not null,       -- Rejected / Approved / Applied / Ignored / ...
  source_sheet   text
);
create index legacy_recovery_decisions_idx on legacy_recovery_decisions(team_id, team_date, from_round_no);
alter table legacy_recovery_decisions enable row level security;
create policy legacy_rec_read on legacy_recovery_decisions for select using (can_admin_team(team_id));
create policy recoveries_read on promotion_recoveries for select
  using (can_admin_team(team_id)
         or exists (select 1 from interviews i where i.id = earning_interview_id and i.handler_id = any(my_handler_ids())));

-- Save a scan computed by the app (shared/recovery.ts). Every row is re-validated here;
-- amounts come from incentive_rules; reviewed rows keep their status.
create or replace function save_recovery_scan(p_team text, p_rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; e interviews; x interviews; v_new int := 0; v_ins boolean; v_bad int := 0; v_amount numeric;
begin
  if not can_admin_team(p_team) then raise exception 'ACCESS_DENIED'; end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    e := null; x := null;
    select * into e from interviews where id = (r->>'earning_interview_id')::uuid and team_id = p_team;
    select * into x from interviews where id = (r->>'evidence_interview_id')::uuid and team_id = p_team;
    if e.id is null or x.id is null or e.outcome <> 'completed' or e.handler_id is null
       or e.round_no is null or x.round_no is null
       or not (case when x.round_no = 999 then e.round_no <> 999 else e.round_no <> 999 and x.round_no > e.round_no end)
       or x.work_date < e.work_date then
      v_bad := v_bad + 1; continue;
    end if;
    v_amount := case when e.round_no = 1 then rule_amount(p_team,'first_promotion') else rule_amount(p_team,'promotion') end;
    insert into promotion_recoveries(id, team_id, kind, earning_interview_id, evidence_interview_id, second_evidence_id,
      candidate_score, client_score, confidence, from_round_no, to_round_no, amount, reason)
    values (r->>'id', p_team, r->>'kind', e.id, x.id, nullif(r->>'second_evidence_id','')::uuid,
      (r->>'candidate_score')::int, (r->>'client_score')::int, (r->>'confidence')::int, e.round_no, x.round_no, v_amount, r->>'reason')
    on conflict (id) do update set
      last_seen_at = now(),
      candidate_score = excluded.candidate_score, client_score = excluded.client_score, confidence = excluded.confidence,
      evidence_interview_id = case when promotion_recoveries.status = 'pending' then excluded.evidence_interview_id else promotion_recoveries.evidence_interview_id end,
      second_evidence_id = case when promotion_recoveries.status = 'pending' then excluded.second_evidence_id else promotion_recoveries.second_evidence_id end,
      reason = excluded.reason
    returning (xmax = 0) into v_ins;   -- true when inserted
    if v_ins then
      v_new := v_new + 1;
      -- carry over a decision made in the legacy sheets
      update promotion_recoveries pr set
        status = case when d.status ~* 'reject' then 'rejected' else 'dismissed' end,
        review_note = 'Legacy decision: ' || d.status, reviewed_at = now()
      from (select status from legacy_recovery_decisions l
            where l.team_id = p_team and l.team_date = e.work_date and l.from_round_no = e.round_no
              and l.candidate_key in (norm_key(e.candidate_name),
                                      norm_key((select canonical_name from candidates where id = e.candidate_id)))
            limit 1) d
      where pr.id = r->>'id';
    end if;
  end loop;
  perform write_audit('RECOVERY_SCAN', p_team, 'Recovery', p_team, null, v_new::text,
                      jsonb_build_object('rows', jsonb_array_length(p_rows), 'new', v_new, 'invalid', v_bad));
  return jsonb_build_object('rows', jsonb_array_length(p_rows), 'new', v_new, 'invalid', v_bad);
end $$;

-- Approve (apply → ledger), reject, or dismiss. For same_day / ambiguous items the
-- admin may choose which evidence row proves the promotion (p_evidence).
create or replace function review_recovery(p_id text, p_decision text, p_note text default null, p_evidence uuid default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare rc promotion_recoveries; e interviews; x interviews; h handlers; v_inc uuid;
begin
  select * into rc from promotion_recoveries where id = p_id for update;
  if not found then raise exception 'RECOVERY_NOT_FOUND'; end if;
  if not can_admin_team(rc.team_id) then raise exception 'ACCESS_DENIED'; end if;
  if rc.status <> 'pending' then raise exception 'RECOVERY_ALREADY_REVIEWED'; end if;

  if p_decision = 'approve' then
    select * into e from interviews where id = rc.earning_interview_id;
    select * into x from interviews where id = coalesce(p_evidence, rc.evidence_interview_id) and team_id = rc.team_id;
    if x.id is null or x.round_no is null or x.work_date < e.work_date then raise exception 'INVALID_EVIDENCE'; end if;
    select * into h from handlers where id = e.handler_id;
    insert into incentives(natural_key, team_id, type, earning_interview_id, evidence_interview_id, candidate_name, client_name,
                           from_round, to_round, previous_date, event_date, handler_id, handler_name, amount, status, source, notes)
    values ('R|' || rc.id, rc.team_id, 'promotion', e.id, x.id,
            coalesce((select canonical_name from candidates where id = e.candidate_id), e.candidate_name),
            coalesce((select canonical_name from clients where id = e.client_id), e.client_name),
            round_label(e.round_no), round_label(x.round_no), e.work_date, x.work_date, h.id, h.name, rc.amount,
            'pending', 'recovery', 'Recovered: ' || coalesce(rc.reason,''))
    on conflict (natural_key) do nothing
    returning id into v_inc;
    update promotion_recoveries set status = 'applied', incentive_id = v_inc, evidence_interview_id = x.id,
           reviewed_by = app_user_id(), reviewed_at = now(), review_note = p_note where id = p_id;
  elsif p_decision in ('reject','dismiss') then
    update promotion_recoveries set status = case when p_decision = 'reject' then 'rejected' else 'dismissed' end,
           reviewed_by = app_user_id(), reviewed_at = now(), review_note = p_note where id = p_id;
  else
    raise exception 'INVALID_DECISION';
  end if;
  perform write_audit('RECOVERY_' || upper(p_decision), rc.team_id, 'Recovery', p_id, 'pending', p_decision,
                      jsonb_build_object('incentive', v_inc, 'note', p_note));
  return v_inc;
end $$;

-- The regular scan must not re-add a promotion that recovery already put in the ledger
create or replace function recompute_incentives(p_team text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_p int; v_s int;
begin
  if not can_admin_team(p_team) then raise exception 'ACCESS_DENIED'; end if;

  insert into incentives(natural_key, team_id, type, earning_interview_id, evidence_interview_id,
                         candidate_name, client_name, from_round, to_round, previous_date, event_date,
                         handler_id, handler_name, amount, status, source)
  select pc.natural_key, p_team, 'promotion', pc.earning_id, pc.evidence_id,
         pc.candidate_name, pc.client_name, round_label(pc.from_no), round_label(pc.to_no),
         pc.previous_date, pc.promotion_date, pc.handler_id, h.name, pc.amount, 'pending', 'engine'
  from promotion_candidates(p_team) pc
  join handlers h on h.id = pc.handler_id
  where pc.amount > 0
    and not exists (select 1 from incentives x where x.type = 'promotion' and x.earning_interview_id = pc.earning_id)
    and not exists (
      select 1 from incentives x
      where x.team_id = p_team and x.type = 'promotion' and x.previous_date = pc.previous_date
        and x.from_round ilike round_label(pc.from_no) and (x.handler_id = pc.handler_id or lower(x.handler_name) = lower(h.name))
        and (norm_key(x.candidate_name) = norm_key(pc.candidate_name)
             or resolve_candidate_id(x.candidate_name) = resolve_candidate_id(pc.candidate_name)))
  on conflict (natural_key) do nothing;
  get diagnostics v_p = row_count;

  insert into incentives(natural_key, team_id, type, earning_interview_id, candidate_name, client_name,
                         from_round, to_round, event_date, handler_id, handler_name, amount, status, source)
  select distinct on (nk)
         nk, p_team, 'selection', i.id, coalesce(c.canonical_name, i.candidate_name), coalesce(cl.canonical_name, i.client_name),
         '-', 'Selected', coalesce(i.selection_date, i.work_date), i.handler_id, h.name,
         rule_amount(p_team,'selection'), 'pending', 'engine'
  from (select i.*, incentive_natural_key('selection', candidate_key(i.candidate_id,i.candidate_name),
                                          client_key(i.client_id,i.client_name), null, null, null) nk
        from interviews i
        where i.team_id = p_team and i.selection = 'selected' and i.outcome = 'completed' and i.handler_id is not null
          and norm_key(i.candidate_name) is not null and norm_key(i.client_name) is not null) i
  join handlers h on h.id = i.handler_id
  left join candidates c on c.id = i.candidate_id
  left join clients cl on cl.id = i.client_id
  where rule_amount(p_team,'selection') > 0
    and not exists (
      select 1 from incentives x
      where x.team_id = p_team and x.type = 'selection'
        and (x.handler_id = i.handler_id or lower(x.handler_name) = lower(h.name))
        and (norm_key(x.candidate_name) = norm_key(i.candidate_name)
             or resolve_candidate_id(x.candidate_name) = resolve_candidate_id(i.candidate_name))
        and (norm_key(x.client_name) = norm_key(i.client_name) or resolve_client_id(x.client_name) = resolve_client_id(i.client_name)
             -- legacy ledger often holds "Final Interview - Sallie Mae" / "Modpac - Quality Engineer position"
             or position(norm_key(i.client_name) in norm_key(x.client_name)) > 0
             or position(norm_key(x.client_name) in norm_key(i.client_name)) > 0
             or x.event_date = coalesce(i.selection_date, i.work_date)))
  order by nk, i.work_date desc
  on conflict (natural_key) do nothing;
  get diagnostics v_s = row_count;

  -- recoveries made redundant by the exact scan
  update promotion_recoveries r set status = 'dismissed', review_note = 'Found by regular scan', reviewed_at = now()
   where r.team_id = p_team and r.status = 'pending'
     and exists (select 1 from incentives x where x.earning_interview_id = r.earning_interview_id and x.type = 'promotion');

  perform write_audit('RECOMPUTE_INCENTIVES', p_team, 'Incentives', p_team, null, (v_p + v_s)::text,
                      jsonb_build_object('promotions_added', v_p, 'selections_added', v_s));
  return jsonb_build_object('promotions_added', v_p, 'selections_added', v_s);
end $$;

-- ---------------------------------------------------------------------
-- View-as preview (getPortalTestAsOptions / setPortalTestView) — read-only,
-- super admins only. Returns the same shape as my_context().
-- ---------------------------------------------------------------------
create or replace function preview_context(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare u app_users;
begin
  if not is_super_admin() then raise exception 'ACCESS_DENIED'; end if;
  select * into u from app_users where id = p_user;
  if not found then raise exception 'USER_NOT_FOUND'; end if;
  return jsonb_build_object(
    'linked', true, 'preview', true,
    'user', jsonb_build_object('id', u.id, 'email', u.email, 'name', u.official_name, 'primary_team_id', u.primary_team_id),
    'roles', coalesce((select jsonb_agg(jsonb_build_object('role', ur.role, 'team_id', ur.team_id, 'handler_id', ur.handler_id,
                                         'handler_name', h.name, 'team_name', t.name) order by ur.role)
                       from user_roles ur left join handlers h on h.id = ur.handler_id left join teams t on t.id = ur.team_id
                       where ur.user_id = u.id and ur.active), '[]'::jsonb),
    'teams', coalesce((select jsonb_agg(jsonb_build_object('id', t.id, 'name', t.name) order by t.name) from teams t where t.active), '[]'::jsonb));
end $$;

-- ---------------------------------------------------------------------
-- Data health (dataintegrity page)
-- ---------------------------------------------------------------------
create or replace function data_health(p_team text, p_since date default current_date - 60) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not in_team(p_team) then null else jsonb_build_object(
    'unparsed', (select count(*) from interviews where team_id = p_team and work_date >= p_since and not parse_ok),
    'closed_day_unassigned', (select count(*) from interviews i join work_days w on w.team_id = i.team_id and w.work_date = i.work_date
                              where i.team_id = p_team and i.work_date >= p_since and w.status = 'completed'
                                and i.handler_id is null and coalesce(i.assignment_mode,'') <> 'support'
                                and i.source <> 'import_raw'),   -- legacy Raw Data lines the team never handled
    'closed_day_open', (select count(*) from interviews i join work_days w on w.team_id = i.team_id and w.work_date = i.work_date
                        where i.team_id = p_team and i.work_date >= p_since and w.status = 'completed' and i.outcome = 'scheduled' and i.handler_id is not null),
    'duplicate_lines', (select count(*) from interviews where team_id = p_team and work_date >= p_since and occurrence > 1),
    'unmapped_candidates', (select count(distinct norm_key(candidate_name)) from interviews where team_id = p_team and work_date >= p_since and candidate_id is null and candidate_name is not null),
    'unmapped_clients', (select count(distinct norm_key(client_name)) from interviews where team_id = p_team and work_date >= p_since and client_id is null and client_name is not null),
    'stale_requests', (select count(*) from outcome_requests where team_id = p_team and status = 'pending' and submitted_at < now() - interval '3 days')
                    + (select count(*) from reassignment_requests where team_id = p_team and status = 'pending' and requested_at < now() - interval '3 days'),
    'pending_recoveries', (select count(*) from promotion_recoveries where team_id = p_team and status = 'pending'),
    'open_days', (select coalesce(jsonb_agg(work_date order by work_date), '[]') from work_days where team_id = p_team and status = 'open' and work_date < current_date - 1)
  ) end
$$;

-- ---------------------------------------------------------------------
-- Coverage Desk export (read by the coverage-desk-export Edge Function
-- with the service role key; not exposed to API roles)
-- ---------------------------------------------------------------------
create or replace view coverage_assignments as
select i.call_code as "callId",
       t.name as team,
       case i.team_id when 'TEAM-PA' then 'PRADEEP' when 'TEAM-HYD' then 'HYD' else replace(i.team_id, 'TEAM-', '') end as "teamCode",
       to_char(i.work_date, 'FMMM/FMDD/YYYY FMDay') as date,
       to_char(i.work_date, 'YYYY-MM-DD') as "dateKey",
       coalesce(c.canonical_name, i.candidate_name, '') as candidate,
       coalesce(cl.canonical_name, i.client_name, '') as client,
       coalesce(i.time_label, '') as time,
       case when i.duration_min is null then '' else i.duration_min || ' Mins' end as duration,
       coalesce(h.name, case when i.assignment_mode = 'support' then 'Support' else '' end) as assignee,
       coalesce(h0.name, h.name, '') as "initialAssignee",
       case when i.outcome <> 'scheduled' then initcap(i.outcome::text)
            when exists (select 1 from outcome_requests o where o.interview_id = i.id and o.status = 'pending') then 'Pending Approval'
            else 'Scheduled' end as status,
       coalesce(i.assignment_mode = 'support', false) as support,
       i.is_night as "nightCall",
       to_char(i.work_date, 'YYYY-MM') as month_key
from interviews i
join teams t on t.id = i.team_id
left join handlers h on h.id = i.handler_id
left join handlers h0 on h0.id = i.initial_handler_id
left join candidates c on c.id = i.candidate_id
left join clients cl on cl.id = i.client_id;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on coverage_assignments from anon, authenticated';
  end if;
end $$;
