import { supabase, q } from "../lib/supabase";
import { useSession } from "../lib/session";
import { todayWorkDate, prettyDate, inr, monthRange } from "../lib/format";
import { Card, Stat, Table, Td, Badge, Loading, ErrorBox, Empty, PageHeader, useAsync } from "../components/ui";
import type { Interview, MonthlySummary } from "../lib/types";

export function Dashboard() {
  const s = useSession();
  const date = todayWorkDate();
  const ym = date.slice(0, 7);
  const mine = s.role === "HANDLER";

  const { data, loading, error } = useAsync(async () => {
    if (!s.teamId) return null;
    let calls = supabase.from("interviews")
      .select("id,handler_id,outcome,time_label,start_min,candidate_name,client_name,round_label,is_night,assignment_mode")
      .eq("team_id", s.teamId).eq("work_date", date).order("start_min", { nullsFirst: false });
    if (mine) calls = calls.in("handler_id", s.myHandlerIds.length ? s.myHandlerIds : ["-"]);
    const mineIds = s.myHandlerIds.length ? s.myHandlerIds : ["-"];
    let outs = supabase.from("outcome_requests").select("id", { count: "exact", head: true }).eq("team_id", s.teamId).eq("status", "pending");
    if (mine) outs = outs.in("handler_id", mineIds);
    const [today, pendingOut, pendingRe, pendingSel, monthly, day] = await Promise.all([
      q(calls),
      outs,
      supabase.from("reassignment_requests").select("id", { count: "exact", head: true }).eq("team_id", s.teamId).eq("status", "pending"),
      supabase.from("selection_requests").select("id", { count: "exact", head: true }).eq("team_id", s.teamId).eq("status", "pending"),
      q(supabase.from("monthly_incentive_summary").select("*").eq("team_id", s.teamId).eq("month", monthRange(ym)[0])),
      q(supabase.rpc("work_day_state", { p_team: s.teamId, p_date: date })),
    ]);
    return {
      today: today as Interview[],
      pending: (pendingOut.count ?? 0) + (pendingRe.count ?? 0) + (pendingSel.count ?? 0),
      monthly: monthly as MonthlySummary[],
      day: day as { status: string; total: number; unassigned: number; scheduled: number } | null,
    };
  }, [s.teamId, date, mine]);

  if (loading) return <Loading />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Empty>No team selected.</Empty>;

  const myMonth = data.monthly.filter((m) => !mine || s.myHandlerIds.includes(m.handler_id ?? ""));
  const monthTotal = myMonth.reduce((a, m) => a + Number(m.total_amount || 0), 0);
  const done = data.today.filter((c) => c.outcome !== "scheduled").length;

  return (
    <>
      <PageHeader title={`Welcome, ${s.ctx?.user?.name ?? ""}`} subtitle={`Working day ${prettyDate(date)} · ${s.teams.find((t) => t.id === s.teamId)?.name ?? ""}`} />
      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={mine ? "My calls today" : "Calls today"} value={data.today.length} sub={`${done} closed · ${data.today.filter((c) => c.is_night).length} night`} />
        <Stat label="Pending requests" value={data.pending} tone={data.pending ? "amber" : "slate"} sub={mine ? "submitted by you / on your calls" : "outcomes, transfers, selections"} />
        <Stat label={mine ? "My incentives this month" : "Team incentives this month"} value={inr(monthTotal)} tone="indigo" sub={`${myMonth.reduce((a, m) => a + Number(m.promotion_count), 0)} promotions · ${myMonth.reduce((a, m) => a + Number(m.selection_count), 0)} selections`} />
        <Stat label="Day status" value={<span className="capitalize">{data.day?.status === "none" ? "not started" : data.day?.status}</span>}
          sub={data.day ? `${data.day.unassigned} unassigned · ${data.day.scheduled} open` : ""} tone={data.day?.status === "completed" ? "emerald" : "slate"} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title={mine ? "My calls today" : "Today's calls"} className="lg:col-span-2" pad={false}
          actions={<a className="text-xs text-indigo-600 hover:underline" href="#/schedule">Open schedule →</a>}>
          {data.today.length === 0 ? <Empty>No calls for {prettyDate(date)} yet.</Empty> : (
            <Table head={["Time", "Candidate", "Client", "Round", "Handler", "Status"]} dense>
              {data.today.slice(0, 15).map((c) => (
                <tr key={c.id}>
                  <Td className="whitespace-nowrap tabular">{c.time_label ?? "—"} {c.is_night && <Badge v="night">Night</Badge>}</Td>
                  <Td>{c.candidate_name}</Td><Td>{c.client_name}</Td><Td className="whitespace-nowrap">{c.round_label}</Td>
                  <Td>{c.handler_id ? s.handlerName(c.handler_id) : <Badge v="support">{c.assignment_mode === "support" ? "Support" : "Unassigned"}</Badge>}</Td>
                  <Td><Badge v={c.outcome} /></Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card title={`Incentives · ${new Date(date).toLocaleDateString("en-IN", { month: "long" })}`} pad={false}>
          {myMonth.length === 0 ? <Empty>Nothing yet this month.</Empty> : (
            <Table head={["Handler", "Promo", "Selection", "Total"]} dense>
              {myMonth.sort((a, b) => Number(b.total_amount) - Number(a.total_amount)).map((m) => (
                <tr key={m.handler_name}><Td>{m.handler_name}</Td><Td className="tabular">{inr(m.promotion_amount)}</Td>
                  <Td className="tabular">{inr(m.selection_amount)}</Td><Td className="font-medium tabular">{inr(m.total_amount)}</Td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
