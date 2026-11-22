import { useMemo, useState } from "react";
import { supabase, q, rpc, fetchAll } from "../lib/supabase";
import { useSession } from "../lib/session";
import { todayWorkDate, prettyDate, addDays } from "../lib/format";
import { parseBlock, normKey, type ParsedInterview } from "@shared/parser";
import { autoAssign, weekStart, type SchedResult } from "@shared/scheduler";
import { Button, Card, PageHeader, Input, Table, Td, Badge, Loading, ErrorBox, Empty, Select, useAsync, useAction, Modal } from "../components/ui";
import type { Interview } from "../lib/types";

export function Intake() {
  const s = useSession();
  const [date, setDate] = useState(todayWorkDate());
  const [text, setText] = useState("");
  const [preview, setPreview] = useState<ParsedInterview[] | null>(null);
  const [removeMissing, setRemoveMissing] = useState(false);
  const [keepExisting, setKeepExisting] = useState(true);
  const [proposal, setProposal] = useState<SchedResult[] | null>(null);
  const { busy, run } = useAction();

  // Known clients/candidates (for client/role split + resolution hints)
  const masters = useAsync(async () => {
    const [cl, cla, ca, caa] = await Promise.all([
      fetchAll<{ name_key: string }>((a, b) => supabase.from("clients").select("name_key").range(a, b)),
      fetchAll<{ alias_key: string }>((a, b) => supabase.from("client_aliases").select("alias_key").eq("active", true).range(a, b)),
      fetchAll<{ name_key: string }>((a, b) => supabase.from("candidates").select("name_key").range(a, b)),
      fetchAll<{ alias_key: string }>((a, b) => supabase.from("candidate_aliases").select("alias_key").eq("active", true).range(a, b)),
    ]);
    return {
      clients: new Set([...cl.map((x) => x.name_key), ...cla.map((x) => x.alias_key)]),
      candidates: new Set([...ca.map((x) => x.name_key), ...caa.map((x) => x.alias_key)]),
    };
  }, []);

  const day = useAsync(async () => {
    if (!s.teamId) return null;
    const [rows, state] = await Promise.all([
      q(supabase.from("interviews").select("*").eq("team_id", s.teamId).eq("work_date", date).order("seq")),
      rpc<{ status: string; total: number; unassigned: number; scheduled: number; pending_outcomes: number; pending_reassignments: number }>("work_day_state", { p_team: s.teamId, p_date: date }),
    ]);
    return { rows: rows as Interview[], state };
  }, [s.teamId, date]);

  const closed = day.data?.state.status === "completed";

  const parse = () => {
    const known = masters.data?.clients;
    setPreview(parseBlock(text, { isKnownClient: known ? (n) => known.has(normKey(n)) : undefined }));
  };

  const save = () => run("save", async () => {
    const res = await rpc<{ inserted: number; updated: number; removed: number; kept_missing: number }>("ingest_day", {
      p_team: s.teamId, p_date: date, p_rows: preview, p_remove_missing: removeMissing,
    });
    setPreview(null); setText("");
    day.reload();
    return res;
  }, "Day saved");

  const propose = () => run("auto", async () => {
    const rows = day.data?.rows ?? [];
    const ids = s.handlers.map((h) => h.id);
    const [leaves, prefs, night, pending] = await Promise.all([
      q(supabase.from("handler_leaves").select("handler_id,start_min,end_min").eq("leave_date", date).in("handler_id", ids.length ? ids : ["-"])),
      q(supabase.from("handler_preferences").select("handler_id,candidate_key,candidate_id").eq("team_id", s.teamId!)),
      fetchAll<{ handler_id: string }>((a, b) => supabase.from("interviews").select("handler_id").eq("team_id", s.teamId!).eq("is_night", true)
        .gte("work_date", weekStart(date)).lt("work_date", date).not("handler_id", "is", null).range(a, b)),
      q(supabase.from("outcome_requests").select("interview_id").eq("team_id", s.teamId!).eq("status", "pending")),
    ]);
    const pendingSet = new Set((pending as { interview_id: string }[]).map((p) => p.interview_id));
    const weekly: Record<string, number> = {};
    night.forEach((n) => { weekly[n.handler_id] = (weekly[n.handler_id] || 0) + 1; });
    const result = autoAssign({
      handlers: s.handlers,
      interviews: rows.map((r) => ({
        id: r.id, candidate_name: r.candidate_name, candidate_id: r.candidate_id, start_min: r.start_min, duration_min: r.duration_min,
        is_night: r.is_night, handler_id: r.handler_id,
        locked: r.outcome !== "scheduled" || pendingSet.has(r.id) || r.assignment_mode === "manual" || (keepExisting && !!r.handler_id),
      })),
      leaves: leaves as { handler_id: string; start_min: number | null; end_min: number | null }[],
      preferences: prefs as { handler_id: string; candidate_key: string; candidate_id: string | null }[],
      weeklyNightCounts: weekly,
    });
    setProposal(result);
  });

  const apply = () => run("apply", async () => {
    await rpc("set_assignments", { p_team: s.teamId, p_items: proposal!.map((p) => ({ interview_id: p.interview_id, handler_id: p.handler_id, mode: p.mode })) });
    setProposal(null);
    day.reload();
  }, "Assignments saved");

  const assignOne = (id: string, handler: string) => run("one" + id, async () => {
    await rpc("set_assignments", { p_team: s.teamId, p_items: [{ interview_id: id, handler_id: handler || null, mode: "manual" }] });
    day.reload();
  });

  const previewStats = useMemo(() => {
    if (!preview) return null;
    return {
      ok: preview.filter((p) => p.parse_ok).length,
      bad: preview.filter((p) => !p.parse_ok).length,
      newCand: preview.filter((p) => p.candidate_name && masters.data && !masters.data.candidates.has(normKey(p.candidate_name))).length,
      newClient: preview.filter((p) => p.client_name && masters.data && !masters.data.clients.has(normKey(p.client_name))).length,
    };
  }, [preview, masters.data]);

  if (!s.isTeamAdmin) return <Empty>Only team admins can load interview days.</Empty>;

  return (
    <>
      <PageHeader title="Day Intake" subtitle="Paste the day's interview list, review the parse, save, then auto-assign handlers."
        actions={<>
          <Button size="sm" onClick={() => setDate(addDays(date, -1))}>←</Button>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          <Button size="sm" onClick={() => setDate(addDays(date, 1))}>→</Button>
        </>} />

      <div className="grid gap-4 xl:grid-cols-5">
        <Card title={`Paste interviews · ${prettyDate(date)}`} className="xl:col-span-2"
          actions={closed ? <Badge v="completed">Day closed</Badge> : null}>
          <textarea value={text} onChange={(e) => setText(e.target.value)} disabled={closed}
            placeholder={"One interview per line, e.g.\nMeghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (2nd Round)"}
            className="h-64 w-full rounded-md p-2.5 font-mono text-xs ring-1 ring-slate-300 outline-none focus:ring-2 focus:ring-indigo-500 disabled:bg-slate-50" />
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <Button variant="primary" onClick={parse} disabled={!text.trim() || closed}>Parse</Button>
            <label className="flex items-center gap-1.5 text-xs text-slate-600">
              <input type="checkbox" checked={removeMissing} onChange={(e) => setRemoveMissing(e.target.checked)} />
              Remove saved lines that are not in this paste (untouched calls only)
            </label>
          </div>
          <p className="mt-2 text-xs text-slate-500">Re-pasting the same day is safe: identical lines are matched, not duplicated.</p>
        </Card>

        <Card title="Day status" className="xl:col-span-3">
          {day.loading ? <Loading /> : day.error ? <ErrorBox error={day.error} /> : day.data && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                <div><div className="text-xs text-slate-500">Status</div><Badge v={day.data.state.status === "completed" ? "completed" : "open"}>{day.data.state.status === "none" ? "Not started" : day.data.state.status}</Badge></div>
                <div><div className="text-xs text-slate-500">Calls</div><b className="tabular">{day.data.state.total}</b></div>
                <div><div className="text-xs text-slate-500">Unassigned</div><b className="tabular">{day.data.state.unassigned}</b></div>
                <div><div className="text-xs text-slate-500">Pending requests</div><b className="tabular">{day.data.state.pending_outcomes + day.data.state.pending_reassignments}</b></div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Button onClick={propose} busy={busy === "auto"} disabled={closed || !day.data.rows.length}>Auto-assign…</Button>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={keepExisting} onChange={(e) => setKeepExisting(e.target.checked)} /> keep existing assignments
                </label>
                <span className="flex-1" />
                {closed
                  ? <Button onClick={() => run("reopen", async () => { await rpc("reopen_work_day", { p_team: s.teamId, p_date: date }); day.reload(); }, "Day reopened")} busy={busy === "reopen"}>Reopen day</Button>
                  : <Button variant="success" disabled={!day.data.rows.length} busy={busy === "close"}
                      onClick={() => run("close", async () => {
                        const r = await rpc<{ promotions_added: number; selections_added: number }>("complete_work_day", { p_team: s.teamId, p_date: date });
                        day.reload();
                        return r;
                      }, "Day closed — incentives refreshed")}>Close day</Button>}
              </div>
              <p className="text-xs text-slate-500">Closing a day requires all requests to be reviewed, then scans for new promotions and selections.</p>
            </div>
          )}
        </Card>
      </div>

      {preview && previewStats && (
        <Card className="mt-4" pad={false} title={`Preview — ${preview.length} lines`}
          actions={<>
            <span className="text-xs text-slate-500">{previewStats.ok} ok · <span className={previewStats.bad ? "text-rose-600" : ""}>{previewStats.bad} need review</span> · {previewStats.newCand} new candidates · {previewStats.newClient} new clients</span>
            <Button size="sm" onClick={() => setPreview(null)}>Discard</Button>
            <Button size="sm" variant="primary" busy={busy === "save"} onClick={save}>Save {preview.length} lines</Button>
          </>}>
          <Table head={["#", "Candidate", "Client", "Role", "Round", "Time", "Dur.", "Note"]} dense>
            {preview.map((p, i) => (
              <tr key={i} className={p.parse_ok ? "" : "bg-rose-50/60"}>
                <Td className="text-slate-400 tabular">{i + 1}</Td>
                <Td>{p.candidate_name ?? "—"} {p.location_tag && <span className="text-xs text-slate-400">({p.location_tag})</span>}
                  {p.candidate_name && masters.data && !masters.data.candidates.has(normKey(p.candidate_name)) && <span className="ml-1"><Badge v="pending">new</Badge></span>}</Td>
                <Td>{p.client_name ?? "—"}{p.client_name && masters.data && !masters.data.clients.has(normKey(p.client_name)) && <span className="ml-1"><Badge v="pending">new</Badge></span>}</Td>
                <Td className="text-xs text-slate-500">{p.job_role}</Td>
                <Td className="whitespace-nowrap">{p.round_label ?? "—"}</Td>
                <Td className="whitespace-nowrap tabular">{p.time_label ?? "—"} {p.is_night && <Badge v="night">Night</Badge>}</Td>
                <Td className="tabular">{p.duration_min ?? "—"}</Td>
                <Td className="text-xs text-rose-600">{p.parse_note}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      {day.data && day.data.rows.length > 0 && (
        <Card className="mt-4" pad={false} title={`Saved calls · ${prettyDate(date)}`}>
          <Table head={["Time", "Candidate", "Client", "Round", "Handler", "Mode", "Outcome"]} dense>
            {day.data.rows.slice().sort((a, b) => (a.start_min ?? 1e9) - (b.start_min ?? 1e9)).map((r) => (
              <tr key={r.id} className={r.parse_ok ? "" : "bg-rose-50/40"}>
                <Td className="whitespace-nowrap tabular">{r.time_label ?? "—"} {r.is_night && <Badge v="night">Night</Badge>}</Td>
                <Td>{r.candidate_name ?? <span className="text-xs text-rose-600" title={r.raw_text}>unparsed</span>}</Td>
                <Td>{r.client_name}</Td>
                <Td className="whitespace-nowrap">{r.round_label}</Td>
                <Td>
                  <Select value={r.handler_id ?? ""} disabled={closed || r.outcome !== "scheduled" || busy === "one" + r.id}
                    onChange={(e) => assignOne(r.id, e.target.value)} className="py-1 text-xs">
                    <option value="">{r.assignment_mode === "support" ? "Support" : "— Unassigned —"}</option>
                    {s.handlers.filter((h) => h.active || h.id === r.handler_id).map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                  </Select>
                </Td>
                <Td className="text-xs text-slate-500">{r.assignment_mode}</Td>
                <Td><Badge v={r.outcome} /></Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}

      <Modal open={!!proposal} onClose={() => setProposal(null)} title="Proposed assignments" wide
        footer={<><Button onClick={() => setProposal(null)}>Cancel</Button><Button variant="primary" busy={busy === "apply"} onClick={apply}>Apply {proposal?.length ?? 0}</Button></>}>
        {proposal && proposal.length === 0 ? <Empty>Nothing to assign — every call is locked or already assigned.</Empty> : (
          <div className="max-h-[60vh] overflow-y-auto">
            <Table head={["Time", "Candidate", "Handler", "Why"]} dense>
              {proposal?.slice().sort((a, b) => (day.data?.rows.find((x) => x.id === a.interview_id)?.start_min ?? 1e9) - (day.data?.rows.find((x) => x.id === b.interview_id)?.start_min ?? 1e9)).map((p) => {
                const r = day.data?.rows.find((x) => x.id === p.interview_id);
                return (
                  <tr key={p.interview_id}>
                    <Td className="whitespace-nowrap tabular">{r?.time_label}</Td><Td>{r?.candidate_name}</Td>
                    <Td>{p.handler_id ? s.handlerName(p.handler_id) : <Badge v="support">Support</Badge>}</Td>
                    <Td className="text-xs text-slate-500"><Badge v={p.mode === "preferred" ? "selected" : p.mode === "fallback" ? "pending" : p.mode === "support" ? "support" : "open"}>{p.mode}</Badge> {p.reason}</Td>
                  </tr>
                );
              })}
            </Table>
          </div>
        )}
      </Modal>
    </>
  );
}
