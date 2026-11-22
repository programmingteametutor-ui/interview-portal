import { useMemo, useState } from "react";
import { supabase, q, rpc, fetchAll } from "../lib/supabase";
import { useSession } from "../lib/session";
import { todayWorkDate, monthRange, monthLabel, shortDate, dateTime, inr } from "../lib/format";
import { Button, Card, PageHeader, Input, Select, Table, Td, Badge, Loading, ErrorBox, Empty, Stat, Modal, Field, useAsync, useAction } from "../components/ui";
import type { Interview, SelectionRequest, SelectionStatus } from "../lib/types";

type Row = Pick<Interview, "id" | "work_date" | "candidate_name" | "client_name" | "round_label" | "time_label" | "handler_id" | "selection" | "selection_date" | "raw_text">;
const PRIORITY: Record<string, number> = { pending: 3, approved: 2, rejected: 1 };

/** Interviews page — Team-handled interviews and their selection status (getPortalInterviewStatusData). */
export function Interviews() {
  const s = useSession();
  const admin = s.isTeamAdmin;
  const [ym, setYm] = useState(todayWorkDate().slice(0, 7));
  const [search, setSearch] = useState("");
  const [handler, setHandler] = useState("");
  const [status, setStatus] = useState("");
  const [dlg, setDlg] = useState<Row | null>(null);
  const [pick, setPick] = useState<SelectionStatus>("selected");
  const [selDate, setSelDate] = useState(todayWorkDate());
  const { busy, run } = useAction();

  const data = useAsync(async () => {
    const [from, to] = monthRange(ym);
    let b = (a: number, z: number) => {
      let x = supabase.from("interviews").select("id,work_date,candidate_name,client_name,round_label,time_label,handler_id,selection,selection_date,raw_text")
        .eq("team_id", s.teamId!).eq("outcome", "completed").not("handler_id", "is", null).gte("work_date", from).lt("work_date", to)
        .order("work_date", { ascending: false }).order("seq", { ascending: false });
      if (s.role === "HANDLER") x = x.in("handler_id", s.myHandlerIds.length ? s.myHandlerIds : ["-"]);
      return x.range(a, z);
    };
    const rows = await fetchAll<Row>(b);
    const ids = rows.map((r) => r.id);
    const reqs: SelectionRequest[] = [];
    for (let i = 0; i < ids.length; i += 300) {
      reqs.push(...((await q(supabase.from("selection_requests").select("*").in("interview_id", ids.slice(i, i + 300)))) as SelectionRequest[]));
    }
    const byIv = new Map<string, SelectionRequest>();
    for (const r of reqs) {
      const cur = byIv.get(r.interview_id);
      if (!cur || PRIORITY[r.status] > PRIORITY[cur.status] || (PRIORITY[r.status] === PRIORITY[cur.status] && r.requested_at > cur.requested_at)) byIv.set(r.interview_id, r);
    }
    return { rows, req: byIv };
  }, [s.teamId, ym, s.role]);

  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    return (data.data?.rows ?? []).filter((r) =>
      (!t || `${r.candidate_name} ${r.client_name} ${r.round_label}`.toLowerCase().includes(t)) &&
      (!handler || r.handler_id === handler) &&
      (!status || (status === "pending_request" ? data.data!.req.get(r.id)?.status === "pending" : r.selection === status)));
  }, [data.data, search, handler, status]);

  const all = data.data?.rows ?? [];
  const pendingReqs = all.filter((r) => data.data!.req.get(r.id)?.status === "pending").length;

  const submit = () => run("sel", async () => {
    const args = { p_interview: dlg!.id, p_selection: pick, p_date: selDate };
    if (admin) await rpc("admin_set_selection", args); else await rpc("request_selection", args);
    setDlg(null); data.reload();
  }, admin ? "Selection updated" : "Selection request sent to admin");

  return (
    <>
      <PageHeader title="Interviews" subtitle={`${admin ? "Team" : "Your"}-handled interviews · ${monthLabel(ym)} · mark candidates Selected to earn the selection incentive`}
        actions={<Button size="sm" onClick={data.reload}>Check for updates</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Interviews" value={all.length} sub={monthLabel(ym)} />
        <Stat label="In progress" value={all.filter((r) => r.selection === "in_progress").length} />
        <Stat label="Selected" value={all.filter((r) => r.selection === "selected").length} tone="emerald" />
        <Stat label="Pending requests" value={pendingReqs} tone={pendingReqs ? "amber" : "slate"} />
        <Stat label="Selection rule" value={inr(2000)} sub="per selected candidate (Admin → Incentive Amounts)" tone="indigo" />
      </div>
      {pendingReqs > 0 && !admin && <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800 ring-1 ring-amber-200">{pendingReqs} selection request{pendingReqs > 1 ? "s are" : " is"} waiting for admin approval.</div>}
      <Card pad={false} title={<span className="text-xs font-normal text-slate-500">{rows.length} of {all.length} interviews</span>}
        actions={<>
          <Input placeholder="Search candidate, client or round…" value={search} onChange={(e) => setSearch(e.target.value)} className="w-56" />
          {admin && <Select value={handler} onChange={(e) => setHandler(e.target.value)}><option value="">All handlers</option>{s.handlers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</Select>}
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option><option value="in_progress">In progress</option><option value="selected">Selected</option>
            <option value="rejected">Rejected</option><option value="on_hold">On hold</option><option value="pending_request">Request pending</option>
          </Select>
          <Input type="month" value={ym} onChange={(e) => setYm(e.target.value)} />
        </>}>
        {data.loading ? <Loading /> : data.error ? <div className="p-4"><ErrorBox error={data.error} /></div> : rows.length === 0 ? <Empty>No interviews match.</Empty> : (
          <Table head={["Date", "Candidate", "Client", "Round", "Time", "Handler", "Status", "Request", ""]} dense>
            {rows.slice(0, 1200).map((r) => {
              const rq = data.data!.req.get(r.id);
              return (
                <tr key={r.id}>
                  <Td className="whitespace-nowrap">{shortDate(r.work_date)}</Td>
                  <Td className="font-medium" title={r.raw_text}>{r.candidate_name}</Td>
                  <Td>{r.client_name}</Td>
                  <Td className="whitespace-nowrap">{r.round_label}</Td>
                  <Td className="whitespace-nowrap tabular">{r.time_label}</Td>
                  <Td>{s.handlerName(r.handler_id)}</Td>
                  <Td><Badge v={r.selection} />{r.selection === "selected" && r.selection_date && <span className="ml-1 text-xs text-slate-400">{shortDate(r.selection_date)}</span>}</Td>
                  <Td className="text-xs">{rq ? <><Badge v={rq.status}>{rq.requested_selection.replace("_", " ")} · {rq.status}</Badge> <span className="text-slate-400">{dateTime(rq.requested_at)}</span></> : ""}</Td>
                  <Td className="text-right">
                    {rq?.status !== "pending" && <Button size="sm" variant={r.selection === "selected" ? "ghost" : "secondary"}
                      onClick={() => { setDlg(r); setPick(r.selection === "selected" ? "in_progress" : "selected"); setSelDate(todayWorkDate()); }}>
                      {r.selection === "selected" ? "Change" : admin ? "Mark selected" : "Request selected"}</Button>}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
      <Modal open={!!dlg} onClose={() => setDlg(null)} title={admin ? "Update selection" : "Request selection update"}
        footer={<><Button onClick={() => setDlg(null)}>Cancel</Button><Button variant="primary" busy={busy === "sel"} onClick={submit}>{admin ? "Save" : "Send request"}</Button></>}>
        {dlg && <p className="text-sm text-slate-600">{dlg.candidate_name} · {dlg.client_name} · {dlg.round_label} · {shortDate(dlg.work_date)}</p>}
        <Field label="Status"><Select className="w-full" value={pick} onChange={(e) => setPick(e.target.value as SelectionStatus)}>
          <option value="selected">Selected</option><option value="in_progress">In progress</option><option value="rejected">Rejected</option><option value="on_hold">On hold</option></Select></Field>
        {pick === "selected" && <Field label="Date of selection" hint="Decides which month the selection incentive is counted in."><Input type="date" value={selDate} onChange={(e) => setSelDate(e.target.value)} /></Field>}
      </Modal>
    </>
  );
}
