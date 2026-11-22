import { useState } from "react";
import { supabase, q, rpc } from "../lib/supabase";
import { useSession } from "../lib/session";
import { addDays, todayWorkDate, prettyDate } from "../lib/format";
import { Card, PageHeader, Select, Loading, ErrorBox, Table, Td, Badge, Empty, useAsync } from "../components/ui";

interface HealthState {
  unparsed: number; closed_day_unassigned: number; closed_day_open: number; duplicate_lines: number;
  unmapped_candidates: number; unmapped_clients: number; stale_requests: number; pending_recoveries: number; open_days: string[];
}

/** Data integrity checks (legacy "dataintegrity" page) */
export function Health() {
  const s = useSession();
  const [days, setDays] = useState(60);
  const since = addDays(todayWorkDate(), -days);
  const h = useAsync(() => rpc<HealthState>("data_health", { p_team: s.teamId, p_since: since }), [s.teamId, since]);
  const unparsed = useAsync(async () => (await q(supabase.from("interviews").select("id,work_date,raw_text,parse_note")
    .eq("team_id", s.teamId!).eq("parse_ok", false).gte("work_date", since).order("work_date", { ascending: false }).limit(100))) as
    { id: string; work_date: string; raw_text: string; parse_note: string | null }[], [s.teamId, since]);

  const checks: { key: keyof HealthState; label: string; hint: string; link?: string }[] = [
    { key: "unparsed", label: "Lines that could not be parsed", hint: "No candidate, client or round — they can't earn incentives until fixed and re-pasted.", link: "#/intake" },
    { key: "closed_day_unassigned", label: "Calls left unassigned on closed days", hint: "Nobody was credited for these calls.", link: "#/schedule" },
    { key: "closed_day_open", label: "Calls with no outcome on closed days", hint: "Still 'scheduled' although the day is closed.", link: "#/schedule" },
    { key: "stale_requests", label: "Requests waiting more than 3 days", hint: "Outcome or transfer requests nobody reviewed.", link: "#/approvals" },
    { key: "pending_recoveries", label: "Recovered promotions awaiting review", hint: "Possible missed incentives.", link: "#/recovery" },
    { key: "unmapped_candidates", label: "Candidate names not linked to the master", hint: "Can hide promotions across rounds.", link: "#/identity" },
    { key: "unmapped_clients", label: "Client names not linked to the master", hint: "Can hide promotions across rounds.", link: "#/identity" },
    { key: "duplicate_lines", label: "Identical lines pasted twice on the same day", hint: "Usually fine (two calls), sometimes a double paste." },
  ];

  return (
    <>
      <PageHeader title="Data Health" subtitle="Things that can cost someone an incentive if left alone."
        actions={<Select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[14, 30, 60, 180, 365].map((d) => <option key={d} value={d}>Last {d} days</option>)}</Select>} />
      {h.loading ? <Loading /> : h.error ? <ErrorBox error={h.error} /> : h.data && (
        <div className="mb-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
          {checks.map((c) => {
            const n = Number(h.data![c.key]);
            const Wrap = c.link ? "a" : "div";
            return (
              <Wrap key={c.key} href={c.link} className={"block rounded-lg bg-white p-4 ring-1 shadow-sm " + (n ? "ring-amber-300" : "ring-slate-200") + (c.link ? " hover:bg-slate-50" : "")}>
                <div className={"text-2xl font-semibold tabular " + (n ? "text-amber-700" : "text-emerald-700")}>{n ? n : "✓"}</div>
                <div className="mt-1 text-sm font-medium text-slate-800">{c.label}</div>
                <div className="text-xs text-slate-500">{c.hint}</div>
              </Wrap>
            );
          })}
        </div>
      )}
      {h.data && h.data.open_days.length > 0 && (
        <Card title="Past days still open" className="mb-4">
          <div className="flex flex-wrap gap-2">{h.data.open_days.map((d) => <a key={d} href="#/intake" className="text-sm"><Badge v="open">{prettyDate(d)}</Badge></a>)}</div>
        </Card>
      )}
      <Card title="Unparsed lines" pad={false}>
        {unparsed.loading ? <Loading /> : !unparsed.data?.length ? <Empty>None in this period.</Empty> : (
          <Table head={["Date", "Line", "Problem"]} dense>
            {unparsed.data.map((u) => (
              <tr key={u.id}><Td className="whitespace-nowrap">{prettyDate(u.work_date)}</Td><Td className="font-mono text-xs">{u.raw_text}</Td><Td className="text-xs text-rose-600">{u.parse_note}</Td></tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
