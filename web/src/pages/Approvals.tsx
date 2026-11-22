import { useMemo, useState } from "react";
import { supabase, q, rpc } from "../lib/supabase";
import { useSession } from "../lib/session";
import { prettyDate, dateTime } from "../lib/format";
import { Button, Card, PageHeader, Table, Td, Badge, Loading, ErrorBox, Empty, Tabs, useAsync, useAction } from "../components/ui";
import type { Interview, OutcomeRequest, ReassignmentRequest, SelectionRequest } from "../lib/types";

type IV = Pick<Interview, "work_date" | "time_label" | "candidate_name" | "client_name" | "round_label" | "outcome" | "handler_id" | "call_code">;
const IVSEL = "interview:interviews(work_date,time_label,candidate_name,client_name,round_label,outcome,handler_id,call_code)";

export function Approvals() {
  const s = useSession();
  const [tab, setTab] = useState<"outcomes" | "corrections" | "transfers" | "selections">("outcomes");
  const { busy, run } = useAction();

  const data = useAsync(async () => {
    const [outs, res, sels] = await Promise.all([
      q(supabase.from("outcome_requests").select(`*, ${IVSEL}`).eq("team_id", s.teamId!).eq("status", "pending").order("submitted_at")),
      q(supabase.from("reassignment_requests").select(`*, ${IVSEL}`).eq("team_id", s.teamId!).eq("status", "pending").order("requested_at")),
      q(supabase.from("selection_requests").select(`*, ${IVSEL}`).eq("team_id", s.teamId!).eq("status", "pending").order("requested_at")),
    ]);
    return {
      outs: outs as (OutcomeRequest & { interview: IV })[],
      res: res as (ReassignmentRequest & { interview: IV })[],
      sels: sels as (SelectionRequest & { interview: IV })[],
    };
  }, [s.teamId]);

  const outcomes = data.data?.outs.filter((o) => o.kind === "outcome") ?? [];
  const corrections = data.data?.outs.filter((o) => o.kind === "correction") ?? [];

  // approvePortalCallOutcomeBatch(handler, dateKey) — group by working date + handler
  const groups = useMemo(() => {
    const m = new Map<string, { date: string; handler: string | null; items: typeof outcomes }>();
    for (const o of outcomes) {
      const k = `${o.interview.work_date}|${o.handler_id}`;
      if (!m.has(k)) m.set(k, { date: o.interview.work_date, handler: o.handler_id, items: [] });
      m.get(k)!.items.push(o);
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date) || s.handlerName(a.handler).localeCompare(s.handlerName(b.handler)));
  }, [outcomes, s]);

  const review = (key: string, ids: string[], approve: boolean) =>
    run(key, async () => { await rpc("review_outcome_requests", { p_ids: ids, p_approve: approve }); data.reload(); },
      `${ids.length} ${approve ? "approved" : "rejected"}`);

  if (!s.isTeamAdmin) return <Empty>Approvals are for team admins.</Empty>;

  return (
    <>
      <PageHeader title="Approvals" subtitle="Review what handlers submitted. Approved outcomes become final and feed incentives."
        actions={outcomes.length > 0 && tab === "outcomes" ? (
          <Button variant="success" busy={busy === "all"} onClick={() => review("all", outcomes.map((o) => o.id), true)}>Approve all {outcomes.length}</Button>
        ) : null} />
      <Tabs value={tab} onChange={setTab} items={[
        { id: "outcomes", label: <>Outcomes <Count n={outcomes.length} /></> },
        { id: "corrections", label: <>Corrections <Count n={corrections.length} /></> },
        { id: "transfers", label: <>Transfers <Count n={data.data?.res.length ?? 0} /></> },
        { id: "selections", label: <>Selections <Count n={data.data?.sels.length ?? 0} /></> },
      ]} />
      {data.loading ? <Loading /> : data.error ? <ErrorBox error={data.error} /> : (
        <>
          {tab === "outcomes" && (groups.length === 0 ? <Card><Empty>No pending outcomes.</Empty></Card> : (
            <div className="space-y-4">
              {groups.map((g) => {
                const k = `${g.date}|${g.handler}`;
                return (
                  <Card key={k} pad={false} title={<>{s.handlerName(g.handler)} <span className="font-normal text-slate-500">· {prettyDate(g.date)} · {g.items.length} call{g.items.length === 1 ? "" : "s"}</span></>}
                    actions={<>
                      <Button size="sm" variant="ghost" busy={busy === "r" + k} onClick={() => review("r" + k, g.items.map((i) => i.id), false)}>Reject batch</Button>
                      <Button size="sm" variant="success" busy={busy === "a" + k} onClick={() => review("a" + k, g.items.map((i) => i.id), true)}>Approve batch</Button>
                    </>}>
                    <Table head={["Time", "Candidate · Client", "Round", "Outcome", "Submitted", ""]} dense>
                      {g.items.map((o) => (
                        <tr key={o.id}>
                          <Td className="tabular whitespace-nowrap">{o.interview.time_label}</Td>
                          <Td>{o.interview.candidate_name} <span className="text-slate-400">·</span> {o.interview.client_name}</Td>
                          <Td className="whitespace-nowrap">{o.interview.round_label}</Td>
                          <Td><Badge v={o.requested_outcome} /></Td>
                          <Td className="text-xs text-slate-500">{dateTime(o.submitted_at)} · {o.submitted_email}</Td>
                          <Td className="text-right whitespace-nowrap">
                            <Button size="sm" variant="ghost" busy={busy === "r" + o.id} onClick={() => review("r" + o.id, [o.id], false)}>Reject</Button>
                            <Button size="sm" busy={busy === "a" + o.id} onClick={() => review("a" + o.id, [o.id], true)}>Approve</Button>
                          </Td>
                        </tr>
                      ))}
                    </Table>
                  </Card>
                );
              })}
            </div>
          ))}

          {tab === "corrections" && (
            <Card pad={false}>{corrections.length === 0 ? <Empty>No pending corrections.</Empty> : (
              <Table head={["Date", "Candidate · Client", "Handler", "Change", "Requested by", ""]}>
                {corrections.map((o) => (
                  <tr key={o.id}>
                    <Td className="whitespace-nowrap">{prettyDate(o.interview.work_date)}</Td>
                    <Td>{o.interview.candidate_name} · {o.interview.client_name} <span className="text-xs text-slate-400">{o.interview.round_label}</span></Td>
                    <Td>{s.handlerName(o.handler_id)}</Td>
                    <Td><Badge v={o.previous_outcome ?? "scheduled"} /> → <Badge v={o.requested_outcome} /></Td>
                    <Td className="text-xs text-slate-500">{o.submitted_email}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" busy={busy === "r" + o.id} onClick={() => review("r" + o.id, [o.id], false)}>Reject</Button>
                      <Button size="sm" busy={busy === "a" + o.id} onClick={() => review("a" + o.id, [o.id], true)}>Approve</Button>
                    </Td>
                  </tr>
                ))}
              </Table>)}
            </Card>
          )}

          {tab === "transfers" && (
            <Card pad={false}>{!data.data?.res.length ? <Empty>No pending transfers.</Empty> : (
              <Table head={["Date · Time", "Candidate · Client", "From", "To", "Requested by", ""]}>
                {data.data.res.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{prettyDate(r.interview.work_date)} · {r.interview.time_label}</Td>
                    <Td>{r.interview.candidate_name} · {r.interview.client_name}</Td>
                    <Td>{s.handlerName(r.from_handler_id)}</Td><Td className="font-medium">{s.handlerName(r.to_handler_id)}</Td>
                    <Td className="text-xs text-slate-500">{r.requested_email}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" busy={busy === "r" + r.id} onClick={() => run("r" + r.id, async () => { await rpc("review_reassignment", { p_id: r.id, p_approve: false }); data.reload(); }, "Rejected")}>Reject</Button>
                      <Button size="sm" busy={busy === "a" + r.id} onClick={() => run("a" + r.id, async () => { await rpc("review_reassignment", { p_id: r.id, p_approve: true }); data.reload(); }, "Transfer approved")}>Approve</Button>
                    </Td>
                  </tr>
                ))}
              </Table>)}
            </Card>
          )}

          {tab === "selections" && (
            <Card pad={false}>{!data.data?.sels.length ? <Empty>No pending selection updates.</Empty> : (
              <Table head={["Interview", "Candidate · Client", "Handler", "Change", "Selection date", ""]}>
                {data.data.sels.map((r) => (
                  <tr key={r.id}>
                    <Td className="whitespace-nowrap">{prettyDate(r.interview.work_date)}</Td>
                    <Td>{r.interview.candidate_name} · {r.interview.client_name} <span className="text-xs text-slate-400">{r.interview.round_label}</span></Td>
                    <Td>{s.handlerName(r.interview.handler_id)}</Td>
                    <Td><Badge v={r.current_selection ?? "in_progress"} /> → <Badge v={r.requested_selection} /></Td>
                    <Td>{prettyDate(r.selection_date)}</Td>
                    <Td className="text-right whitespace-nowrap">
                      <Button size="sm" variant="ghost" busy={busy === "r" + r.id} onClick={() => run("r" + r.id, async () => { await rpc("review_selection", { p_id: r.id, p_approve: false }); data.reload(); }, "Rejected")}>Reject</Button>
                      <Button size="sm" busy={busy === "a" + r.id} onClick={() => run("a" + r.id, async () => { await rpc("review_selection", { p_id: r.id, p_approve: true }); data.reload(); }, "Selection approved")}>Approve</Button>
                    </Td>
                  </tr>
                ))}
              </Table>)}
            </Card>
          )}
        </>
      )}
    </>
  );
}

const Count = ({ n }: { n: number }) => n ? <span className="ml-1 rounded-full bg-amber-100 px-1.5 text-[11px] text-amber-800">{n}</span> : null;
