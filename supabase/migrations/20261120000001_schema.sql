-- =====================================================================
-- Interview & Incentive Portal — core schema
-- Replaces: Call Tracker, Incentive tracker, Incentive Backend - Private,
--           HYD Incentive Tracker, HYD Incentive Backend - Private,
--           Interview Portal Control (Google Sheets + Apps Script)
-- All teams live in one schema; every operational row carries team_id.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------
create type app_role as enum ('SUPER_ADMIN','ADMIN','HANDLER','SETUP_SUPPORT','TECH_SUPPORT');
create type call_outcome as enum ('scheduled','completed','rescheduled','cancelled');
create type request_status as enum ('pending','approved','rejected');
create type selection_status as enum ('in_progress','selected','rejected','on_hold');
create type incentive_type as enum ('promotion','selection');
create type incentive_status as enum ('pending','approved','paid','rejected');
create type outcome_request_kind as enum ('outcome','correction');
create type work_day_status as enum ('open','completed');

-- ---------------------------------------------------------------------
-- Text helpers (same normalisation as Normalizer.gs normalizeText)
-- ---------------------------------------------------------------------
create or replace function norm_key(t text) returns text
language sql immutable parallel safe as $$
  select nullif(trim(regexp_replace(
           regexp_replace(
             regexp_replace(lower(coalesce(t,'')), '''', '', 'g'),
           '[().,–—-]', ' ', 'g'),
         '\s+', ' ', 'g')), '')
$$;

-- ---------------------------------------------------------------------
-- Organisation
-- ---------------------------------------------------------------------
create table teams (
  id            text primary key,                 -- e.g. TEAM-PA, TEAM-HYD
  name          text not null,
  support_mode  text not null default 'SETUP_SUPPORT', -- SETUP_SUPPORT | SELF_SUPPORT
  require_identity boolean not null default true,     -- handlers must map candidate+client before submitting (PIM_assertCallIdentityResolved_)
  active        boolean not null default true,
  notes         text,
  created_at    timestamptz not null default now()
);

create sequence handler_seq start 1;
create table handlers (
  id             text primary key default ('HAN-' || lpad(nextval('handler_seq')::text, 6, '0')),
  name           text not null,
  team_id        text not null references teams(id),
  email          text,
  aliases        text[] not null default '{}',
  active         boolean not null default true,
  -- scheduler flags (Scheduler.gs MAIN_HANDLERS / SPECIAL_HANDLER)
  in_auto_pool   boolean not null default true,   -- one of the "main" handlers
  is_fallback    boolean not null default false,  -- used only when every main handler is busy (e.g. Pradeep)
  night_eligible boolean not null default true,
  sort_order     int not null default 100,
  notes          text,
  created_at     timestamptz not null default now()
);
create index handlers_team_idx on handlers(team_id);
create unique index handlers_team_name_uq on handlers(team_id, lower(name));

-- Portal users (one row per login email). auth_user_id is linked on first login.
create table app_users (
  id              uuid primary key default gen_random_uuid(),
  auth_user_id    uuid unique,
  email           text not null,
  official_name   text not null,
  primary_team_id text references teams(id),
  active          boolean not null default true,
  notes           text,
  legacy_user_id  text,                            -- USR-xxxx from V2 User Access
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create unique index app_users_email_uq on app_users(lower(email));

-- Multi-role assignments (V2 User Roles)
create table user_roles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references app_users(id) on delete cascade,
  role        app_role not null,
  team_id     text references teams(id),           -- null = all teams (SUPER_ADMIN)
  handler_id  text references handlers(id),        -- set for HANDLER role
  active      boolean not null default true,
  created_at  timestamptz not null default now()
);
create unique index user_roles_uq on user_roles(user_id, role, coalesce(team_id,''), coalesce(handler_id,''));

-- ---------------------------------------------------------------------
-- Identity masters (Interview Portal Control)
-- ---------------------------------------------------------------------
create sequence candidate_seq start 1;
create table candidates (
  id              text primary key default ('CAN-' || lpad(nextval('candidate_seq')::text, 6, '0')),
  canonical_name  text not null,
  name_key        text generated always as (norm_key(canonical_name)) stored,
  created_at      timestamptz not null default now()
);
create index candidates_key_idx on candidates(name_key);

create table candidate_aliases (
  id            uuid primary key default gen_random_uuid(),
  alias         text not null,
  alias_key     text generated always as (norm_key(alias)) stored,
  candidate_id  text not null references candidates(id) on delete cascade,
  active        boolean not null default true,
  added_by      text,
  added_at      timestamptz not null default now()
);
create unique index candidate_aliases_key_uq on candidate_aliases(alias_key) where active;

create sequence client_seq start 1;
create table clients (
  id              text primary key default ('CLI-' || lpad(nextval('client_seq')::text, 6, '0')),
  canonical_name  text not null,
  name_key        text generated always as (norm_key(canonical_name)) stored,
  created_at      timestamptz not null default now()
);
create index clients_key_idx on clients(name_key);

create table client_aliases (
  id          uuid primary key default gen_random_uuid(),
  alias       text not null,
  alias_key   text generated always as (norm_key(alias)) stored,
  client_id   text not null references clients(id) on delete cascade,
  active      boolean not null default true,
  added_by    text,
  added_at    timestamptz not null default now()
);
create unique index client_aliases_key_uq on client_aliases(alias_key) where active;

-- Candidate → preferred handler (Call Tracker "Preference List")
create table handler_preferences (
  id              uuid primary key default gen_random_uuid(),
  team_id         text not null references teams(id),
  handler_id      text not null references handlers(id) on delete cascade,
  candidate_label text not null,
  candidate_key   text generated always as (norm_key(candidate_label)) stored,
  candidate_id    text references candidates(id),
  created_at      timestamptz not null default now()
);
create unique index handler_preferences_uq on handler_preferences(team_id, candidate_key);

-- ---------------------------------------------------------------------
-- Operations
-- ---------------------------------------------------------------------
create table work_days (
  team_id       text not null references teams(id),
  work_date     date not null,
  status        work_day_status not null default 'open',
  completed_at  timestamptz,
  completed_by  uuid references app_users(id),
  created_at    timestamptz not null default now(),
  primary key (team_id, work_date)
);

-- One row per interview line (Raw Data / InterviewBot / Team Data merged).
create table interviews (
  id                uuid primary key default gen_random_uuid(),
  call_code         text not null,                -- CALL-YYYY-MM-DD-<hash12>-<n> (same scheme as the portal)
  team_id           text not null references teams(id),
  work_date         date not null,
  seq               int  not null default 0,      -- order within the day as pasted
  raw_text          text not null,
  normalized_text   text not null,
  occurrence        int  not null default 1,      -- duplicate identical lines on the same day
  -- parsed fields
  candidate_name    text,
  candidate_id      text references candidates(id),
  client_name       text,
  client_id         text references clients(id),
  job_role          text,
  location_tag      text,                         -- UK / Ireland / ...
  round_label       text,
  round_no          int,                          -- 999 = Final
  is_loop           boolean not null default false,
  time_label        text,                         -- "7:30 PM"
  start_min         int,                          -- operational minutes; times before 06:00 roll to next day (>=1440)
  duration_min      int,
  is_night          boolean not null default false,
  parse_ok          boolean not null default true,
  parse_note        text,
  -- assignment
  handler_id        text references handlers(id),
  assignment_mode   text,                         -- auto | preferred | manual | fallback | support | import
  -- outcome (approved/final state)
  outcome           call_outcome not null default 'scheduled',
  outcome_approved_at timestamptz,
  outcome_approved_by uuid references app_users(id),
  -- selection tracking (Team Data "Status" + "Confirm Date of Selection")
  selection         selection_status not null default 'in_progress',
  selection_date    date,
  source            text not null default 'paste', -- paste | import_raw | import_team | import_tracker
  created_by        uuid references app_users(id),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
create unique index interviews_day_text_uq on interviews(team_id, work_date, normalized_text, occurrence);
create unique index interviews_call_code_uq on interviews(team_id, call_code);
create index interviews_date_idx on interviews(team_id, work_date);
create index interviews_handler_idx on interviews(handler_id, work_date);
create index interviews_identity_idx on interviews(team_id, candidate_id, client_id);
create index interviews_identity_name_idx on interviews(team_id, norm_key(candidate_name), norm_key(client_name));

-- Handler leave / busy slots (LeaveManager.gs, BusySlots)
create table handler_leaves (
  id          uuid primary key default gen_random_uuid(),
  handler_id  text not null references handlers(id) on delete cascade,
  leave_date  date not null,
  start_min   int,           -- null = whole day
  end_min     int,
  reason      text,
  created_by  uuid references app_users(id),
  created_at  timestamptz not null default now()
);
create index handler_leaves_idx on handler_leaves(leave_date, handler_id);

-- Outcome submissions + corrections (Call Outcome Requests / Correction Requests)
create table outcome_requests (
  id                 uuid primary key default gen_random_uuid(),
  legacy_id          text unique,
  interview_id       uuid not null references interviews(id) on delete cascade,
  team_id            text not null references teams(id),
  kind               outcome_request_kind not null default 'outcome',
  previous_outcome   call_outcome,
  requested_outcome  call_outcome not null check (requested_outcome <> 'scheduled'),
  handler_id         text references handlers(id),  -- call owner at time of submit
  status             request_status not null default 'pending',
  submitted_by       uuid references app_users(id),
  submitted_email    text,
  submitted_at       timestamptz not null default now(),
  reviewed_by        uuid references app_users(id),
  reviewed_email     text,
  reviewed_at        timestamptz,
  review_note        text
);
create unique index outcome_requests_one_pending on outcome_requests(interview_id, kind) where status = 'pending';
create index outcome_requests_team_status on outcome_requests(team_id, status);

create table reassignment_requests (
  id               uuid primary key default gen_random_uuid(),
  legacy_id        text unique,
  interview_id     uuid not null references interviews(id) on delete cascade,
  team_id          text not null references teams(id),
  from_handler_id  text references handlers(id),
  to_handler_id    text not null references handlers(id),
  status           request_status not null default 'pending',
  requested_by     uuid references app_users(id),
  requested_email  text,
  requested_at     timestamptz not null default now(),
  reviewed_by      uuid references app_users(id),
  reviewed_email   text,
  reviewed_at      timestamptz,
  review_note      text
);
create unique index reassignment_one_pending on reassignment_requests(interview_id) where status = 'pending';

create table selection_requests (
  id                 uuid primary key default gen_random_uuid(),
  legacy_id          text unique,
  interview_id       uuid not null references interviews(id) on delete cascade,
  team_id            text not null references teams(id),
  current_selection  selection_status,
  requested_selection selection_status not null,
  selection_date     date,
  status             request_status not null default 'pending',
  requested_by       uuid references app_users(id),
  requested_email    text,
  requested_at       timestamptz not null default now(),
  reviewed_by        uuid references app_users(id),
  reviewed_email     text,
  reviewed_at        timestamptz,
  review_note        text
);
create unique index selection_one_pending on selection_requests(interview_id) where status = 'pending';

-- ---------------------------------------------------------------------
-- Incentives
-- ---------------------------------------------------------------------
-- Settings sheet: 1st round → any higher = 100, 2nd+ → higher = 500, selection = 2000
create table incentive_rules (
  id          uuid primary key default gen_random_uuid(),
  team_id     text references teams(id),   -- null = default for all teams
  rule        text not null check (rule in ('first_promotion','promotion','selection')),
  amount      numeric(12,2) not null check (amount >= 0),
  updated_at  timestamptz not null default now()
);
create unique index incentive_rules_uq on incentive_rules(coalesce(team_id,''), rule);

-- Permanent ledger (Incentive Tracker). Engine only INSERTS; it never rewrites
-- amount/status of an existing row (same guarantee as writeIncentiveTracker).
create table incentives (
  id                     uuid primary key default gen_random_uuid(),
  natural_key            text not null unique,
  team_id                text not null references teams(id),
  type                   incentive_type not null,
  earning_interview_id   uuid references interviews(id) on delete set null,
  evidence_interview_id  uuid references interviews(id) on delete set null,
  candidate_name         text not null,
  client_name            text not null,
  from_round             text,
  to_round               text,
  previous_date          date,
  event_date             date not null,     -- promotion date / selection date (drives month)
  handler_id             text references handlers(id),
  handler_name           text not null,
  amount                 numeric(12,2) not null,
  status                 incentive_status not null default 'pending',
  source                 text not null default 'engine',  -- engine | import
  reviewed_by            uuid references app_users(id),
  reviewed_at            timestamptz,
  paid_at                timestamptz,
  notes                  text,
  created_at             timestamptz not null default now()
);
create index incentives_team_month on incentives(team_id, event_date);
create index incentives_handler on incentives(handler_id, event_date);

-- ---------------------------------------------------------------------
-- Audit (Portal Action Log)
-- ---------------------------------------------------------------------
create table audit_log (
  id           bigserial primary key,
  at           timestamptz not null default now(),
  actor_id     uuid references app_users(id),
  actor_email  text,
  team_id      text,
  action       text not null,
  target_type  text,
  target_id    text,
  old_value    text,
  new_value    text,
  details      jsonb
);
create index audit_log_at on audit_log(at desc);

-- Same as PC_normalizeText_ in PortalCallSchedule.gs
create or replace function call_normalize(t text) returns text
language sql immutable parallel safe as $$
  select lower(trim(regexp_replace(translate(coalesce(t,''), '–—', '--'), '\s+', ' ', 'g')))
$$;

-- CALL-YYYY-MM-DD-<sha256(normalized)[0:12]>-<occurrence>  (identical to legacy portal IDs)
create or replace function call_code_for(d date, normalized text, occ int) returns text
language sql immutable parallel safe as $$
  select 'CALL-' || to_char(d,'YYYY-MM-DD') || '-' ||
         left(encode(sha256(convert_to(normalized,'UTF8')),'hex'),12) || '-' || occ
$$;

create or replace function interviews_fill_keys() returns trigger language plpgsql as $$
begin
  new.normalized_text := call_normalize(new.raw_text);
  if new.call_code is null or new.call_code = '' or
     (tg_op = 'UPDATE' and (new.raw_text is distinct from old.raw_text or new.work_date is distinct from old.work_date
                             or new.occurrence is distinct from old.occurrence)) then
    new.call_code := call_code_for(new.work_date, new.normalized_text, new.occurrence);
  end if;
  return new;
end $$;
create trigger interviews_keys before insert or update on interviews
  for each row execute function interviews_fill_keys();

-- updated_at triggers
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;
create trigger interviews_touch before update on interviews for each row execute function touch_updated_at();
create trigger app_users_touch  before update on app_users  for each row execute function touch_updated_at();
