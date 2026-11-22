import { useMemo, useState } from "react";
import { supabase, q } from "../lib/supabase";
import { useSession } from "../lib/session";
import { inr, monthLabel, downloadCsv } from "../lib/format";
import { Button, Card, PageHeader, Table, Td, Loading, ErrorBox, Empty, Select, useAsync } from "../components/ui";
import type { MonthlySummary } from "../lib/types";

/** Monthly Incentive Summary (Summary.gs generateSummary) */
export function Monthly() {
  const s = useSession();
  const [months, setMonths] = useState(6);
  const data = useAsync(async () =>
    ((await q(supabase.from("monthly_incentive_summary").select("*").eq("team_id", s.teamId!).order("month", { ascending: false }))) as MonthlySummary[])
      .filter((r) => s.role !== "HANDLER" || s.myHandlerIds.includes(r.handler_id ?? "")),
  [s.teamId]);

  const byMonth = useMemo(() => {
    const m = new Map<string, MonthlySummary[]>();
    (data.data ?? []).forEach((r) => { if (!m.has(r.month)) m.set(r.month, []); m.get(r.month)!.push(r); });
    return [...m.entries()].slice(0, months);
  }, [data.data, months]);

  const handlers = useMemo(() => [...new Set((data.data ?? []).map((r) => r.handler_name))].sort(), [data.data]);

  return (
    <>
      <PageHeader title="Monthly Summary" subtitle="Promotion + selection totals per handler (rejected rows excluded)."
        actions={<>
          <Select value={months} onChange={(e) => setMonths(Number(e.target.value))}>{[3, 6, 12, 24].map((n) => <option key={n} value={n}>Last {n} months</option>)}</Select>
          <Button onClick={() => downloadCsv("monthly-incentive-summary.csv", [["Month", "Handler", "Promotion", "Selection", "Total", "Paid"],
            ...(data.data ?? []).map((r) => [monthLabel(r.month), r.handler_name, r.promotion_amount ?? 0, r.selection_amount ?? 0, r.total_amount, r.paid_amount ?? 0])])}>Export CSV</Button>
        </>} />
      {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : byMonth.length === 0 ? <Card><Empty>No incentives yet.</Empty></Card> : (
        <>
          <Card pad={false} title="Handler × month" className="mb-4">
            <Table head={["Handler", ...byMonth.map(([m]) => monthLabel(m)), "Total"]} dense>
              {handlers.map((h) => {
                const vals = byMonth.map(([, rows]) => Number(rows.find((r) => r.handler_name === h)?.total_amount ?? 0));
                if (!vals.some(Boolean)) return null;
                return (
                  <tr key={h}><Td className="font-medium">{h}</Td>{vals.map((v, i) => <Td key={i} className="tabular">{v ? inr(v) : <span className="text-slate-300">—</span>}</Td>)}
                    <Td className="tabular font-semibold">{inr(vals.reduce((a, b) => a + b, 0))}</Td></tr>
                );
              })}
            </Table>
          </Card>
          <div className="grid gap-4 lg:grid-cols-2">
            {byMonth.map(([m, rows]) => (
              <Card key={m} pad={false} title={monthLabel(m)} actions={<span className="text-sm font-semibold tabular">{inr(rows.reduce((a, r) => a + Number(r.total_amount), 0))}</span>}>
                <Table head={["Handler", "Promotion", "Selection", "Total", "Paid"]} dense>
                  {rows.sort((a, b) => Number(b.total_amount) - Number(a.total_amount)).map((r) => (
                    <tr key={r.handler_name}>
                      <Td>{r.handler_name}</Td>
                      <Td className="tabular">{inr(r.promotion_amount)} <span className="text-xs text-slate-400">({r.promotion_count})</span></Td>
                      <Td className="tabular">{inr(r.selection_amount)} <span className="text-xs text-slate-400">({r.selection_count})</span></Td>
                      <Td className="tabular font-medium">{inr(r.total_amount)}</Td>
                      <Td className="tabular text-indigo-700">{r.paid_amount ? inr(r.paid_amount) : ""}</Td>
                    </tr>
                  ))}
                </Table>
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
