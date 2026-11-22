import { useMemo, useState } from "react";
import { supabase, q, rpc } from "../lib/supabase";
import { useSession } from "../lib/session";
import { todayWorkDate, monthRange, monthLabel, downloadCsv, inr, shortDate } from "../lib/format";
import { Button, Card, PageHeader, Input, Table, Td, Loading, ErrorBox, Empty, Stat, useAsync } from "../components/ui";

interface Daily { work_date: string; handler_id: string | null; handler_name: string | null; is_support: boolean; total_calls: number; completed: number; rescheduled: number; cancelled: number; open_calls: number; night_calls: number; selections: number }
interface Perf { handler_id: string; handler_name: string; total_calls: number; completed: number; rescheduled: number; cancelled: number; night_calls: number; selected_interviews: number; promotions: number; promotion_amount: number; selections: number; selection_amount: number; total_incentive: number }

/** Reports (getPortalReportsData / getPortalCallDashboardData): daily activity, daily team breakdown, handler performance. */
export function Reports() {
  const s = useSession();
  const [ym, setYm] = useState(todayWorkDate().slice(0, 7));
  const mine = s.role === "HANDLER";
  const data = useAsync(async () => {
    const [from, to] = monthRange(ym);
    const [daily, perf] = await Promise.all([
      q(supabase.from("daily_call_stats").select("*").eq("team_id", s.teamId!).gte("work_date", from).lt("work_date", to).order("work_date")),
      rpc<Perf[]>("handler_performance", { p_team: s.teamId, p_month: from }),
    ]);
    const keep = (h: string | null) => !mine || (!!h && s.myHandlerIds.includes(h));
    return { daily: (daily as Daily[]).filter((d) => keep(d.handler_id)), perf: (perf ?? []).filter((p) => keep(p.handler_id)) };
  }, [s.teamId, ym, mine]);

  const days = useMemo(() => {
    const m = new Map<string, { date: string; total: number; completed: number; rescheduled: number; cancelled: number; open: number; night: number; support: number; byHandler: Record<string, number> }>();
    for (const d of data.data?.daily ?? []) {
      const cur = m.get(d.work_date) ?? { date: d.work_date, total: 0, completed: 0, rescheduled: 0, cancelled: 0, open: 0, night: 0, support: 0, byHandler: {} };
      cur.total += +d.total_calls; cur.completed += +d.completed; cur.rescheduled += +d.rescheduled; cur.cancelled += +d.cancelled; cur.open += +d.open_calls; cur.night += +d.night_calls;
      if (d.is_support) cur.support += +d.total_calls;
      const hk = d.handler_name ?? (d.is_support ? "Support" : "Unassigned");
      cur.byHandler[hk] = (cur.byHandler[hk] || 0) + +d.total_calls;
      m.set(d.work_date, cur);
    }
    return [...m.values()];
  }, [data.data]);
  const handlers = useMemo(() => [...new Set(days.flatMap((d) => Object.keys(d.byHandler)))].sort((a, b) =>
    (a === "Unassigned" || a === "Support" ? 1 : 0) - (b === "Unassigned" || b === "Support" ? 1 : 0) || a.localeCompare(b)), [days]);

  const perf = (data.data?.perf ?? []).slice().sort((a, b) => +b.total_incentive - +a.total_incentive || +b.total_calls - +a.total_calls);
  const sum = (k: "total" | "completed" | "rescheduled" | "cancelled" | "support" | "night") => days.reduce((a, d) => a + d[k], 0);
  const incentive = perf.reduce((a, p) => a + +p.total_incentive, 0);
  const max = Math.max(1, ...days.map((d) => d.total));
  const P = mine ? "My " : "";

  return (
    <>
      <PageHeader title={mine ? "My Reports" : "Reports"} subtitle={monthLabel(ym)}
        actions={<>
          <Input type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
          <Button onClick={() => downloadCsv(`handler-performance-${ym}.csv`, [["Handler", "Calls", "Completed", "Rescheduled", "Cancelled", "Night", "Selected", "Promotions", "Promotion ₹", "Selections", "Selection ₹", "Total ₹"],
            ...perf.map((p) => [p.handler_name, p.total_calls, p.completed, p.rescheduled, p.cancelled, p.night_calls, p.selected_interviews, p.promotions, p.promotion_amount, p.selections, p.selection_amount, p.total_incentive])])}>Export CSV</Button>
        </>} />
      {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <Stat label={mine ? "My calls handled" : "Calls assigned"} value={sum("total")} />
            <Stat label="Completed" value={sum("completed")} tone="emerald" />
            <Stat label="Rescheduled" value={sum("rescheduled")} tone="amber" />
            <Stat label="Cancelled" value={sum("cancelled")} tone="rose" />
            {!mine && <Stat label="Support" value={sum("support")} />}
            <Stat label={`${P}Promotions`} value={perf.reduce((a, p) => a + +p.promotions, 0)} />
            <Stat label={`${P}Selections`} value={perf.reduce((a, p) => a + +p.selections, 0)} />
            <Stat label={mine ? "My total incentive" : "Total incentive"} value={inr(incentive)} tone="indigo" />
          </div>

          <Card title={`${P}Daily Call Activity`} className="mb-4">
            {days.length === 0 ? <Empty>No calls this month.</Empty> : (
              <>
                <div className="flex h-44 items-end gap-1">
                  {days.map((d) => (
                    <div key={d.date} className="group relative flex flex-1 flex-col justify-end" style={{ height: "100%" }}>
                      <div className="flex flex-col-reverse overflow-hidden rounded-t" style={{ height: `${(d.total / max) * 100}%` }}>
                        <div className="bg-emerald-500" style={{ flex: d.completed }} />
                        <div className="bg-amber-400" style={{ flex: d.rescheduled }} />
                        <div className="bg-rose-400" style={{ flex: d.cancelled }} />
                        <div className="bg-slate-300" style={{ flex: d.open }} />
                      </div>
                      <div className="pointer-events-none absolute bottom-full left-1/2 z-10 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-2 py-1 text-[11px] text-white group-hover:block">
                        {shortDate(d.date)}: {d.total} calls · {d.completed} done · {d.rescheduled} resch · {d.cancelled} canc · {d.night} night
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-1 flex gap-1 text-[10px] text-slate-400">{days.map((d) => <div key={d.date} className="flex-1 text-center">{d.date.slice(8)}</div>)}</div>
                <p className="mt-2 text-xs text-slate-500">
                  <Dot c="bg-emerald-500" />completed <Dot c="bg-amber-400" />rescheduled <Dot c="bg-rose-400" />cancelled <Dot c="bg-slate-300" />no outcome yet
                </p>
              </>
            )}
          </Card>

          {!mine && days.length > 0 && (
            <Card title="Daily Team Breakdown" pad={false} className="mb-4">
              <Table head={["Date", ...handlers, "Total"]} dense>
                {days.slice().reverse().map((d) => (
                  <tr key={d.date}><Td className="whitespace-nowrap">{shortDate(d.date)}</Td>
                    {handlers.map((h) => <Td key={h} className="tabular">{d.byHandler[h] || <span className="text-slate-300">·</span>}</Td>)}
                    <Td className="tabular font-semibold">{d.total}</Td></tr>
                ))}
              </Table>
            </Card>
          )}
          {mine && days.length > 0 && (
            <Card title="My Daily Breakdown" pad={false} className="mb-4">
              <Table head={["Date", "Calls", "Completed", "Rescheduled", "Cancelled", "Night"]} dense>
                {days.slice().reverse().map((d) => (
                  <tr key={d.date}><Td>{shortDate(d.date)}</Td><Td className="tabular">{d.total}</Td><Td className="tabular">{d.completed}</Td>
                    <Td className="tabular">{d.rescheduled}</Td><Td className="tabular">{d.cancelled}</Td><Td className="tabular">{d.night}</Td></tr>
                ))}
              </Table>
            </Card>
          )}

          <Card title={mine ? "My Monthly Performance" : "Handler Performance"} pad={false}>
            {perf.length === 0 ? <Empty>No activity.</Empty> : (
              <Table head={["Handler", "Calls", "Completed", "Rescheduled", "Cancelled", "Night", "Selected", "Promotions", "Selections", "Incentive", "Completion"]}>
                {perf.map((p) => (
                  <tr key={p.handler_id}>
                    <Td className="font-medium">{p.handler_name}</Td><Td className="tabular">{p.total_calls}</Td><Td className="tabular">{p.completed}</Td>
                    <Td className="tabular">{p.rescheduled}</Td><Td className="tabular">{p.cancelled}</Td><Td className="tabular">{p.night_calls}</Td>
                    <Td className="tabular">{p.selected_interviews}</Td>
                    <Td className="tabular">{p.promotions} <span className="text-xs text-slate-400">{inr(p.promotion_amount)}</span></Td>
                    <Td className="tabular">{p.selections} <span className="text-xs text-slate-400">{inr(p.selection_amount)}</span></Td>
                    <Td className="tabular font-semibold">{inr(p.total_incentive)}</Td>
                    <Td className="tabular">{+p.total_calls ? Math.round((+p.completed / +p.total_calls) * 100) : 0}%</Td>
                  </tr>
                ))}
              </Table>
            )}
          </Card>
        </>
      )}
    </>
  );
}
const Dot = ({ c }: { c: string }) => <span className={`ml-3 mr-1 inline-block h-2 w-2 rounded-sm first:ml-0 ${c}`} />;
