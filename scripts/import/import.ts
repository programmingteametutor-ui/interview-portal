// ---------------------------------------------------------------------------
// Google Sheets -> Supabase migration
//
// Reads CSV exports of the legacy workbooks (see ExportForSupabase.gs, which
// writes them as "<Workbook> - <Tab>.csv") and writes ONE transactional SQL file
// that you run against the Supabase database with psql.
//
//   npx tsx scripts/import/import.ts --dir ./exports --out ./seed.sql
//   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f seed.sql
//
// Also accepts "## Sheet name: X" text dumps: --dump "Incentive tracker=path/to/file"
// Safe to re-run: every insert is ON CONFLICT DO NOTHING / idempotent updates.
// ---------------------------------------------------------------------------
import fs from "node:fs";
import path from "node:path";
import { parseInterview, callNormalize, extractRound, normKey } from "../../shared/parser";

type Rows = string[][];

// ---- workbook layout (titles as they are today) --------------------------------
const WB = {
  control: "Interview Portal Control",
  backendPA: "Incentive Backend - Private",
  backendHYD: "HYD Incentive Backend - Private",
  opsPA: "Incentive tracker",
  opsHYD: "HYD Incentive Tracker",
  callTracker: "Call Tracker",
};
const TEAMS: Record<string, { raw: [string, string]; team: [string, string]; status: [string, string]; backend: string; reqPrefix: string }> = {
  "TEAM-PA": { raw: [WB.opsPA, "Raw Data"], team: [WB.opsPA, "Team Data"], status: [WB.callTracker, "Portal Call Status"], backend: WB.backendPA, reqPrefix: "" },
  "TEAM-HYD": { raw: [WB.opsHYD, "HYD Raw Data"], team: [WB.opsHYD, "HYD Team Data"], status: [WB.opsHYD, "Portal Call Status"], backend: WB.backendHYD, reqPrefix: "HYD " },
};
// Scheduler.gs MAIN_HANDLERS / SPECIAL_HANDLER (only used to set flags on import)
const MAIN_POOL: Record<string, string[]> = { "TEAM-PA": ["Dhruva", "Naresh", "Bharat", "Venkatesh", "Avinash", "Karthik", "Gopal"] };
const FALLBACK = ["Pradeep"];

// ---- CLI -----------------------------------------------------------------------
const args = process.argv.slice(2);
const arg = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };
const dir = arg("--dir");
const out = arg("--out") || "seed.sql";
const dumps = args.flatMap((a, i) => (a === "--dump" ? [args[i + 1]] : []));

// ---- CSV ---------------------------------------------------------------------
function parseCsv(text: string): Rows {
  const rows: Rows = []; let row: string[] = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(f); rows.push(row); row = []; f = ""; }
    else f += c;
  }
  if (f !== "" || row.length) { row.push(f); rows.push(row); }
  return rows;
}

const sheets = new Map<string, Rows>();
const key = (wb: string, tab: string) => `${wb.trim().toLowerCase()}|${tab.trim().toLowerCase()}`;
if (dir) {
  for (const f of fs.readdirSync(dir)) {
    if (!f.toLowerCase().endsWith(".csv")) continue;
    const base = f.replace(/\.csv$/i, "");
    // Workbook titles can contain " - " ("Incentive Backend - Private"): match known titles first, longest wins.
    const known = Object.values(WB).sort((a, b) => b.length - a.length).find((w) => base.toLowerCase().startsWith(w.toLowerCase() + " - "));
    const m = known ? [base, base.slice(0, known.length), base.slice(known.length + 3)] : base.match(/^(.*?) - (.*)$/);
    if (!m) { console.warn(`skip ${f}: expected "<Workbook> - <Tab>.csv"`); continue; }
    sheets.set(key(m[1], m[2]), parseCsv(fs.readFileSync(path.join(dir, f), "utf8")));
  }
}
for (const d of dumps) {
  const [wb, file] = d.split("=");
  const parts = fs.readFileSync(file, "utf8").split(/^## Sheet name: (.+)$/m);
  for (let i = 1; i < parts.length; i += 2) sheets.set(key(wb, parts[i]), parseCsv(parts[i + 1].replace(/^\n/, "")));
}
const tab = (wb: string, t: string): Rows => sheets.get(key(wb, t)) || [];
const objects = (wb: string, t: string): Record<string, string>[] => {
  const r = tab(wb, t); if (!r.length) return [];
  const h = r[0].map((x) => x.trim());
  return r.slice(1).filter((x) => x.some((v) => v && v.trim())).map((x) => Object.fromEntries(h.map((k, i) => [k, (x[i] ?? "").trim()])));
};

// ---- SQL helpers ---------------------------------------------------------------
const L = (v: unknown): string => {
  if (v === null || v === undefined || v === "") return "null";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  return "'" + String(v).replace(/'/g, "''") + "'";
};
const sql: string[] = [];
const emit = (s: string) => sql.push(s);
function bulk(table: string, cols: string[], rows: unknown[][], suffix = "") {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    emit(`insert into ${table} (${cols.join(",")}) values\n` + chunk.map((r) => "(" + r.map(L).join(",") + ")").join(",\n") + `\n${suffix};`);
  }
}
const truthy = (v: string) => /^(true|yes|1)$/i.test((v || "").trim());
const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function isoDate(v: string): string | null {
  const s = (v || "").trim(); let m;
  if ((m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/))) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{1,2})-([A-Za-z]{3})[a-z]*-(\d{4})/)) && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${String(MONTHS[m[2].toLowerCase()]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}
function isoTs(v: string): string | null {
  const d = isoDate(v); if (!d) return null;
  const t = (v.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/) || []) as string[];
  return `${d}T${(t[1] || "0").padStart(2, "0")}:${t[2] || "00"}:${t[3] || "00"}+05:30`; // sheets ran in Asia/Kolkata
}
const reqStatus = (v: string) => (/approved/i.test(v) ? "approved" : /reject/i.test(v) ? "rejected" : "pending");
const outcomeOf = (v: string) => (/^complet/i.test(v) ? "completed" : /^resched/i.test(v) ? "rescheduled" : /^cancel/i.test(v) ? "cancelled" : null);
const roundNo = (v: string) => { const r = extractRound(v || ""); return r ? r.roundNo : null; };

const stats: Record<string, number> = {};
const count = (k: string, n = 1) => (stats[k] = (stats[k] || 0) + n);

emit("-- Generated by scripts/import/import.ts on " + new Date().toISOString());
emit("begin;");
emit("set local statement_timeout = 0;");

// ---- 1. Teams ------------------------------------------------------------------
const teams = objects(WB.backendPA, "V2 Team Master");
const teamRows = teams.length ? teams.map((t) => [t["Team ID"], t["Team Name"], t["Support Mode"] || "SETUP_SUPPORT", truthy(t["Active"] || "TRUE"), t["Notes"]])
  : [["TEAM-PA", "Pradeep Anna Team", "SETUP_SUPPORT", true, null], ["TEAM-HYD", "Hyderabad Team", "SELF_SUPPORT", true, null]];
bulk("teams", ["id", "name", "support_mode", "active", "notes"], teamRows, "on conflict (id) do update set name = excluded.name, support_mode = excluded.support_mode, active = excluded.active");
count("teams", teamRows.length);
const teamIds = new Set(teamRows.map((t) => t[0] as string));

// ---- 2. Handlers (dedupe same name within a team; remember id remaps) ----------
const handlerRemap = new Map<string, string>();
const handlerSeen = new Map<string, string>();
const handlerRows: unknown[][] = [];
for (const h of objects(WB.backendPA, "V2 Handler Master")) {
  const id = h["Handler ID"], name = h["Handler Name"], team = h["Team ID"] || "TEAM-PA";
  if (!id || !name) continue;
  const k = `${team}|${name.toLowerCase()}`;
  if (handlerSeen.has(k)) { handlerRemap.set(id, handlerSeen.get(k)!); continue; }
  handlerSeen.set(k, id);
  const aliases = (h["Aliases"] || "").split(/[,;]/).map((a) => a.trim()).filter(Boolean);
  const inMain = MAIN_POOL[team] ? MAIN_POOL[team].some((n) => n.toLowerCase() === name.toLowerCase()) : true;
  const isFallback = FALLBACK.some((n) => n.toLowerCase() === name.toLowerCase());
  handlerRows.push([id, name, team, h["Email"], `{${aliases.map((a) => '"' + a.replace(/"/g, "") + '"').join(",")}}`,
    truthy(h["Active"] || "TRUE"), inMain && !isFallback, isFallback, h["Night Eligible"] ? truthy(h["Night Eligible"]) : true, h["Notes"]]);
}
bulk("handlers", ["id", "name", "team_id", "email", "aliases", "active", "in_auto_pool", "is_fallback", "night_eligible", "notes"], handlerRows, "on conflict (id) do nothing");
emit(`select setval('handler_seq', greatest((select coalesce(max(substring(id from 5)::int),0) from handlers where id ~ '^HAN-\\d+$'), 1));`);
count("handlers", handlerRows.length);
const hid = (id: string) => (id ? handlerRemap.get(id) || id : null);

// ---- 3. Users + roles ----------------------------------------------------------
const users = objects(WB.backendPA, "V2 User Access");
const userRows: unknown[][] = []; const roleRows: unknown[][] = [];
const emailSeen = new Set<string>();
const userByLegacy = new Map<string, string>();
for (const u of users) {
  const email = (u["Email"] || "").toLowerCase(); if (!email || emailSeen.has(email)) continue;
  emailSeen.add(email);
  userByLegacy.set(u["User ID"], email);
  userRows.push([email, u["Official Name"] || email, teamIds.has(u["Primary Team ID"]) ? u["Primary Team ID"] : null, truthy(u["Active"] || "TRUE"), u["Notes"], u["User ID"]]);
}
bulk("app_users", ["email", "official_name", "primary_team_id", "active", "notes", "legacy_user_id"], userRows, "on conflict do nothing");
count("users", userRows.length);

const multi = objects(WB.backendPA, "V2 User Roles").filter((r) => truthy(r["Active"]));
const usersWithMulti = new Set(multi.map((r) => (r["Email"] || "").toLowerCase()));
const pushRole = (email: string, role: string, team: string | null, handler: string | null) => {
  role = role.toUpperCase().replace(/\s+/g, "_");
  if (!["SUPER_ADMIN", "ADMIN", "HANDLER", "SETUP_SUPPORT", "TECH_SUPPORT"].includes(role)) return;
  roleRows.push([email, role, role === "SUPER_ADMIN" ? null : team && teamIds.has(team) ? team : null, role === "HANDLER" ? hid(handler || "") : null]);
};
for (const r of multi) pushRole((r["Email"] || "").toLowerCase(), r["Role"], r["Team ID"], r["Resource ID"]);
for (const u of users) {
  const email = (u["Email"] || "").toLowerCase();
  if (!email || usersWithMulti.has(email)) continue;
  pushRole(email, u["Role"], u["Primary Team ID"], u["Handler ID"]);
  // Admins who also run calls keep their handler identity
  if (u["Role"] !== "HANDLER" && u["Handler ID"] && u["Role"] !== "TECH_SUPPORT") pushRole(email, "HANDLER", u["Primary Team ID"], u["Handler ID"]);
}
if (roleRows.length) {
  emit(`insert into user_roles(user_id, role, team_id, handler_id)
select u.id, v.role::app_role, v.team_id, h.id from (values\n${roleRows.map((r) => "(" + r.map(L).join(",") + ")").join(",\n")}\n) v(email, role, team_id, handler_id)
join app_users u on lower(u.email) = v.email left join handlers h on h.id = v.handler_id
on conflict do nothing;`);
}
count("roles", roleRows.length);

// ---- 4. Identity masters ---------------------------------------------------------
const candRows = objects(WB.control, "Candidate Master").filter((r) => r["Candidate ID"]).map((r) => [r["Candidate ID"], r["Canonical Name"]]);
bulk("candidates", ["id", "canonical_name"], candRows, "on conflict (id) do nothing");
const cliRows = objects(WB.control, "Client Master").filter((r) => r["Client ID"]).map((r) => [r["Client ID"], r["Canonical Client Name"]]);
bulk("clients", ["id", "canonical_name"], cliRows, "on conflict (id) do nothing");
emit(`select setval('candidate_seq', greatest((select coalesce(max(substring(id from 5)::int),0) from candidates where id ~ '^CAN-\\d+$'),1));`);
emit(`select setval('client_seq', greatest((select coalesce(max(substring(id from 5)::int),0) from clients where id ~ '^CLI-\\d+$'),1));`);
const aliasRows = (t: string, idCol: string) => objects(WB.control, t).filter((r) => r["Alias"] && r[idCol] && r["Active"] !== "FALSE").map((r) => [r["Alias"], r[idCol], r["Added By"], isoTs(r["Added At"])]);
const ca = aliasRows("Candidate Name Map", "Candidate ID");
if (ca.length) emit(`insert into candidate_aliases(alias, candidate_id, added_by, added_at) select v.a, v.c, v.b, coalesce(v.t::timestamptz, now()) from (values\n${ca.map((r) => "(" + r.map(L).join(",") + ")").join(",\n")}\n) v(a,c,b,t) where exists (select 1 from candidates where id = v.c) on conflict do nothing;`);
const cl = aliasRows("Client Name Map", "Client ID");
if (cl.length) emit(`insert into client_aliases(alias, client_id, added_by, added_at) select v.a, v.c, v.b, coalesce(v.t::timestamptz, now()) from (values\n${cl.map((r) => "(" + r.map(L).join(",") + ")").join(",\n")}\n) v(a,c,b,t) where exists (select 1 from clients where id = v.c) on conflict do nothing;`);
count("candidates", candRows.length); count("clients", cliRows.length); count("candidate_aliases", ca.length); count("client_aliases", cl.length);

// Legacy "Client Alias" / "Candidate Alias" tabs in the backends (Alias -> Canonical)
for (const b of [WB.backendPA, WB.backendHYD]) {
  for (const [t, kind] of [["Client Alias", "client"], ["Candidate Alias", "candidate"]] as const) {
    const rows = tab(b, t).slice(1).filter((r) => r[0] && r[1] && r[0].trim().toLowerCase() !== r[1].trim().toLowerCase());
    if (!rows.length) continue;
    const master = kind === "client" ? "clients" : "candidates";
    const aliasT = kind === "client" ? "client_aliases" : "candidate_aliases";
    const fk = kind === "client" ? "client_id" : "candidate_id";
    emit(`insert into ${aliasT}(alias, ${fk}, added_by)
select v.a, m.id, 'legacy ${t}' from (values\n${rows.map((r) => `(${L(r[0].trim())},${L(r[1].trim())})`).join(",\n")}\n) v(a, canon)
join lateral (select id from ${master} where name_key = norm_key(v.canon) order by id limit 1) m on true
on conflict do nothing;`);
    count(`${kind}_aliases_legacy`, rows.length);
  }
}

// ---- 5. Incentive rules (Settings) ---------------------------------------------
const settings = tab(WB.backendPA, "Settings");
for (const r of settings.slice(1)) {
  const amt = parseFloat((r[2] || "").replace(/[^\d.]/g, "")); if (!Number.isFinite(amt)) continue;
  if (/^any$/i.test(r[0]) && /select/i.test(r[1])) emit(`update incentive_rules set amount = ${amt} where team_id is null and rule = 'selection';`);
  else if (r[0] === "1") emit(`update incentive_rules set amount = ${amt} where team_id is null and rule = 'first_promotion';`);
  else if (r[0] === "2") emit(`update incentive_rules set amount = ${amt} where team_id is null and rule = 'promotion';`);
}

// ---- 6. Preference list (Call Tracker) -----------------------------------------
const pref = tab(WB.callTracker, "Preference List");
if (pref.length) {
  const prefRows: unknown[][] = [];
  pref[0].forEach((h, col) => {
    const m = (h || "").match(/^(.+?)\s+List$/i); if (!m) return;
    for (const r of pref.slice(1)) if (r[col] && r[col].trim()) prefRows.push(["TEAM-PA", m[1].trim(), r[col].trim()]);
  });
  if (prefRows.length) emit(`insert into handler_preferences(team_id, handler_id, candidate_label)
select v.t, h.id, v.c from (values\n${prefRows.map((r) => "(" + r.map(L).join(",") + ")").join(",\n")}\n) v(t, hname, c)
join lateral (select id from handlers where team_id = v.t and (lower(name) = lower(v.hname) or (lower(v.hname) = 'bharath' and lower(name) = 'bharat')) order by id limit 1) h on true
on conflict do nothing;`);
  count("preferences", prefRows.length);
}

// ---- 7. Interviews: Raw Data (all interviews) ------------------------------------
emit(`create temp table stage_iv (team_id text, work_date date, seq int, raw_text text, occurrence int,
  candidate_name text, client_name text, job_role text, location_tag text, round_label text, round_no int, is_loop boolean,
  time_label text, start_min int, duration_min int, is_night boolean, parse_ok boolean, parse_note text,
  handler_value text, selection_value text, selection_date date, src text) on commit drop;`);
const DATE_HDR = /^\d{1,2}\/\d{1,2}\/\d{4}(\s+\w+)?$/;
// Known clients (master + aliases) let the parser split "Client - Job Role" correctly
const knownClients = new Set<string>([
  ...cliRows.map((r) => normKey(r[1] as string)),
  ...cl.map((r) => normKey(r[0] as string)),
  ...[WB.backendPA, WB.backendHYD].flatMap((b) => tab(b, "Client Alias").slice(1).flatMap((r) => [normKey(r[0]), normKey(r[1])])),
].filter(Boolean));
const parseOpts = { isKnownClient: (n: string) => knownClients.has(normKey(n)) };
const ivCols = ["team_id", "work_date", "seq", "raw_text", "occurrence", "candidate_name", "client_name", "job_role", "location_tag", "round_label", "round_no", "is_loop", "time_label", "start_min", "duration_min", "is_night", "parse_ok", "parse_note", "handler_value", "selection_value", "selection_date", "src"];
function stageLines(team: string, rows: Rows, textCol: number, dateCols: number[], src: string, extra?: (r: string[]) => [string | null, string | null, string | null]) {
  const out: unknown[][] = []; let date: string | null = null; let seq = 0; let occ = new Map<string, number>();
  for (const r of rows) {
    const hdr = dateCols.map((c) => (r[c] || "").trim()).find((v) => DATE_HDR.test(v));
    if (hdr) { date = isoDate(hdr); seq = 0; occ = new Map(); continue; }
    const text = (r[textCol] || "").trim();
    if (!date || !text || /^interview details$/i.test(text)) continue;
    const n = callNormalize(text); const o = (occ.get(n) || 0) + 1; occ.set(n, o);
    const p = parseInterview(text, parseOpts);
    const [hv, sv, sd] = extra ? extra(r) : [null, null, null];
    out.push([team, date, ++seq, text, o, p.candidate_name, p.client_name, p.job_role, p.location_tag, p.round_label, p.round_no, p.is_loop,
      p.time_label, p.start_min, p.duration_min, p.is_night, p.parse_ok, p.parse_note, hv, sv, sd, src]);
    if (!p.parse_ok) count(`${team} unparsed (${src})`);
  }
  bulk("stage_iv", ivCols, out);
  count(`${team} ${src} rows`, out.length);
}
for (const [team, cfg] of Object.entries(TEAMS)) {
  stageLines(team, tab(...cfg.raw), 1, [1, 0], "raw");
  stageLines(team, tab(...cfg.team), 1, [0], "team", (r) => [(r[2] || "").trim() || null, (r[3] || "").trim() || null, isoDate(r[4] || "")]);
}
emit(`-- raw + unmatched team lines become interviews
insert into interviews(team_id, work_date, seq, raw_text, occurrence, call_code, candidate_name, client_name, job_role, location_tag,
  round_label, round_no, is_loop, time_label, start_min, duration_min, is_night, parse_ok, parse_note, source)
select distinct on (team_id, work_date, call_normalize(raw_text), occurrence)
  team_id, work_date, seq, raw_text, occurrence, '', candidate_name, client_name, job_role, location_tag, round_label, round_no,
  coalesce(is_loop,false), time_label, start_min, duration_min, coalesce(is_night,false), parse_ok, parse_note,
  case src when 'raw' then 'import_raw' else 'import_team' end
from stage_iv where team_id in (select id from teams)
order by team_id, work_date, call_normalize(raw_text), occurrence, (src = 'raw') desc
on conflict (team_id, work_date, normalized_text, occurrence) do nothing;`);

// Team Data: handler / outcome / selection (Team Data is the approved truth)
emit(`with t as (
  select s.*, h.id as handler_id from stage_iv s
  left join lateral (
    select id from handlers h
    where lower(h.name) = lower(trim(s.handler_value)) or lower(trim(s.handler_value)) = any(select lower(a) from unnest(h.aliases) a)
    order by (h.team_id = s.team_id) desc, h.id limit 1) h on true
  where s.src = 'team')
update interviews i set
  handler_id = coalesce(t.handler_id, i.handler_id),
  assignment_mode = case when t.handler_value ~* '^support' then 'support' else 'import' end,
  outcome = case when t.handler_id is not null then 'completed'
                 when t.handler_value ~* '^resched' then 'rescheduled'
                 when t.handler_value ~* '^cancel' then 'cancelled'
                 else i.outcome end::call_outcome,
  outcome_approved_at = case when t.handler_id is not null or t.handler_value ~* '^(resched|cancel)' then t.work_date::timestamptz end,
  selection = case when t.selection_value ~* '^selected' then 'selected' when t.selection_value ~* '^reject' then 'rejected'
                   when t.selection_value ~* 'hold' then 'on_hold' else 'in_progress' end::selection_status,
  selection_date = t.selection_date,
  parse_note = case when t.handler_id is null and t.handler_value is not null and t.handler_value !~* '^(resched|cancel|support)'
                    then concat_ws('; ', i.parse_note, 'Legacy handler value: ' || t.handler_value) else i.parse_note end
from t
where i.team_id = t.team_id and i.work_date = t.work_date and i.normalized_text = call_normalize(t.raw_text) and i.occurrence = t.occurrence;`);

// Portal Call Status (portal era): fills outcome/handler where Team Data had nothing
for (const [team, cfg] of Object.entries(TEAMS)) {
  const st = objects(...cfg.status).filter((r) => r["Call ID"] && outcomeOf(r["Call Status"]));
  if (!st.length) continue;
  emit(`update interviews i set outcome = v.o::call_outcome,
  handler_id = coalesce(i.handler_id, (select id from handlers h where lower(h.name) = lower(v.h) order by (h.team_id = i.team_id) desc limit 1)),
  outcome_approved_at = coalesce(i.outcome_approved_at, v.at::timestamptz)
from (values\n${st.map((r) => `(${L(r["Call ID"])},${L(outcomeOf(r["Call Status"]))},${L(r["Assigned Handler"])},${L(isoTs(r["Updated At"]))})`).join(",\n")}\n) v(code, o, h, at)
where i.team_id = ${L(team)} and i.call_code = v.code and i.outcome = 'scheduled';`);
  count(`${team} call status rows`, st.length);
}

// Identity resolution + closed days
emit(`update interviews set candidate_id = resolve_candidate_id(candidate_name) where candidate_id is null and candidate_name is not null;`);
emit(`update interviews set client_id = resolve_client_id(client_name) where client_id is null and client_name is not null;`);
emit(`insert into work_days(team_id, work_date, status, completed_at)
select team_id, work_date, case when work_date < (select max(work_date) from interviews x where x.team_id = i.team_id) then 'completed' else 'open' end::work_day_status,
       case when work_date < (select max(work_date) from interviews x where x.team_id = i.team_id) then now() end
from (select distinct team_id, work_date from interviews) i on conflict do nothing;`);

// ---- 8. Request history ----------------------------------------------------------
for (const [team, cfg] of Object.entries(TEAMS)) {
  const b = cfg.backend, p = cfg.reqPrefix;
  const out = objects(b, `${p}Call Outcome Requests`).filter((r) => r["Request ID"] && outcomeOf(r["Requested Outcome"]));
  if (out.length) emit(`insert into outcome_requests(legacy_id, interview_id, team_id, kind, previous_outcome, requested_outcome, handler_id, status, submitted_email, submitted_at, reviewed_email, reviewed_at, review_note)
select v.id, i.id, i.team_id, 'outcome', 'scheduled', v.o::call_outcome, (select id from handlers h where lower(h.name)=lower(v.h) order by (h.team_id=i.team_id) desc limit 1),
  v.s::request_status, v.se, coalesce(v.sa::timestamptz, now()), v.re, v.ra::timestamptz, v.n
from (values\n${out.map((r) => "(" + [r["Request ID"], r["Call ID"], outcomeOf(r["Requested Outcome"]), r["Original Handler"], reqStatus(r["Request Status"]), r["Submitted By Email"], isoTs(r["Submitted At"]), r["Reviewed By Email"], isoTs(r["Reviewed At"]), r["Review Note"]].map(L).join(",") + ")").join(",\n")}\n) v(id, code, o, h, s, se, sa, re, ra, n)
join interviews i on i.team_id = ${L(team)} and i.call_code = v.code
where not (v.s = 'pending' and exists (select 1 from outcome_requests x where x.interview_id = i.id and x.kind = 'outcome' and x.status = 'pending'))
on conflict (legacy_id) do nothing;`);
  count(`${team} outcome requests`, out.length);

  const corr = objects(b, `${p}Call Outcome Correction Requests`).filter((r) => r["Request ID"] && outcomeOf(r["Requested Outcome"]));
  if (corr.length) emit(`insert into outcome_requests(legacy_id, interview_id, team_id, kind, previous_outcome, requested_outcome, status, submitted_email, submitted_at, reviewed_email, reviewed_at, review_note)
select v.id, i.id, i.team_id, 'correction', v.po::call_outcome, v.o::call_outcome, v.s::request_status, v.se, coalesce(v.sa::timestamptz, now()), v.re, v.ra::timestamptz, v.n
from (values\n${corr.map((r) => "(" + [r["Request ID"], r["Call ID"], outcomeOf(r["Old Outcome"]), outcomeOf(r["Requested Outcome"]), reqStatus(r["Request Status"]), r["Requested By Email"], isoTs(r["Requested At"]), r["Reviewed By Email"], isoTs(r["Reviewed At"]), r["Review Note"]].map(L).join(",") + ")").join(",\n")}\n) v(id, code, po, o, s, se, sa, re, ra, n)
join interviews i on i.team_id = ${L(team)} and i.call_code = v.code on conflict (legacy_id) do nothing;`);

  const re = objects(b, `${p}Call Reassignment Requests`).filter((r) => r["Request ID"] && r["To Handler"]);
  if (re.length) emit(`insert into reassignment_requests(legacy_id, interview_id, team_id, from_handler_id, to_handler_id, status, requested_email, requested_at, reviewed_email, reviewed_at, review_note)
select v.id, i.id, i.team_id,
  (select id from handlers h where lower(h.name)=lower(v.fh) order by (h.team_id=i.team_id) desc limit 1), th.id,
  v.s::request_status, v.se, coalesce(v.sa::timestamptz, now()), v.re, v.ra::timestamptz, v.n
from (values\n${re.map((r) => "(" + [r["Request ID"], r["Call ID"], r["From Handler"], r["To Handler"], reqStatus(r["Request Status"]), r["Requested By Email"], isoTs(r["Requested At"]), r["Reviewed By Email"], isoTs(r["Reviewed At"]), r["Review Note"]].map(L).join(",") + ")").join(",\n")}\n) v(id, code, fh, thn, s, se, sa, re, ra, n)
join interviews i on i.team_id = ${L(team)} and i.call_code = v.code
join lateral (select id from handlers h where lower(h.name)=lower(v.thn) order by (h.team_id=i.team_id) desc limit 1) th on true
where not (v.s = 'pending' and exists (select 1 from reassignment_requests x where x.interview_id = i.id and x.status = 'pending'))
on conflict (legacy_id) do nothing;`);
  count(`${team} reassignment requests`, re.length);
}

// ---- 8b. Selection requests (matched on interview date + original text)
for (const [team, cfg] of Object.entries(TEAMS)) {
  const sel = objects(cfg.backend, `${cfg.reqPrefix}Selection Requests`).filter((r) => r["Request ID"] && r["Original Interview Text"] && isoDate(r["Interview Date"]));
  const selVal = (v: string) => (/select/i.test(v) ? "selected" : /reject/i.test(v) ? "rejected" : /hold/i.test(v) ? "on_hold" : "in_progress");
  if (sel.length) emit(`insert into selection_requests(legacy_id, interview_id, team_id, current_selection, requested_selection, selection_date, status, requested_email, requested_at, reviewed_email, reviewed_at, review_note)
select v.id, i.id, i.team_id, v.cur::selection_status, v.req::selection_status, v.sd::date, v.s::request_status, v.re, coalesce(v.ra::timestamptz, now()), v.rv, v.rva::timestamptz, v.n
from (values\n${sel.map((r) => "(" + [r["Request ID"], isoDate(r["Interview Date"]), r["Original Interview Text"], selVal(r["Current Status"]), selVal(r["Requested Status"]),
    isoDate(r["Interview Date"]), reqStatus(r["Request Status"]), r["Requested By Email"], isoTs(r["Requested At"]), r["Reviewed By Email"], isoTs(r["Reviewed At"]), r["Review Note"]].map(L).join(",") + ")").join(",\n")}\n) v(id, d, txt, cur, req, sd, s, re, ra, rv, rva, n)
join interviews i on i.team_id = ${L(team)} and i.work_date = v.d::date and i.normalized_text = call_normalize(v.txt) and i.occurrence = 1
where not (v.s = 'pending' and exists (select 1 from selection_requests x where x.interview_id = i.id and x.status = 'pending'))
on conflict (legacy_id) do nothing;`);
  count(`${team} selection requests`, sel.length);
}

// ---- 9. Incentive ledger (permanent history, kept exactly as recorded) ----------
for (const [team, cfg] of Object.entries(TEAMS)) {
  const inc = objects(cfg.backend, "Incentive Tracker").filter((r) => r["Incentive Type"] && r["Candidate"]);
  if (!inc.length) continue;
  const st = (v: string) => (/paid/i.test(v) ? "paid" : /approved/i.test(v) ? "approved" : /reject/i.test(v) ? "rejected" : "pending");
  emit(`insert into incentives(natural_key, team_id, type, candidate_name, client_name, from_round, to_round, previous_date, event_date,
  handler_id, handler_name, amount, status, source)
select incentive_natural_key(v.t::incentive_type, candidate_key(resolve_candidate_id(v.c), v.c), client_key(resolve_client_id(v.cl), v.cl),
         v.fno, v.pd::date, h.id) || case when v.t = 'promotion' and h.id is null then '|' || lower(v.h) else '' end,
       ${L(team)}, v.t::incentive_type, v.c, v.cl, v.fr, v.tr, v.pd::date, v.ed::date, h.id, v.h, v.amt, v.st::incentive_status, 'import'
from (values\n${inc.map((r) => "(" + [/select/i.test(r["Incentive Type"]) ? "selection" : "promotion", r["Candidate"], r["Client"], r["From"], r["To"], roundNo(r["From"]),
    isoDate(r["Previous Date"]), isoDate(r["Promotion Date"]) || isoDate(r["Previous Date"]), r["Handler"], parseFloat((r["Amount"] || "0").replace(/[^\d.]/g, "")) || 0, st(r["Status"])].map(L).join(",") + ")").join(",\n")}\n) v(t, c, cl, fr, tr, fno, pd, ed, h, amt, st)
left join lateral (select id from handlers x where lower(x.name) = lower(v.h) order by (x.team_id = ${L(team)}) desc, x.id limit 1) h on true
where v.ed is not null
on conflict (natural_key) do nothing;`);
  count(`${team} incentive rows`, inc.length);
}

// ---- 9b. Legacy recovery decisions (non-pending rows of Promotion Recovery / Recovery Exceptions)
for (const [team, cfg] of Object.entries(TEAMS)) {
  const rows: unknown[][] = [];
  for (const r of objects(cfg.backend, "Promotion Recovery")) {
    if (!r["Candidate"] || /^pending$/i.test(r["Status"] || "Pending")) continue;
    rows.push([team, r["Candidate"], isoDate(r["Team Date"]), roundNo(r["Previous Round"]), r["Status"], "Promotion Recovery"]);
  }
  for (const r of objects(cfg.backend, "Recovery Exceptions")) {
    if (!r["Possible Team Candidate"] || /^(review|pending)?$/i.test(r["Status"] || "")) continue;
    rows.push([team, r["Possible Team Candidate"], isoDate(r["Team Date"]), roundNo(r["Team Round"]), r["Status"], "Recovery Exceptions"]);
  }
  const ok = rows.filter((r) => r[2] && r[3]);
  if (ok.length) emit(`insert into legacy_recovery_decisions(team_id, candidate_key, team_date, from_round_no, status, source_sheet)
select v.t, norm_key(v.c), v.d::date, v.n, v.s, v.src from (values\n${ok.map((r) => "(" + r.map(L).join(",") + ")").join(",\n")}\n) v(t, c, d, n, s, src);`);
  count(`${team} legacy recovery decisions`, ok.length);
}

// ---- 10. Audit history (optional, last 5,000 rows per backend) -------------------
for (const [team, cfg] of Object.entries(TEAMS)) {
  const log = objects(cfg.backend, `${cfg.reqPrefix}Portal Action Log`).slice(-5000);
  if (!log.length) continue;
  bulk("audit_log", ["at", "actor_email", "team_id", "action", "target_type", "target_id", "old_value", "new_value", "details"],
    log.map((r) => [isoTs(r["Timestamp"]) || new Date().toISOString(), r["Actor Email"], team, r["Action"] || "LEGACY", r["Target Type"], r["Target ID"], r["Old Value"], r["New Value"],
      JSON.stringify({ legacy: true, role: r["Role"], handler: r["Handler"], details: r["Details"] })]));
  count(`${team} audit rows`, log.length);
}

emit("commit;");
emit(`-- After import: select team_id, count(*), count(*) filter (where not parse_ok) from interviews group by 1;`);
fs.writeFileSync(out, sql.join("\n\n") + "\n");
console.log(`wrote ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
console.table(stats);
const missing = Object.values(TEAMS).flatMap((c) => [c.raw, c.team]).filter(([w, t]) => !sheets.has(key(w, t)));
if (missing.length) console.warn("Not found (skipped):", missing.map(([w, t]) => `${w} - ${t}`).join(", "));
