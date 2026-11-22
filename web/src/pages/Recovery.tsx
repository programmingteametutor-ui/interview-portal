import { useState } from "react";
import { supabase, q, rpc, fetchAll } from "../lib/supabase";
import { useSession } from "../lib/session";
import { prettyDate, inr, dateTime } from "../lib/format";
import { runRecovery, type RecInterview, type RecLedgerRow } from "@shared/recovery";
import { Button, Card, PageHeader, Badge, Loading, ErrorBox, Empty, Tabs, Input, useAsync, useAction } from "../components/ui";

interface IvLite { id: string; work_date: string; time_label: string | null; round_label: string | null; raw_text: string; handler_id: string | null; outcome: string }
interface RecRow {
  id: string; team_id: string; kind: "recovery" | "same_day" | "ambiguous"; candidate_score: number; client_score: number; confidence: number;
  from_round_no: number; to_round_no: number; amount: number; reason: string | null; status: string; review_note: string | null;
  first_seen_at: string; reviewed_at: string | null;
  earning: IvLite; evidence: IvLite; second: IvLite | null;
}
const IV = "id,work_date,time_label,round_label,raw_text,handler_id,outcome";
const SEL = `*, earning:interviews!promotion_recoveries_earning_interview_id_fkey(${IV}), evidence:interviews!promotion_recoveries_evidence_interview_id_fkey(${IV}), second:interviews!promotion_recoveries_second_evidence_id_fkey(${IV})`;

/** Promotion Recovery + Recovery Exceptions + Recovery Evidence (RecoveryEngine.gs / PortalRecovery.gs) */
export function Recovery() {
  const s = useSession();
  const admin = s.isTeamAdmin && !s.readOnly;
  const [tab, setTab] = useState<"recovery" | "review" | "history">("recovery");
  const [pick, setPick] = useState<Record<string, string>>({});
  const [note, setNote] = useState<Record<string, string>>({});
  const { busy, run } = useAction();

  const data = useAsync(async () => {
    let b = supabase.from("promotion_recoveries").select(SEL).eq("team_id", s.teamId!).order("first_seen_at", { ascending: false });
    if (tab === "recovery") b = b.eq("status", "pending").eq("kind", "recovery");
    else if (tab === "review") b = b.eq("status", "pending").neq("kind", "recovery");
    else b = b.neq("status", "pending").limit(300);
    return (await q(b)) as unknown as RecRow[];
  }, [s.teamId, tab]);

  const scan = () => run("scan", async () => {
    const ivs = await fetchAll<RecInterview & { cand: { canonical_name: string } | null; cli: { canonical_name: string } | null }>((a, z) =>
      supabase.from("interviews").select("id,work_date,start_min,candidate_name,candidate_id,client_name,client_id,round_no,is_loop,outcome,handler_id,raw_text,seq,cand:candidates(canonical_name),cli:clients(canonical_name)")
        .eq("team_id", s.teamId!).not("round_no", "is", null).order("work_date").range(a, z));
    const ledger = await fetchAll<RecLedgerRow>((a, z) =>
      supabase.from("incentives").select("earning_interview_id,candidate_name,client_name,from_round,previous_date,handler_id").eq("team_id", s.teamId!).eq("type", "promotion").range(a, z));
    const rows = runRecovery(ivs.map((i) => ({ ...i, candidate_canonical: i.cand?.canonical_name ?? null, client_canonical: i.cli?.canonical_name ?? null })), ledger);
    const res = await rpc<{ rows: number; new: number; invalid: number }>("save_recovery_scan", { p_team: s.teamId, p_rows: rows });
    data.reload();
    return res;
  }, "Recovery scan complete");

  const decide = (r: RecRow, decision: "approve" | "reject" | "dismiss") =>
    run(decision + r.id, async () => {
      await rpc("review_recovery", { p_id: r.id, p_decision: decision, p_note: note[r.id] || null, p_evidence: pick[r.id] || null });
      data.reload();
    }, decision === "approve" ? "Added to the incentive ledger" : decision === "reject" ? "Rejected" : "Dismissed");

  const rows = (data.data ?? []).filter((r) => r.earning && r.evidence)
    .filter((r) => s.role !== "HANDLER" || s.myHandlerIds.includes(r.earning.handler_id ?? ""));
  return (
    <>
      <PageHeader title="Promotion Recovery"
        subtitle="Promotions the regular scan missed because the candidate or client was written differently between rounds. Nothing is paid until approved."
        actions={admin ? <Button variant="primary" busy={busy === "scan"} onClick={scan}>Run recovery scan</Button> : null} />
      <Tabs value={tab} onChange={setTab} items={[
        { id: "recovery", label: "Recovered promotions" },
        { id: "review", label: "Needs review (same day / ambiguous)" },
        { id: "history", label: "History" },
      ]} />
      {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : rows.length === 0 ? (
        <Card><Empty>{tab === "history" ? "No decisions yet." : admin ? "Nothing pending. Run a scan to look for missed promotions." : "Nothing pending."}</Empty></Card>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <Card key={r.id} pad={false}
              title={<span className="flex flex-wrap items-center gap-2">
                <Badge v={r.kind === "recovery" ? "approved" : "pending"}>{r.kind === "recovery" ? "Recovered" : r.kind === "same_day" ? "Same-day higher round" : "Ambiguous evidence"}</Badge>
                <span>{s.handlerName(r.earning.handler_id)}</span>
                <span className="font-normal text-slate-500">· R{r.from_round_no === 999 ? "Final" : r.from_round_no} → {r.to_round_no === 999 ? "Final" : "R" + r.to_round_no} · {inr(r.amount)}</span>
              </span>}
              actions={<span className="text-xs text-slate-500 tabular">first found {dateTime(r.first_seen_at)}</span>}>
              <div className="grid gap-px bg-slate-100 md:grid-cols-2">
                <Evidence label="Handled by our team (earning call)" iv={r.earning} />
                <div className="bg-white">
                  <Evidence label="Higher round (proof)" iv={r.evidence} pickable={r.kind === "ambiguous" && r.status === "pending"}
                    picked={(pick[r.id] ?? r.evidence.id) === r.evidence.id} onPick={() => setPick({ ...pick, [r.id]: r.evidence.id })} name={r.id} />
                  {r.second && <Evidence label="Other possible proof" iv={r.second} pickable={r.status === "pending"}
                    picked={pick[r.id] === r.second.id} onPick={() => setPick({ ...pick, [r.id]: r.second!.id })} name={r.id} />}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-4 py-2.5">
                <span className="text-xs text-slate-500 tabular">candidate {r.candidate_score}% · client {r.client_score}% · confidence {r.confidence}%{r.kind !== "recovery" && r.reason ? ` — ${r.reason}` : ""}</span>
                <span className="flex-1" />
                {r.status === "pending" ? (admin && <>
                  <Input placeholder="Note (optional)" value={note[r.id] ?? ""} onChange={(e) => setNote({ ...note, [r.id]: e.target.value })} className="w-56 py-1 text-xs" />
                  <Button size="sm" variant="ghost" busy={busy === "dismiss" + r.id} onClick={() => decide(r, "dismiss")}>Dismiss</Button>
                  <Button size="sm" variant="danger" busy={busy === "reject" + r.id} onClick={() => decide(r, "reject")}>Reject</Button>
                  <Button size="sm" variant="success" busy={busy === "approve" + r.id} onClick={() => decide(r, "approve")}>Approve {inr(r.amount)}</Button>
                </>) : (
                  <span className="text-xs"><Badge v={r.status === "applied" ? "approved" : r.status === "rejected" ? "rejected" : "in_progress"}>{r.status}</Badge>
                    <span className="ml-2 text-slate-500">{dateTime(r.reviewed_at)} {r.review_note}</span></span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function Evidence({ label, iv, pickable, picked, onPick, name }: { label: string; iv: IvLite; pickable?: boolean; picked?: boolean; onPick?: () => void; name?: string }) {
  return (
    <label className={"block bg-white px-4 py-3 " + (pickable ? "cursor-pointer hover:bg-slate-50" : "")}>
      <div className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-slate-500">
        {pickable && <input type="radio" name={name} checked={picked} onChange={onPick} />}
        {label}
      </div>
      <div className="text-sm"><b>{prettyDate(iv.work_date)}</b> <span className="text-slate-500">{iv.time_label} · {iv.round_label}</span> <Badge v={iv.outcome} /></div>
      <div className="mt-1 font-mono text-xs leading-relaxed text-slate-700">{iv.raw_text}</div>
    </label>
  );
}
