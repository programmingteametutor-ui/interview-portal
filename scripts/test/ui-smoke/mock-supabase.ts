// In-memory stand-in for @supabase/supabase-js used ONLY by the UI smoke test.
// Supports the subset of the query builder the app uses, backed by fixture.json.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import fixture from "./fixture.json";

type Row = Record<string, any>;
const db: Record<string, Row[]> = fixture as any;
const today = new Date(Date.now() + (5.5 * 60 + new Date().getTimezoneOffset()) * 60000);
if (today.getHours() < 6) today.setDate(today.getDate() - 1);
(window as any).__rpcLog = [];

class Query implements PromiseLike<any> {
  private filters: ((r: Row) => boolean)[] = [];
  private orderBy: [string, boolean][] = [];
  private lim = Infinity; private from = 0; private to = Infinity;
  private head = false; private mode: "select" | "insert" | "update" | "delete" | "upsert" = "select";
  private payload: any; private cols = "*";
  constructor(private table: string) {}
  select(cols = "*", opts?: { count?: string; head?: boolean }) { this.cols = cols; this.head = !!opts?.head; return this; }
  eq(c: string, v: any) { this.filters.push((r) => r[c] === v); return this; }
  neq(c: string, v: any) { this.filters.push((r) => r[c] !== v); return this; }
  in(c: string, v: any[]) { this.filters.push((r) => v.includes(r[c])); return this; }
  gte(c: string, v: any) { this.filters.push((r) => r[c] >= v); return this; }
  gt(c: string, v: any) { this.filters.push((r) => r[c] > v); return this; }
  lt(c: string, v: any) { this.filters.push((r) => r[c] < v); return this; }
  lte(c: string, v: any) { this.filters.push((r) => r[c] <= v); return this; }
  is(c: string, v: any) { this.filters.push((r) => (r[c] ?? null) === v); return this; }
  not(c: string, _op: string, v: any) { this.filters.push((r) => (r[c] ?? null) !== v); return this; }
  ilike(c: string, p: string) { const re = new RegExp("^" + p.replace(/%/g, ".*") + "$", "i"); this.filters.push((r) => re.test(String(r[c] ?? ""))); return this; }
  or() { return this; }
  order(c: string, o?: { ascending?: boolean }) { this.orderBy.push([c, o?.ascending !== false]); return this; }
  limit(n: number) { this.lim = n; return this; }
  range(a: number, b: number) { this.from = a; this.to = b; return this; }
  insert(p: any) { this.mode = "insert"; this.payload = p; return this; }
  upsert(p: any) { this.mode = "upsert"; this.payload = p; return this; }
  update(p: any) { this.mode = "update"; this.payload = p; return this; }
  delete() { this.mode = "delete"; return this; }
  then(res: any, rej?: any) { return Promise.resolve().then(() => this.exec()).then(res, rej); }
  private exec() {
    const t = (db[this.table] ||= []);
    if (this.mode === "insert" || this.mode === "upsert") {
      const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r: Row) => ({ id: crypto.randomUUID(), ...r }));
      t.push(...rows); return { data: rows, error: null };
    }
    let rows = t.filter((r) => this.filters.every((f) => f(r)));
    if (this.mode === "update") { rows.forEach((r) => Object.assign(r, this.payload)); return { data: rows, error: null }; }
    if (this.mode === "delete") { db[this.table] = t.filter((r) => !rows.includes(r)); return { data: rows, error: null }; }
    for (const [c, asc] of [...this.orderBy].reverse()) rows = [...rows].sort((a, b) => ((a[c] ?? "") > (b[c] ?? "") ? 1 : (a[c] ?? "") < (b[c] ?? "") ? -1 : 0) * (asc ? 1 : -1));
    const count = rows.length;
    rows = rows.slice(this.from, Math.min(this.to + 1, this.from + this.lim));
    // column aliases ("name:candidate_name") and the interview embed used by Approvals
    const alias = [...this.cols.matchAll(/(\w+):(\w+)(?!\()/g)];
    const embed = /interview:interviews\(/.test(this.cols);
    // FK-hinted embeds: earning:interviews!promotion_recoveries_earning_interview_id_fkey(...)
    const hinted = [...this.cols.matchAll(/(\w+):interviews!(\w+)_fkey\(/g)].map((m) => [m[1], m[2].replace(this.table + "_", "")]);
    const masters = [...this.cols.matchAll(/(\w+):(candidates|clients)\(/g)].map((m) => [m[1], m[2]]);
    rows = rows.map((r) => {
      const o: Row = { ...r };
      alias.forEach(([, a, c]) => { o[a] = r[c]; });
      if (embed) o.interview = db.interviews.find((i) => i.id === r.interview_id);
      hinted.forEach(([a, col]) => { o[a] = db.interviews.find((i) => i.id === r[col]) ?? null; });
      masters.forEach(([a, t]) => { const id = r[t === "candidates" ? "candidate_id" : "client_id"]; o[a] = id ? db[t].find((m) => m.id === id) ?? null : null; });
      return o;
    });
    return { data: this.head ? null : rows, count, error: null };
  }
}

function rpc(fn: string, args: any) {
  (window as any).__rpcLog.push([fn, args]);
  const ok = (data: any) => Promise.resolve({ data, error: null });
  switch (fn) {
    case "my_context": return ok({
      linked: true, user: { id: "u1", email: "ram.dhruva819@gmail.com", name: "Dhruva", primary_team_id: "TEAM-PA" },
      roles: [{ role: "SUPER_ADMIN", team_id: null, handler_id: null }, { role: "HANDLER", team_id: "TEAM-PA", handler_id: "HAN-000001", handler_name: "Dhruva" }],
      teams: db.teams.map((t) => ({ id: t.id, name: t.name })),
    });
    case "work_day_state": {
      const rows = db.interviews.filter((i) => i.team_id === args.p_team && i.work_date === args.p_date);
      return ok({ status: rows.length ? "open" : "none", total: rows.length, unassigned: rows.filter((r) => !r.handler_id).length,
        scheduled: rows.filter((r) => r.outcome === "scheduled").length,
        pending_outcomes: db.outcome_requests.filter((o) => o.status === "pending" && rows.some((r) => r.id === o.interview_id)).length, pending_reassignments: 0 });
    }
    case "set_assignments":
      args.p_items.forEach((it: any) => { const r = db.interviews.find((i) => i.id === it.interview_id); if (r) { r.handler_id = it.handler_id; r.assignment_mode = it.mode; } });
      return ok(args.p_items.length);
    case "review_outcome_requests":
      db.outcome_requests.filter((o) => args.p_ids.includes(o.id)).forEach((o) => {
        o.status = args.p_approve ? "approved" : "rejected";
        if (args.p_approve) { const i = db.interviews.find((x) => x.id === o.interview_id); if (i) i.outcome = o.requested_outcome; }
      });
      return ok(args.p_ids.length);
    case "preview_context": {
      const u = db.app_users.find((x) => x.id === args.p_user);
      return ok({ linked: true, preview: true, user: { id: u.id, email: u.email, name: u.official_name, primary_team_id: u.primary_team_id },
        roles: db.user_roles.filter((r) => r.user_id === u.id && r.active).map((r) => ({ role: r.role, team_id: r.team_id, handler_id: r.handler_id })),
        teams: db.teams.map((t) => ({ id: t.id, name: t.name })) });
    }
    case "data_health": return ok({ unparsed: 12, closed_day_unassigned: 0, closed_day_open: 3, duplicate_lines: 1, unmapped_candidates: 40, unmapped_clients: 210, stale_requests: 0, pending_recoveries: db.promotion_recoveries.filter((r) => r.status === "pending").length, open_days: [] });
    case "handler_performance": return ok((db as any).handler_performance ?? []);
    case "incentive_scan_status": return ok({ last_scan: { at: new Date().toISOString(), by: "ram.dhruva819@gmail.com", details: { promotions_added: 8, selections_added: 1 } },
      last_recovery_scan: null, last_closed_day: "2026-11-19", pending_recoveries: 0, ledger: { pending: 869, approved: 0, paid: 0, rejected: 0, total_open_amount: 272400 } });
    case "save_recovery_scan": return ok({ rows: args.p_rows.length, new: 0, invalid: 0 });
    case "ingest_day": return ok({ inserted: args.p_rows.length, updated: 0, removed: 0, kept_missing: 0 });
    case "recompute_incentives": return ok({ promotions_added: 0, selections_added: 0 });
    default: return ok(null);
  }
}

export function createClient() {
  const session = { user: { id: "auth-1", email: "ram.dhruva819@gmail.com" }, access_token: "x" };
  return {
    auth: {
      getSession: () => Promise.resolve({ data: { session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
      signOut: () => Promise.resolve({}),
      signInWithOtp: () => Promise.resolve({ error: null }),
      verifyOtp: () => Promise.resolve({ error: null }),
    },
    from: (t: string) => new Query(t),
    rpc,
  };
}
export type Session = any;
