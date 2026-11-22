-- =====================================================================
-- Parity pack: data behind the Interviews, Promotions, Reports pages and
-- the incentive-scan status panel (getPortalInterviewStatusData,
-- getPortalReportsData, getPortalIncentiveScanStatus).
-- =====================================================================

-- Daily call activity per handler (Reports → Daily Call Activity / Daily Team Breakdown)
create or replace view daily_call_stats with (security_invoker = true) as
select i.team_id, i.work_date, i.handler_id, h.name as handler_name,
       coalesce(i.assignment_mode = 'support', false) as is_support,
       count(*) as total_calls,
       count(*) filter (where i.outcome = 'completed') as completed,
       count(*) filter (where i.outcome = 'rescheduled') as rescheduled,
       count(*) filter (where i.outcome = 'cancelled') as cancelled,
       count(*) filter (where i.outcome = 'scheduled') as open_calls,
       count(*) filter (where i.is_night) as night_calls,
       count(*) filter (where i.selection = 'selected') as selections
from interviews i left join handlers h on h.id = i.handler_id
-- legacy Raw Data lines that no team handler took are history, not "unassigned calls"
where not (i.source = 'import_raw' and i.handler_id is null and coalesce(i.assignment_mode,'') <> 'support')
group by i.team_id, i.work_date, i.handler_id, h.name, coalesce(i.assignment_mode = 'support', false);

-- Handler performance for a month: calls + incentives in one row
create or replace function handler_performance(p_team text, p_month date)
returns table (handler_id text, handler_name text, total_calls bigint, completed bigint, rescheduled bigint, cancelled bigint,
               night_calls bigint, selected_interviews bigint, promotions bigint, promotion_amount numeric,
               selections bigint, selection_amount numeric, total_incentive numeric)
language sql stable security invoker set search_path = public as $$
  with c as (
    select handler_id, sum(total_calls) t, sum(completed) co, sum(rescheduled) rs, sum(cancelled) ca, sum(night_calls) n, sum(selections) s
    from daily_call_stats
    where team_id = p_team and work_date >= p_month and work_date < (p_month + interval '1 month') and handler_id is not null
    group by handler_id),
  x as (
    select handler_id,
           count(*) filter (where type = 'promotion') p, coalesce(sum(amount) filter (where type = 'promotion'),0) pa,
           count(*) filter (where type = 'selection') s, coalesce(sum(amount) filter (where type = 'selection'),0) sa
    from incentives
    where team_id = p_team and status <> 'rejected' and event_date >= p_month and event_date < (p_month + interval '1 month')
    group by handler_id)
  select h.id, h.name, coalesce(c.t,0)::bigint, coalesce(c.co,0)::bigint, coalesce(c.rs,0)::bigint, coalesce(c.ca,0)::bigint,
         coalesce(c.n,0)::bigint, coalesce(c.s,0)::bigint, coalesce(x.p,0), coalesce(x.pa,0), coalesce(x.s,0), coalesce(x.sa,0),
         coalesce(x.pa,0) + coalesce(x.sa,0)
  from handlers h
  left join c on c.handler_id = h.id
  left join x on x.handler_id = h.id
  where (c.handler_id is not null or x.handler_id is not null)
    and exists (select 1 from handlers hh where hh.id = h.id)   -- RLS on handlers applies (security invoker)
$$;

-- Incentive scan status panel: last scans, last day closed, ledger counters
create or replace function incentive_scan_status(p_team text) returns jsonb
language sql stable security definer set search_path = public as $$
  select case when not in_team(p_team) then null else jsonb_build_object(
    'last_scan', (select jsonb_build_object('at', at, 'by', actor_email, 'details', details) from audit_log
                  where team_id = p_team and action = 'RECOMPUTE_INCENTIVES' order by at desc limit 1),
    'last_recovery_scan', (select jsonb_build_object('at', at, 'by', actor_email, 'details', details) from audit_log
                  where team_id = p_team and action = 'RECOVERY_SCAN' order by at desc limit 1),
    'last_closed_day', (select max(work_date) from work_days where team_id = p_team and status = 'completed'),
    'ledger', (select jsonb_build_object(
                 'pending', count(*) filter (where status = 'pending'),
                 'approved', count(*) filter (where status = 'approved'),
                 'paid', count(*) filter (where status = 'paid'),
                 'rejected', count(*) filter (where status = 'rejected'),
                 'total_open_amount', coalesce(sum(amount) filter (where status in ('pending','approved')),0))
               from incentives where team_id = p_team
                 and (can_admin_team(p_team) or handler_id = any(my_handler_ids()))),
    'pending_recoveries', (select count(*) from promotion_recoveries where team_id = p_team and status = 'pending')
  ) end
$$;
