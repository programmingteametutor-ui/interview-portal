// Coverage Desk export — replaces PortalCoverageDeskExport.gs (doPost, target "coverageDesk").
// Same request/response contract, so the Coverage Desk app only changes its URL:
//   POST { secret, resource: "assignments" | "incentives" | "everything", month?: "YYYY-MM", date?: "YYYY-MM-DD" }
//   → { ok: true, data, generatedAt } | { ok: false, error }
// Read-only. Deploy:  supabase functions deploy coverage-desk-export --no-verify-jwt
//                     supabase secrets set COVERAGE_DESK_EXPORT_SECRET=<long random string>
import { createClient } from "jsr:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });

/** constant-time compare */
function same(a: string, b: string) {
  if (!a || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function assignments(month: string, date: string) {
  const out: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    let q = db.from("coverage_assignments").select("*").order("dateKey").order("callId").range(from, from + 999);
    if (date) q = q.eq("dateKey", date); else if (month) q = q.eq("month_key", month);
    const { data, error } = await q;
    if (error) throw error;
    out.push(...data.map(({ month_key: _m, ...r }) => r));
    if (data.length < 1000) break;
  }
  return out;
}

async function incentives(month: string) {
  let q = db.from("incentives").select("team_id,type,amount,handler_name,event_date,teams(name)").neq("status", "rejected");
  if (month) {
    const [y, m] = month.split("-").map(Number);
    const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
    q = q.gte("event_date", `${month}-01`).lt("event_date", next);
  }
  const rows: { team_id: string; type: string; amount: number; handler_name: string; teams: { name: string } | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await q.range(from, from + 999);
    if (error) throw error;
    rows.push(...(data as never[]));
    if (data.length < 1000) break;
  }
  const code = (t: string) => (t === "TEAM-PA" ? "PRADEEP" : t === "TEAM-HYD" ? "HYD" : t.replace("TEAM-", ""));
  const perHandler: Record<string, { team: string; teamCode: string; handler: string; promotion: number; selection: number; total: number; records: number }> = {};
  const byTeam: Record<string, { label: string; total: number; records: number }> = {};
  for (const r of rows) {
    const tc = code(r.team_id), label = r.teams?.name ?? r.team_id, amt = Number(r.amount) || 0;
    byTeam[tc] ??= { label, total: 0, records: 0 };
    byTeam[tc].total += amt; byTeam[tc].records++;
    const k = `${tc}|${r.handler_name.toLowerCase()}`;
    perHandler[k] ??= { team: label, teamCode: tc, handler: r.handler_name, promotion: 0, selection: 0, total: 0, records: 0 };
    const h = perHandler[k];
    if (r.type === "promotion") h.promotion += amt; else h.selection += amt;
    h.total += amt; h.records++;
  }
  const byHandler = Object.values(perHandler).sort((a, b) => b.total - a.total);
  return { month: month || "ALL", byTeam, byHandler, grandTotal: byHandler.reduce((s, r) => s + r.total, 0) };
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return json({ ok: false, error: "NO_POST_HANDLER" }, 405);
  try {
    const body = await req.json().catch(() => ({}));
    if (!same(String(body.secret ?? ""), Deno.env.get("COVERAGE_DESK_EXPORT_SECRET") ?? "")) return json({ ok: false, error: "UNAUTHORIZED" }, 401);
    const date = String(body.date ?? "").trim();
    const month = String(body.month ?? "") || date.slice(0, 7);
    const resource = String(body.resource ?? "");
    let data: unknown;
    if (resource === "assignments") data = await assignments(month, date);
    else if (resource === "incentives") data = await incentives(String(body.month ?? ""));
    else if (resource === "everything") data = { assignments: await assignments(month, date), incentives: await incentives(String(body.month ?? "")) };
    else return json({ ok: false, error: "UNKNOWN_RESOURCE" }, 400);
    return json({ ok: true, data, generatedAt: new Date().toISOString() });
  } catch (e) {
    return json({ ok: false, error: String((e as Error)?.message ?? e) }, 500);
  }
});
