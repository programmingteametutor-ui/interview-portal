import { useState } from "react";
import { supabase, q, rpc } from "../lib/supabase";
import { useSession } from "../lib/session";
import { todayWorkDate, prettyDate, addDays, formatMinutesSafe } from "../lib/format";
import { Button, Card, PageHeader, Input, Table, Td, Badge, Loading, ErrorBox, Empty, Select, Field, Modal, Stat, useAsync, useAction } from "../components/ui";
import type { CallOutcome, Interview, OutcomeRequest, ReassignmentRequest, SelectionRequest, SelectionStatus } from "../lib/types";

type Dialog =
  | { kind: "transfer"; call: Interview }
  | { kind: "correction"; call: Interview }
  | { kind: "selection"; call: Interview }
  | null;

export function Schedule() {
  const s = useSession();
  const [date, setDate] = useState(todayWorkDate());
  const [scope, setScope] = useState<"mine" | "all">(s.role === "HANDLER" ? "mine" : "all");
  const [handlerFilter, setHandlerFilter] = useState("");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [pick, setPick] = useState("");
  const [selDate, setSelDate] = useState(todayWorkDate());
  const { busy, run } = useAction();
  const admin = s.isTeamAdmin;
  const canAct = admin || s.role === "HANDLER";

  const data = useAsync(async () => {
    if (!s.teamId) return null;
    const calls = (await q(supabase.from("interviews").select("*").eq("team_id", s.teamId).eq("work_date", date))) as Interview[];
    const ids = calls.map((c) => c.id);
    const none = ["00000000-0000-0000-0000-000000000000"];
    const [outs, res, sels] = await Promise.all([
      q(supabase.from("outcome_requests").select("*").in("interview_id", ids.length ? ids : none).eq("status", "pending")),
      q(supabase.from("reassignment_requests").select("*").in("interview_id", ids.length ? ids : none).eq("status", "pending")),
      q(supabase.from("selection_requests").select("*").in("interview_id", ids.length ? ids : none).eq("status", "pending")),
    ]);
    return { calls, outs: outs as OutcomeRequest[], res: res as ReassignmentRequest[], sels: sels as SelectionRequest[] };
  }, [s.teamId, date]);

  const mineIds = new Set(s.myHandlerIds);
  const calls = (data.data?.calls ?? [])
    .filter((c) => scope === "all" || (c.handler_id && mineIds.has(c.handler_id)))
    .filter((c) => !handlerFilter || c.handler_id === handlerFilter)
    .sort((a, b) => (a.start_min ?? 1e9) - (b.start_min ?? 1e9));
  const ownsCall = (c: Interview) => admin || (!!c.handler_id && mineIds.has(c.handler_id));

  const submit = (c: Interview, o: CallOutcome) =>
    run(c.id + o, async () => { await rpc("submit_outcome", { p_interview: c.id, p_outcome: o }); data.reload(); },
      admin ? `Marked ${o} — approve it in Approvals` : `${o[0].toUpperCase() + o.slice(1)} sent for approval`);

  const doDialog = () => {
    if (!dialog) return;
    const c = dialog.call;
    if (dialog.kind === "transfer") {
      return run("dlg", async () => {
        if (admin) await rpc("set_assignments", { p_team: s.teamId, p_items: [{ interview_id: c.id, handler_id: pick, mode: "manual" }] });
        else await rpc("request_reassignment", { p_interview: c.id, p_to_handler: pick });
        setDialog(null); data.reload();
      }, admin ? "Call reassigned" : "Transfer requested");
    }
    if (dialog.kind === "correction") {
      return run("dlg", async () => { await rpc("request_outcome_correction", { p_interview: c.id, p_outcome: pick }); setDialog(null); data.reload(); }, "Correction requested");
    }
    if (dialog.kind === "selection") {
      return run("dlg", async () => {
        const args = { p_interview: c.id, p_selection: pick as SelectionStatus, p_date: selDate };
        if (admin) await rpc("admin_set_selection", args); else await rpc("request_selection", args);
        setDialog(null); data.reload();
      }, admin ? "Selection updated" : "Selection sent for approval");
    }
  };

  const info = (c: Interview) => ({
    out: data.data!.outs.find((o) => o.interview_id === c.id && o.kind === "outcome"),
    corr: data.data!.outs.find((o) => o.interview_id === c.id && o.kind === "correction"),
    tr: data.data!.res.find((r) => r.interview_id === c.id),
    sel: data.data!.sels.find((r) => r.interview_id === c.id),
    mine: ownsCall(c),
  });
  type Info = ReturnType<typeof info>;
  const handlerCell = (c: Interview, x: Info) => (<>
    {c.handler_id ? s.handlerName(c.handler_id) : <Badge v="support">{c.assignment_mode === "support" ? "Support" : "Unassigned"}</Badge>}
    {x.tr && <div className="text-xs text-amber-700">→ {s.handlerName(x.tr.to_handler_id)} (pending)</div>}
  </>);
  const statusCell = (c: Interview, x: Info) => (<>
    <Badge v={c.outcome} />
    {x.out && <div><Badge v="pending">{x.out.requested_outcome} · pending</Badge></div>}
    {x.corr && <div><Badge v="pending">fix → {x.corr.requested_outcome}</Badge></div>}
    {c.selection !== "in_progress" && <div><Badge v={c.selection} /></div>}
    {x.sel && <div><Badge v="pending">{x.sel.requested_selection.replace("_", " ")} · pending</Badge></div>}
  </>);
  const identityHint = (c: Interview, x: Info) => (!c.candidate_id || !c.client_id) && x.mine && c.outcome === "scheduled" && !admin ? (
    <a href="#/identity" className="block text-[11px] text-amber-700 hover:underline">⚠ map {!c.candidate_id ? "candidate" : ""}{!c.candidate_id && !c.client_id ? " & " : ""}{!c.client_id ? "client" : ""} before submitting</a>
  ) : null;
  const actionsCell = (c: Interview, x: Info) => (<>
    {canAct && x.mine && c.outcome === "scheduled" && c.handler_id && !x.tr && (
      <div className="flex flex-wrap justify-end gap-1 max-md:justify-start">
        <Button size="sm" variant={x.out?.requested_outcome === "completed" ? "success" : "secondary"} busy={busy === c.id + "completed"} onClick={() => submit(c, "completed")}>Completed</Button>
        <Button size="sm" variant={x.out?.requested_outcome === "rescheduled" ? "primary" : "secondary"} busy={busy === c.id + "rescheduled"} onClick={() => submit(c, "rescheduled")}>Rescheduled</Button>
        <Button size="sm" variant={x.out?.requested_outcome === "cancelled" ? "danger" : "secondary"} busy={busy === c.id + "cancelled"} onClick={() => submit(c, "cancelled")}>Cancelled</Button>
        {!x.out && <Button size="sm" variant="ghost" onClick={() => { setPick(""); setDialog({ kind: "transfer", call: c }); }}>Transfer</Button>}
      </div>
    )}
    {canAct && x.mine && c.outcome !== "scheduled" && (
      <div className="flex flex-wrap justify-end gap-1 max-md:justify-start">
        {c.outcome === "completed" && !x.sel && <Button size="sm" onClick={() => { setPick(c.selection === "selected" ? "in_progress" : "selected"); setSelDate(todayWorkDate()); setDialog({ kind: "selection", call: c }); }}>Selection…</Button>}
        {!x.corr && <Button size="sm" variant="ghost" onClick={() => { setPick(""); setDialog({ kind: "correction", call: c }); }}>Correct outcome</Button>}
        {admin && <Button size="sm" variant="ghost" busy={busy === "rev" + c.id}
          onClick={() => confirm("Reverse this approved outcome back to scheduled?") && run("rev" + c.id, async () => { await rpc("reverse_outcome", { p_interview: c.id }); data.reload(); }, "Outcome reversed")}>Reverse</Button>}
      </div>
    )}
  </>);

  return (
    <>
      <PageHeader title="Call Schedule" subtitle={prettyDate(date)}
        actions={<>
          {s.role === "HANDLER" || admin ? (
            <Select value={scope} onChange={(e) => setScope(e.target.value as "mine" | "all")}>
              <option value="mine">My calls</option><option value="all">All team calls</option>
            </Select>) : null}
          {scope === "all" && <Select value={handlerFilter} onChange={(e) => setHandlerFilter(e.target.value)}>
            <option value="">All handlers</option>{s.handlers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</Select>}
          <Button size="sm" onClick={() => setDate(addDays(date, -1))}>←</Button>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button size="sm" onClick={() => setDate(addDays(date, 1))}>→</Button>
          <Button size="sm" onClick={() => setDate(todayWorkDate())}>Today</Button>
        </>} />

      {data.data && (() => { const c = data.data.calls; return (
        <div className="mb-4 grid grid-cols-3 gap-2 md:grid-cols-7">
          <Stat label="Calls" value={c.length} />
          <Stat label="Assigned" value={c.filter((x) => x.handler_id || x.assignment_mode === "support").length} />
          <Stat label="Unassigned" value={c.filter((x) => !x.handler_id && x.assignment_mode !== "support").length} tone={c.some((x) => !x.handler_id && x.assignment_mode !== "support") ? "amber" : "slate"} />
          <Stat label="Completed" value={c.filter((x) => x.outcome === "completed").length} tone="emerald" />
          <Stat label="Rescheduled" value={c.filter((x) => x.outcome === "rescheduled").length} />
          <Stat label="Cancelled" value={c.filter((x) => x.outcome === "cancelled").length} />
          <Stat label="Night calls" value={c.filter((x) => x.is_night).length} sub="2:00 AM and later" />
        </div>); })()}
      {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : calls.length === 0 ? <Card><Empty>No calls{scope === "mine" ? " assigned to you" : ""} on this day.</Empty></Card> : (
        <>
          {/* phones: one card per call */}
          <div className="space-y-2 md:hidden">
            {calls.map((c) => { const x = info(c); return (
              <div key={c.id} className="rounded-lg bg-white p-3 shadow-sm ring-1 ring-slate-200">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold tabular">{c.time_label ?? "—"} {c.is_night && <Badge v="night">Night</Badge>}
                      <span className="ml-1 text-xs font-normal text-slate-400">{c.duration_min ? `${c.duration_min} min` : ""}</span></div>
                    <div className="mt-0.5 font-medium text-slate-900">{c.candidate_name ?? <span className="text-rose-600">Unparsed line</span>}</div>
                    <div className="text-xs text-slate-500">{c.client_name}{c.job_role ? ` · ${c.job_role}` : ""} · {c.round_label}</div>
                  </div>
                  <div className="text-right text-xs">{handlerCell(c, x)}</div>
                </div>
                <div className="mt-2 flex flex-wrap gap-1">{statusCell(c, x)}</div>
                {identityHint(c, x)}
                <div className="mt-2">{actionsCell(c, x)}</div>
              </div>
            ); })}
          </div>
          {/* desktop table */}
          <Card pad={false} className="hidden md:block">
            <Table head={["Time", "Candidate · Client", "Round", "Handler", "Status", ""]}>
              {calls.map((c) => { const x = info(c); return (
                <tr key={c.id} className="hover:bg-slate-50/60">
                  <Td className="whitespace-nowrap tabular">
                    <div className="font-medium">{c.time_label ?? "—"}</div>
                    <div className="text-xs text-slate-400">{c.duration_min ? `${c.duration_min} min` : ""} {c.duration_min && c.start_min ? `→ ${formatMinutesSafe(c.start_min + c.duration_min)}` : ""}</div>
                    {c.is_night && <Badge v="night">Night</Badge>}
                  </Td>
                  <Td>
                    <div className="font-medium text-slate-900">{c.candidate_name ?? <span className="text-rose-600" title={c.raw_text}>Unparsed line</span>}
                      {c.location_tag && <span className="ml-1 text-xs font-normal text-slate-400">({c.location_tag})</span>}</div>
                    <div className="text-xs text-slate-500">{c.client_name}{c.job_role ? ` · ${c.job_role}` : ""}</div>
                    {identityHint(c, x)}
                  </Td>
                  <Td className="whitespace-nowrap">{c.round_label}{c.is_loop && <span className="ml-1 text-xs text-slate-400">loop</span>}</Td>
                  <Td>{handlerCell(c, x)}</Td>
                  <Td className="space-y-1">{statusCell(c, x)}</Td>
                  <Td className="text-right">{actionsCell(c, x)}</Td>
                </tr>
              ); })}
            </Table>
          </Card>
        </>
      )}

      <Modal open={!!dialog} onClose={() => setDialog(null)}
        title={dialog?.kind === "transfer" ? (admin ? "Reassign call" : "Request transfer") : dialog?.kind === "correction" ? "Request outcome correction" : "Selection status"}
        footer={<><Button onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" disabled={!pick} busy={busy === "dlg"} onClick={doDialog}>Submit</Button></>}>
        {dialog && <p className="text-sm text-slate-600">{dialog.call.candidate_name} · {dialog.call.client_name} · {dialog.call.round_label} · {dialog.call.time_label}</p>}
        {dialog?.kind === "transfer" && (
          <Field label="Transfer to">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} className="w-full">
              <option value="">Choose handler…</option>
              {s.handlers.filter((h) => h.active && h.id !== dialog.call.handler_id).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
            </Select>
          </Field>
        )}
        {dialog?.kind === "correction" && (
          <Field label={`Current outcome: ${dialog.call.outcome}. Change to`}>
            <Select value={pick} onChange={(e) => setPick(e.target.value)} className="w-full">
              <option value="">Choose…</option>
              {(["completed", "rescheduled", "cancelled"] as const).filter((o) => o !== dialog.call.outcome).map((o) => <option key={o} value={o}>{o}</option>)}
            </Select>
          </Field>
        )}
        {dialog?.kind === "selection" && (<>
          <Field label="Status">
            <Select value={pick} onChange={(e) => setPick(e.target.value)} className="w-full">
              <option value="selected">Selected</option><option value="in_progress">In progress</option>
              <option value="rejected">Rejected</option><option value="on_hold">On hold</option>
            </Select>
          </Field>
          {pick === "selected" && <Field label="Date of selection" hint="Decides which month the ₹ selection incentive lands in.">
            <Input type="date" value={selDate} onChange={(e) => setSelDate(e.target.value)} /></Field>}
        </>)}
      </Modal>
    </>
  );
}
