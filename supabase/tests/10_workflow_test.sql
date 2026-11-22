-- End-to-end workflow + RLS test (local Postgres with 00_local_auth_stub.sql).
-- Runs as the "authenticated" role and switches identity via test.uid/test.email.
\set ON_ERROR_STOP 1
-- Supabase grants these by default; mimic locally
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage on all sequences in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke execute on function link_auth_user(uuid,text) from authenticated;
revoke execute on function write_audit(text,text,text,text,text,text,jsonb) from authenticated;

-- ---- seed (as postgres)
insert into teams(id,name) values ('TEAM-PA','Pradeep Anna Team'),('TEAM-HYD','Hyderabad Team');
insert into handlers(id,name,team_id) values ('HAN-000001','Dhruva','TEAM-PA'),('HAN-000003','Avinash','TEAM-PA'),('HAN-000002','Anji','TEAM-HYD');
insert into app_users(id,email,official_name,primary_team_id) values
 ('00000000-0000-0000-0000-0000000000a1','admin@x.com','Admin PA','TEAM-PA'),
 ('00000000-0000-0000-0000-0000000000b1','dhruva@x.com','Dhruva','TEAM-PA'),
 ('00000000-0000-0000-0000-0000000000c1','anji@x.com','Anji','TEAM-HYD');
insert into user_roles(user_id,role,team_id,handler_id) values
 ('00000000-0000-0000-0000-0000000000a1','ADMIN','TEAM-PA',null),
 ('00000000-0000-0000-0000-0000000000b1','HANDLER','TEAM-PA','HAN-000001'),
 ('00000000-0000-0000-0000-0000000000c1','HANDLER','TEAM-HYD','HAN-000002');
insert into candidates(id,canonical_name) values ('CAN-000001','Meghana B');
insert into clients(id,canonical_name) values ('CLI-000001','Expana');
-- auth users -> linked by trigger
insert into auth.users(id,email) values
 ('11111111-0000-0000-0000-0000000000a1','ADMIN@x.com'),
 ('11111111-0000-0000-0000-0000000000b1','dhruva@x.com'),
 ('11111111-0000-0000-0000-0000000000c1','anji@x.com');
select count(*) = 3 as all_linked from app_users where auth_user_id is not null \gset
\if :all_linked \else \echo 'FAIL link' \quit \endif

set role authenticated;

-- ---- admin ingests a day
select set_config('test.uid','11111111-0000-0000-0000-0000000000a1',false), set_config('test.email','admin@x.com',false);
select ingest_day('TEAM-PA','2026-07-01', '[
 {"raw_text":"Meghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (1st Round)","candidate_name":"Meghana B","client_name":"Expana","round_label":"1st Round","round_no":1,"time_label":"1:30 PM","start_min":810,"duration_min":30},
 {"raw_text":"Meghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (1st Round)","candidate_name":"Meghana B","client_name":"Expana","round_label":"1st Round","round_no":1,"time_label":"1:30 PM","start_min":810,"duration_min":30},
 {"raw_text":"Ravi K – Interview – Zego – 6:30 PM IST – Duration: 30 Mins (1st Round)","candidate_name":"Ravi K","client_name":"Zego","round_label":"1st Round","round_no":1,"time_label":"6:30 PM","start_min":1110,"duration_min":30}
]'::jsonb);
-- re-paste is idempotent (2 identical lines keep occurrence 1 and 2)
select ingest_day('TEAM-PA','2026-07-01', '[
 {"raw_text":"Meghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (1st Round)","candidate_name":"Meghana B","client_name":"Expana","round_no":1},
 {"raw_text":"Meghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (1st Round)","candidate_name":"Meghana B","client_name":"Expana","round_no":1}
]'::jsonb, true) as repaste;
select count(*) as pa_rows, string_agg(call_code, ', ' order by occurrence) from interviews where team_id='TEAM-PA';

-- later higher round (evidence)
select ingest_day('TEAM-PA','2026-07-06', '[
 {"raw_text":"Meghana B (UK) – Interview – Expana – 4:00 PM IST – Duration: 30 Mins (2nd Round)","candidate_name":"Meghana B","client_name":"Expana","round_label":"2nd Round","round_no":2,"start_min":960}
]'::jsonb);

-- assign
select set_assignments('TEAM-PA', (select jsonb_agg(jsonb_build_object('interview_id',id,'handler_id','HAN-000001','mode','auto'))
                                   from interviews where work_date='2026-07-01')) as assigned;

-- ---- handler (Dhruva) submits outcome
select set_config('test.uid','11111111-0000-0000-0000-0000000000b1',false), set_config('test.email','dhruva@x.com',false);
select submit_outcome((select id from interviews where work_date='2026-07-01' and occurrence=1 and candidate_name='Meghana B'), 'completed') is not null as submitted;
select submit_outcome((select id from interviews where work_date='2026-07-01' and occurrence=2), 'rescheduled') is not null as submitted2;
-- handler cannot write interviews directly (RLS: update affects 0 rows)
update interviews set outcome='completed' where work_date='2026-07-01';
select count(*) filter (where outcome <> 'scheduled') = 0 as rls_blocks_direct_write from interviews;
-- handler sees no incentives yet and cannot see HYD rows
select count(*) as visible_hyd from interviews where team_id='TEAM-HYD';

-- ---- HYD handler cannot touch PA calls
select set_config('test.uid','11111111-0000-0000-0000-0000000000c1',false), set_config('test.email','anji@x.com',false);
select count(*) as anji_sees_pa from interviews where team_id='TEAM-PA';
do $$ begin
  perform submit_outcome((select id from interviews limit 1), 'completed');
  raise exception 'should have failed';
exception when others then
  if sqlerrm not in ('CALL_NOT_FOUND','CALL_ACCESS_DENIED') then raise; end if;
end $$;

-- ---- admin approves the batch, completes the day, incentives computed
select set_config('test.uid','11111111-0000-0000-0000-0000000000a1',false), set_config('test.email','admin@x.com',false);
select review_outcome_requests((select array_agg(id) from outcome_requests where status='pending'), true) as approved;
select work_day_state('TEAM-PA','2026-07-01');
select complete_work_day('TEAM-PA','2026-07-01') as day_complete;
select type, candidate_name, client_name, from_round, to_round, previous_date, event_date, handler_name, amount
  from incentives order by type;
-- running again adds nothing (permanent ledger)
select recompute_incentives('TEAM-PA') as second_run;

-- selection request flow
select set_config('test.uid','11111111-0000-0000-0000-0000000000b1',false), set_config('test.email','dhruva@x.com',false);
select request_selection((select id from interviews where work_date='2026-07-01' and occurrence=1 and candidate_name='Meghana B'), 'selected', '2026-07-20') is not null as sel_req;
select set_config('test.uid','11111111-0000-0000-0000-0000000000a1',false), set_config('test.email','admin@x.com',false);
select review_selection((select id from selection_requests limit 1), true);
select recompute_incentives('TEAM-PA') as after_selection;
select * from monthly_incentive_summary;

-- handler sees own incentives only
select set_config('test.uid','11111111-0000-0000-0000-0000000000c1',false), set_config('test.email','anji@x.com',false);
select count(*) as anji_incentives from incentives;
select set_config('test.uid','11111111-0000-0000-0000-0000000000b1',false), set_config('test.email','dhruva@x.com',false);
select count(*) as dhruva_incentives from incentives;
select my_context();
reset role;
select action, team_id, target_id, new_value from audit_log order by id;
