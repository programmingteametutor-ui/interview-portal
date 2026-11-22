-- Phase 2: recovery save/approve, duplicate guard, preview access, data health, coverage view.
-- Run after 10_workflow_test.sql on the same database.
\set ON_ERROR_STOP 1
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke execute on function link_auth_user(uuid,text) from authenticated;
revoke execute on function write_audit(text,text,text,text,text,text,jsonb) from authenticated;
set role authenticated;
select set_config('test.uid','11111111-0000-0000-0000-0000000000a1',false);   -- PA admin

-- earning call written one way, next round written another way (exact scan can't link them)
select ingest_day('TEAM-PA','2026-08-03','[{"raw_text":"Lahari B – Interview – Columbia Sportswear – 9:30 PM IST – Duration: 30 Mins (1st Round)","candidate_name":"Lahari B","client_name":"Columbia Sportswear","round_no":1,"start_min":1290}]'::jsonb);
select ingest_day('TEAM-PA','2026-08-10','[{"raw_text":"Lahari Beerla – Interview – Columbia Sportswear Co – 9:30 PM IST – Duration: 30 Mins (2nd Round)","candidate_name":"Lahari Beerla","client_name":"Columbia Sportswear Co","round_no":2,"start_min":1290}]'::jsonb);
select set_assignments('TEAM-PA', (select jsonb_agg(jsonb_build_object('interview_id',id,'handler_id','HAN-000003')) from interviews where work_date='2026-08-03'));
select submit_outcome((select id from interviews where work_date='2026-08-03'), 'completed');
select review_outcome_requests((select array_agg(id) from outcome_requests where status='pending'), true);
select recompute_incentives('TEAM-PA') as exact_scan_finds_nothing;

select save_recovery_scan('TEAM-PA', jsonb_build_array(jsonb_build_object(
  'id', 'REC|' || (select id from interviews where work_date='2026-08-03') || '|' || (select id from interviews where work_date='2026-08-10'),
  'kind','recovery','earning_interview_id',(select id from interviews where work_date='2026-08-03'),
  'evidence_interview_id',(select id from interviews where work_date='2026-08-10'),
  'candidate_score',96,'client_score',98,'confidence',97,'reason','test'),
  -- forged row: evidence BEFORE the earning call must be rejected by the server
  jsonb_build_object('id','REC|bad','kind','recovery','earning_interview_id',(select id from interviews where work_date='2026-08-10'),
  'evidence_interview_id',(select id from interviews where work_date='2026-08-03'),'candidate_score',100,'client_score',100,'confidence',100))) as scan;

-- handler cannot approve
select set_config('test.uid','11111111-0000-0000-0000-0000000000b1',false);
do $$ begin perform review_recovery((select id from promotion_recoveries limit 1), 'approve'); raise exception 'handler approved!';
exception when others then if sqlerrm not like '%ACCESS_DENIED%' and sqlerrm <> 'RECOVERY_NOT_FOUND' then raise; end if; end $$;
-- handler cannot preview others
do $$ begin perform preview_context('00000000-0000-0000-0000-0000000000a1'); raise exception 'handler previewed!';
exception when others then if sqlerrm <> 'ACCESS_DENIED' then raise; end if; end $$;

select set_config('test.uid','11111111-0000-0000-0000-0000000000a1',false);
select review_recovery((select id from promotion_recoveries where status='pending' limit 1), 'approve', 'looks right') is not null as approved;
select type, source, candidate_name, from_round, to_round, previous_date, event_date, handler_name, amount from incentives where source='recovery';
select recompute_incentives('TEAM-PA') as rescan_adds_nothing;
select data_health('TEAM-PA','2026-01-01');
reset role;
select "callId", assignee, "initialAssignee", status, support from coverage_assignments where "dateKey" = '2026-08-03';
