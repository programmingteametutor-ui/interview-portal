-- =====================================================================
-- Incentive engine (Engine.scanIncentives + PromotionEngine + TeamLookup)
--
-- PROMOTION (team-first model):
--   An earning call = interview with outcome 'completed', a handler, and
--   a numbered round (1..998). Evidence = the EARLIEST later interview for
--   the same candidate + client with a HIGHER round (Final = 999), that
--   was not cancelled (rescheduled still proves advancement).
--   Amount: from 1st round -> first_promotion (100); from 2nd+ -> promotion (500)
-- SELECTION:
--   completed call marked selected -> selection amount (2000), dated by
--   selection_date (falls back to the call date). One per candidate+client.
--
-- The ledger is permanent: recompute only INSERTS missing rows.
-- =====================================================================

create or replace function rule_amount(p_team text, p_rule text) returns numeric
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select amount from incentive_rules where team_id = p_team and rule = p_rule),
    (select amount from incentive_rules where team_id is null and rule = p_rule),
    0)
$$;

create or replace function candidate_key(p_id text, p_name text) returns text
language sql immutable as $$ select coalesce(p_id, 'n:' || norm_key(p_name)) $$;
create or replace function client_key(p_id text, p_name text) returns text
language sql immutable as $$ select coalesce(p_id, 'n:' || norm_key(p_name)) $$;

create or replace function incentive_natural_key(p_type incentive_type, p_cand_key text, p_client_key text,
                                                 p_from_no int, p_prev_date date, p_handler text)
returns text language sql immutable as $$
  select case p_type
    when 'promotion' then concat_ws('|','P', p_cand_key, p_client_key, p_from_no, p_prev_date, lower(coalesce(p_handler,'')))
    else concat_ws('|','S', p_cand_key, p_client_key)
  end
$$;

create or replace function round_label(n int) returns text language sql immutable as $$
  select case when n is null then null when n = 999 then 'Final'
    else n || case when n % 100 between 11 and 13 then 'th'
                   when n % 10 = 1 then 'st' when n % 10 = 2 then 'nd' when n % 10 = 3 then 'rd' else 'th' end || ' Round'
  end
$$;

-- Preview without writing (used by the UI "Scan" button and by tests)
create or replace function promotion_candidates(p_team text)
returns table (earning_id uuid, evidence_id uuid, natural_key text, candidate_name text, client_name text,
               from_no int, to_no int, previous_date date, promotion_date date, handler_id text, amount numeric)
language sql stable security definer set search_path = public as $$
  with k0 as (
    select i.*, candidate_key(i.candidate_id, i.candidate_name) ck, client_key(i.client_id, i.client_name) kk
    from interviews i
    where i.team_id = p_team and i.round_no is not null
      and norm_key(i.candidate_name) is not null and norm_key(i.client_name) is not null
  ),
  k as (
    -- PROMO_getEffectiveRawRecords_: an occurrence followed by a "Rescheduled from ..." copy of the
    -- same candidate/client/round is superseded and cannot serve as evidence.
    select k0.*,
           coalesce(lead(k0.raw_text) over w ~* '\mresched(ule|uled|uling)?\s+from\M', false) as superseded
    from k0
    window w as (partition by k0.ck, k0.kk, k0.round_no order by k0.work_date, k0.start_min nulls last, k0.seq)
  ),
  earning as (
    select * from k where outcome = 'completed' and handler_id is not null and round_no between 1 and 998
  )
  select e.id, x.id,
         incentive_natural_key('promotion', e.ck, e.kk, e.round_no, e.work_date, e.handler_id),
         coalesce(c.canonical_name, e.candidate_name), coalesce(cl.canonical_name, e.client_name),
         e.round_no, x.round_no, e.work_date, x.work_date, e.handler_id,
         case when e.round_no = 1 then rule_amount(p_team,'first_promotion') else rule_amount(p_team,'promotion') end
  from earning e
  join lateral (
    select x.* from k x
    where x.ck = e.ck and x.kk = e.kk and x.round_no > e.round_no
      and x.outcome <> 'cancelled' and not x.superseded
      and (x.work_date > e.work_date
           -- PROMO_isChronologicallyAfter_: same day only for R -> R+1 (or Loop), with both times known
           or (x.work_date = e.work_date and x.start_min is not null and e.start_min is not null
               and x.start_min > e.start_min
               and ((x.round_no = e.round_no + 1 and x.round_no <> 999) or x.is_loop or e.is_loop)))
    order by x.work_date, x.start_min nulls last, x.round_no
    limit 1
  ) x on true
  left join candidates c on c.id = e.candidate_id
  left join clients cl on cl.id = e.client_id
  where can_admin_team(p_team)
$$;

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
    -- never double-pay a legacy ledger row whose client was spelled differently:
    -- same handler + earning date + from-round + candidate = same promotion
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
             or norm_key(i.client_name) like norm_key(x.client_name) || '%'))
  order by nk, i.work_date desc
  on conflict (natural_key) do nothing;
  get diagnostics v_s = row_count;

  perform write_audit('RECOMPUTE_INCENTIVES', p_team, 'Incentives', p_team, null, (v_p + v_s)::text,
                      jsonb_build_object('promotions_added', v_p, 'selections_added', v_s));
  return jsonb_build_object('promotions_added', v_p, 'selections_added', v_s);
end $$;

create or replace function set_incentive_status(p_ids uuid[], p_status incentive_status, p_note text default null) returns int
language plpgsql security definer set search_path = public as $$
declare r incentives; n int := 0;
begin
  for r in select * from incentives where id = any(p_ids) for update loop
    if not can_admin_team(r.team_id) then raise exception 'ACCESS_DENIED'; end if;
    update incentives set status = p_status, reviewed_by = app_user_id(), reviewed_at = now(),
           paid_at = case when p_status = 'paid' then now() else paid_at end,
           notes = coalesce(p_note, notes)
     where id = r.id;
    perform write_audit('SET_INCENTIVE_STATUS', r.team_id, 'Incentive', r.id::text, r.status::text, p_status::text,
                        jsonb_build_object('note', p_note));
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------
-- Reporting views (security_invoker => RLS of the caller applies)
-- ---------------------------------------------------------------------
create or replace view monthly_incentive_summary with (security_invoker = true) as
select team_id,
       date_trunc('month', event_date)::date as month,
       handler_id, handler_name,
       sum(amount) filter (where type = 'promotion') as promotion_amount,
       sum(amount) filter (where type = 'selection') as selection_amount,
       sum(amount) as total_amount,
       count(*) filter (where type = 'promotion') as promotion_count,
       count(*) filter (where type = 'selection') as selection_count,
       sum(amount) filter (where status = 'paid') as paid_amount
from incentives
where status <> 'rejected'
group by team_id, date_trunc('month', event_date), handler_id, handler_name;

create or replace view handler_call_stats with (security_invoker = true) as
select i.team_id, date_trunc('month', i.work_date)::date as month, i.handler_id, h.name as handler_name,
       count(*) as total_calls,
       count(*) filter (where i.outcome = 'completed') as completed,
       count(*) filter (where i.outcome = 'rescheduled') as rescheduled,
       count(*) filter (where i.outcome = 'cancelled') as cancelled,
       count(*) filter (where i.outcome = 'scheduled') as open_calls,
       count(*) filter (where i.is_night) as night_calls,
       count(*) filter (where i.selection = 'selected') as selections
from interviews i left join handlers h on h.id = i.handler_id
group by i.team_id, date_trunc('month', i.work_date), i.handler_id, h.name;

-- ---------------------------------------------------------------------
-- Defaults (Settings sheet)
-- ---------------------------------------------------------------------
insert into incentive_rules(team_id, rule, amount) values
  (null, 'first_promotion', 100), (null, 'promotion', 500), (null, 'selection', 2000)
on conflict do nothing;

-- ---------------------------------------------------------------------
-- Lock down internal helpers from API roles (Supabase grants EXECUTE to
-- anon/authenticated by default).
-- ---------------------------------------------------------------------
do $$
declare r text;
begin
  foreach r in array array['anon','authenticated'] loop
    if exists (select 1 from pg_roles where rolname = r) then
      execute format('revoke execute on function link_auth_user(uuid,text) from %I', r);
      execute format('revoke execute on function write_audit(text,text,text,text,text,text,jsonb) from %I', r);
      execute format('revoke execute on function on_auth_user_created() from %I', r);
      execute format('revoke all on all functions in schema public from anon');
    end if;
  end loop;
  if exists (select 1 from pg_roles where rolname = 'anon') then
    -- anon gets nothing; every table also has RLS requiring a portal user
    execute 'revoke all on all tables in schema public from anon';
  end if;
end $$;
