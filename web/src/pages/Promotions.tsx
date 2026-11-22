import { useMemo, useState } from "react";
import { supabase, fetchAll } from "../lib/supabase";
import { useSession } from "../lib/session";
import { inr, shortDate, monthRange, todayWorkDate, monthLabel, downloadCsv } from "../lib/format";
import { Button, Card, PageHeader, Input, Select, Table, Td, Badge, Loading, ErrorBox, Empty, Stat, useAsync } from "../components/ui";
import type { Incentive } from "../lib/types";

/** Promotions page — promotion incentives with movement filters and per-handler breakdown (renderPromotionsPage). */
export function Promotions() {
  const s = useSession();
  const admin = s.isTeamAdmin;
  const [ym, setYm] = useState(todayWorkDate().slice(0, 7));
  const [allTime, setAllTime] = useState(false);
  const [search, setSearch] = useState("");
  const [handler, setHandler] = useState("");
  const [move, setMove] = useState("");
  const [status, setStatus] = useState("");

  const data = useAsync(async () => {
    const [from, to] = monthRange(ym);
    return fetchAll<Incentive>((a, z) => {
      let b = supabase.from("incentives").select("*").eq("team_id", s.teamId!).eq("type", "promotion").order("event_date", { ascending: false });
      if (!allTime) b = b.gte("event_date", from).lt("event_date", to);
      if (s.role === "HANDLER") b = b.in("handler_id", s.myHandlerIds.length ? s.myHandlerIds : ["-"]);
      return b.range(a, z);
    });
  }, [s.teamId, ym, allTime, s.role]);

  const all = data.data ?? [];
  const moves = useMemo(() => [...new Set(all.map((r) => `${r.from_round} → ${r.to_round}`))].sort(), [all]);
  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    return all.filter((r) =>
      (!t || `${r.candidate_name} ${r.client_name}`.toLowerCase().includes(t)) &&
      (!handler || r.handler_id === handler) &&
      (!move || `${r.from_round} → ${r.to_round}` === move) &&
      (!status || r.status === status));
  }, [all, search, handler, move, status]);

  const live = rows.filter((r) => r.status !== "rejected");
  const total = live.reduce((a, r) => a + Number(r.amount), 0);
  const candidates = new Set(live.map((r) => r.candidate_name.trim().toLowerCase())).size;
  const breakdown = useMemo(() => {
    const m = new Map<string, { name: string; count: number; first: number; later: number; amount: number }>();
    for (const r of live) {
      const k = r.handler_name;
      const cur = m.get(k) ?? { name: k, count: 0, first: 0, later: 0, amount: 0 };
      cur.count++; cur.amount += Number(r.amount);
      if (/^1/.test(r.from_round ?? "")) cur.first++; else cur.later++;
      m.set(k, cur);
    }
    return [...m.values()].sort((a, b) => b.amount - a.amount);
  }, [live]);

  return (
    <>
      <PageHeader title="Promotions" subtitle={`Candidates who moved to a higher round after ${admin ? "our team" : "you"} handled them · ${allTime ? "all time" : monthLabel(ym)}`}
        actions={<>
          <label className="flex items-center gap-1.5 text-sm text-slate-600"><input type="checkbox" checked={allTime} onChange={(e) => setAllTime(e.target.checked)} /> All time</label>
          {!allTime && <Input type="month" value={ym} onChange={(e) => setYm(e.target.value)} />}
          <Button onClick={() => downloadCsv(`promotions-${allTime ? "all" : ym}.csv`, [["Candidate", "Client", "From", "To", "Earned on", "Proven on", "Handler", "Amount", "Status", "Source"],
            ...rows.map((r) => [r.candidate_name, r.client_name, r.from_round, r.to_round, r.previous_date, r.event_date, r.handler_name, r.amount, r.status, r.source])])}>Export CSV</Button>
        </>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Promotion amount" value={inr(total)} tone="indigo" sub="excluding rejected" />
        <Stat label="Promotions" value={live.length} sub={`${rows.length - live.length} rejected`} />
        <Stat label="Unique candidates" value={candidates} />
        <Stat label="2nd round onwards" value={live.filter((r) => !/^1/.test(r.from_round ?? "")).length} sub={`${live.filter((r) => /^1/.test(r.from_round ?? "")).length} from 1st round`} />
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card pad={false} title={<span className="text-xs font-normal text-slate-500">{rows.length} records · {inr(total)}</span>}
          actions={<>
            <Input placeholder="Search candidate or client…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-52" />
            {admin && <Select value={handler} onChange={(e) => setHandler(e.target.value)}><option value="">All handlers</option>{s.handlers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</Select>}
            <Select value={move} onChange={(e) => setMove(e.target.value)}><option value="">All round movements</option>{moves.map((m) => <option key={m}>{m}</option>)}</Select>
            <Select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{["pending", "approved", "paid", "rejected"].map((x) => <option key={x} value={x}>{x}</option>)}</Select>
          </>}>
          {data.loading ? <Loading /> : data.error ? <div className="p-4"><ErrorBox error={data.error} /></div> : rows.length === 0 ? <Empty>No promotions match.</Empty> : (
            <Table head={["Candidate", "Client", "Movement", "Earned on", "Proven on", "Handler", "Amount", "Status"]} dense>
              {rows.map((r) => (
                <tr key={r.id} className={r.status === "rejected" ? "opacity-50" : ""}>
                  <Td className="font-medium">{r.candidate_name}</Td><Td>{r.client_name}</Td>
                  <Td className="whitespace-nowrap text-xs">{r.from_round} → {r.to_round}</Td>
                  <Td className="whitespace-nowrap">{shortDate(r.previous_date)}</Td><Td className="whitespace-nowrap">{shortDate(r.event_date)}</Td>
                  <Td>{r.handler_name}</Td><Td className="tabular">{inr(r.amount)}</Td>
                  <Td><Badge v={r.status} />{r.source !== "engine" && <span className="ml-1 text-[10px] text-slate-400">{r.source === "import" ? "legacy" : r.source}</span>}</Td>
                </tr>
              ))}
            </Table>
          )}
        </Card>
        <Card pad={false} title="Breakdown by handler">
          {breakdown.length === 0 ? <Empty>—</Empty> : (
            <Table head={["Handler", "1st→", "2nd+→", "Amount"]} dense>
              {breakdown.map((b) => (
                <tr key={b.name}><Td>{b.name}</Td><Td className="tabular">{b.first}</Td><Td className="tabular">{b.later}</Td><Td className="tabular font-medium">{inr(b.amount)}</Td></tr>
              ))}
            </Table>
          )}
        </Card>
      </div>
    </>
  );
}
