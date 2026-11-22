-- psql -d <local db loaded with seed.sql> -Atq -o scripts/test/ui-smoke/fixture.json -f scripts/test/ui-smoke/export-fixture.sql
select json_build_object(
 'teams', (select json_agg(t) from teams t),
 'handlers', (select json_agg(h) from handlers h),
 'app_users', (select json_agg(u) from app_users u),
 'user_roles', (select json_agg(r) from user_roles r),
 'interviews', (select json_agg(i) from interviews i where work_date >= current_date - 45
                 or id in (select earning_interview_id from promotion_recoveries union select evidence_interview_id from promotion_recoveries)),
 'outcome_requests', (select coalesce(json_agg(o),'[]') from outcome_requests o),
 'reassignment_requests', '[]'::json, 'selection_requests', '[]'::json,
 'incentives', (select json_agg(x) from (select * from incentives where event_date >= current_date - 90) x),
 'monthly_incentive_summary', (select json_agg(m) from monthly_incentive_summary m),
 'handler_call_stats', (select json_agg(c) from handler_call_stats c where month >= current_date - 90),
 'candidates', (select json_agg(json_build_object('id',id,'canonical_name',canonical_name,'name_key',name_key)) from candidates),
 'clients', (select json_agg(json_build_object('id',id,'canonical_name',canonical_name,'name_key',name_key)) from clients),
 'candidate_aliases', (select json_agg(json_build_object('alias_key',alias_key,'active',active)) from candidate_aliases),
 'client_aliases', (select json_agg(json_build_object('alias_key',alias_key,'active',active)) from client_aliases),
 'handler_preferences', (select coalesce(json_agg(p),'[]') from handler_preferences p),
 'handler_leaves', (select coalesce(json_agg(l),'[]') from handler_leaves l),
 'incentive_rules', (select json_agg(r) from incentive_rules r),
 'daily_call_stats', (select json_agg(d) from daily_call_stats d where work_date >= date_trunc('month', current_date)),
 'handler_performance', (select json_agg(h) from handler_performance('TEAM-PA', date_trunc('month', current_date)::date) h),
 'promotion_recoveries', (select coalesce(json_agg(r),'[]') from promotion_recoveries r),
 'audit_log', (select json_agg(a) from (select * from audit_log order by id desc limit 50) a)
);
