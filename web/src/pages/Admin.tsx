import { useState } from "react";
import { supabase, q } from "../lib/supabase";
import { useSession, ROLE_LABEL } from "../lib/session";
import { todayWorkDate, prettyDate, inr } from "../lib/format";
import { formatMinutes, operationalMinutes } from "@shared/parser";
import { Button, Card, PageHeader, Input, Table, Td, Badge, Loading, ErrorBox, Empty, Tabs, Select, Modal, Field, useAsync, useAction } from "../components/ui";
import type { AppRole, AppUser, Handler, Team, UserRoleRow } from "../lib/types";

type Tab = "users" | "handlers" | "preferences" | "leaves" | "rules" | "teams";

export function Admin() {
  const s = useSession();
  const tabs: { id: Tab; label: string }[] = [
    ...(s.isSuper && s.role === "SUPER_ADMIN" ? [{ id: "users" as Tab, label: "Users & Roles" }] : []),
    { id: "handlers", label: "Handlers" }, { id: "preferences", label: "Preference Lists" }, { id: "leaves", label: "Leave" },
    ...(s.isSuper && s.role === "SUPER_ADMIN" ? [{ id: "rules" as Tab, label: "Incentive Amounts" }, { id: "teams" as Tab, label: "Teams" }] : []),
  ];
  const [tab, setTab] = useState<Tab>(tabs[0].id);
  if (!s.isTeamAdmin) return <Empty>Administration is for admins.</Empty>;
  return (
    <>
      <PageHeader title="Administration" subtitle={s.teams.find((t) => t.id === s.teamId)?.name} />
      <Tabs value={tab} onChange={setTab} items={tabs} />
      {tab === "users" && <Users />}
      {tab === "handlers" && <Handlers />}
      {tab === "preferences" && <Preferences />}
      {tab === "leaves" && <Leaves />}
      {tab === "rules" && <Rules />}
      {tab === "teams" && <Teams />}
    </>
  );
}

// ------------------------------------------------------------------ Users
function Users() {
  const s = useSession();
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<Partial<AppUser> | null>(null);
  const [roleDraft, setRoleDraft] = useState<{ user_id: string; role: AppRole; team_id: string; handler_id: string } | null>(null);
  const [filter, setFilter] = useState("");
  const data = useAsync(async () => {
    const [users, roles, teams, handlers] = await Promise.all([
      q(supabase.from("app_users").select("*").order("official_name")),
      q(supabase.from("user_roles").select("*")),
      q(supabase.from("teams").select("*").order("name")),
      q(supabase.from("handlers").select("*").order("name")),
    ]);
    return { users: users as AppUser[], roles: roles as UserRoleRow[], teams: teams as Team[], handlers: handlers as Handler[] };
  }, []);

  const saveUser = () => run("u", async () => {
    const row = { email: edit!.email!.trim().toLowerCase(), official_name: edit!.official_name!.trim(), primary_team_id: edit!.primary_team_id || null, active: edit!.active ?? true, notes: edit!.notes ?? null };
    if (edit!.id) await q(supabase.from("app_users").update(row).eq("id", edit!.id).select());
    else await q(supabase.from("app_users").insert(row).select());
    setEdit(null); data.reload();
  }, "User saved");
  const addRole = () => run("r", async () => {
    const r = roleDraft!;
    await q(supabase.from("user_roles").insert({ user_id: r.user_id, role: r.role, team_id: r.role === "SUPER_ADMIN" ? null : r.team_id || null, handler_id: r.role === "HANDLER" ? r.handler_id || null : null }).select());
    setRoleDraft(null); data.reload();
  }, "Role added");
  const toggleRole = (r: UserRoleRow) => run("t" + r.id, async () => { await q(supabase.from("user_roles").update({ active: !r.active }).eq("id", r.id).select()); data.reload(); });

  if (data.loading) return <Loading />;
  if (data.error) return <ErrorBox error={data.error} />;
  const d = data.data!;
  const users = d.users.filter((u) => !filter || (u.email + u.official_name).toLowerCase().includes(filter.toLowerCase()));
  return (
    <Card pad={false} title={`${d.users.length} users`} actions={<>
      <Input placeholder="Search" value={filter} onChange={(e) => setFilter(e.target.value)} />
      <Button variant="primary" size="sm" onClick={() => setEdit({ active: true, primary_team_id: s.teamId })}>Add user</Button></>}>
      <Table head={["Name", "Email", "Team", "Roles", "Login", ""]}>
        {users.map((u) => (
          <tr key={u.id} className={u.active ? "" : "opacity-50"}>
            <Td className="font-medium">{u.official_name}</Td>
            <Td className="text-xs">{u.email}</Td>
            <Td className="text-xs">{d.teams.find((t) => t.id === u.primary_team_id)?.name ?? "—"}</Td>
            <Td>
              <div className="flex flex-wrap gap-1">
                {d.roles.filter((r) => r.user_id === u.id).map((r) => (
                  <button key={r.id} onClick={() => toggleRole(r)} title={r.active ? "Click to deactivate" : "Click to activate"}
                    className={r.active ? "" : "line-through opacity-50"}>
                    <Badge v={r.role === "SUPER_ADMIN" ? "selected" : r.role === "ADMIN" ? "promotion" : "in_progress"}>
                      {ROLE_LABEL[r.role]}{r.team_id ? ` · ${r.team_id.replace("TEAM-", "")}` : ""}{r.handler_id ? ` · ${d.handlers.find((h) => h.id === r.handler_id)?.name ?? r.handler_id}` : ""}
                    </Badge>
                  </button>
                ))}
                <button className="text-xs text-indigo-600 hover:underline" onClick={() => setRoleDraft({ user_id: u.id, role: "HANDLER", team_id: u.primary_team_id ?? "", handler_id: "" })}>+ role</button>
              </div>
            </Td>
            <Td>{u.auth_user_id ? <Badge v="approved">Signed in</Badge> : <Badge v="in_progress">Never</Badge>}</Td>
            <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(u)}>Edit</Button></Td>
          </tr>
        ))}
      </Table>

      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? "Edit user" : "Add user"}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy === "u"} disabled={!edit?.email || !edit?.official_name} onClick={saveUser}>Save</Button></>}>
        <Field label="Email (login)"><Input className="w-full" value={edit?.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
        <Field label="Official name"><Input className="w-full" value={edit?.official_name ?? ""} onChange={(e) => setEdit({ ...edit, official_name: e.target.value })} /></Field>
        <Field label="Primary team"><Select className="w-full" value={edit?.primary_team_id ?? ""} onChange={(e) => setEdit({ ...edit, primary_team_id: e.target.value })}>
          <option value="">—</option>{d.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit?.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
        {!edit?.id && <p className="text-xs text-slate-500">After saving, add a role. The person signs in with this email using a one-time code.</p>}
      </Modal>

      <Modal open={!!roleDraft} onClose={() => setRoleDraft(null)} title="Add role"
        footer={<><Button onClick={() => setRoleDraft(null)}>Cancel</Button><Button variant="primary" busy={busy === "r"} disabled={!roleDraft || (roleDraft.role !== "SUPER_ADMIN" && !roleDraft.team_id) || (roleDraft.role === "HANDLER" && !roleDraft.handler_id)} onClick={addRole}>Add</Button></>}>
        {roleDraft && <>
          <Field label="Role"><Select className="w-full" value={roleDraft.role} onChange={(e) => setRoleDraft({ ...roleDraft, role: e.target.value as AppRole })}>
            {(Object.keys(ROLE_LABEL) as AppRole[]).map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}</Select></Field>
          {roleDraft.role !== "SUPER_ADMIN" && <Field label="Team"><Select className="w-full" value={roleDraft.team_id} onChange={(e) => setRoleDraft({ ...roleDraft, team_id: e.target.value, handler_id: "" })}>
            <option value="">Choose…</option>{d.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</Select></Field>}
          {roleDraft.role === "HANDLER" && <Field label="Handler identity" hint="Create the handler first under the Handlers tab if missing."><Select className="w-full" value={roleDraft.handler_id} onChange={(e) => setRoleDraft({ ...roleDraft, handler_id: e.target.value })}>
            <option value="">Choose…</option>{d.handlers.filter((h) => h.team_id === roleDraft.team_id).map((h) => <option key={h.id} value={h.id}>{h.name} ({h.id})</option>)}</Select></Field>}
        </>}
      </Modal>
    </Card>
  );
}

// ------------------------------------------------------------------ Handlers
function Handlers() {
  const s = useSession();
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<Partial<Handler> | null>(null);
  const save = () => run("h", async () => {
    const row = {
      name: edit!.name!.trim(), team_id: s.teamId!, email: edit!.email || null,
      aliases: typeof edit!.aliases === "string" ? (edit!.aliases as string).split(",").map((a) => a.trim()).filter(Boolean) : edit!.aliases ?? [],
      active: edit!.active ?? true, in_auto_pool: edit!.in_auto_pool ?? true, is_fallback: edit!.is_fallback ?? false,
      night_eligible: edit!.night_eligible ?? true, sort_order: Number(edit!.sort_order ?? 100), notes: edit!.notes ?? null,
    };
    if (edit!.id) await q(supabase.from("handlers").update(row).eq("id", edit!.id).select());
    else await q(supabase.from("handlers").insert(row).select());
    setEdit(null); await s.refreshHandlers();
  }, "Handler saved");

  return (
    <Card pad={false} title={`${s.handlers.length} handlers`} actions={<Button size="sm" variant="primary" onClick={() => setEdit({ active: true, in_auto_pool: true, night_eligible: true, sort_order: 100 })}>Add handler</Button>}>
      {s.handlers.length === 0 ? <Empty>No handlers in this team.</Empty> : (
        <Table head={["ID", "Name", "Aliases", "Auto-assign", "Night", "Order", "Status", ""]}>
          {s.handlers.map((h) => (
            <tr key={h.id} className={h.active ? "" : "opacity-50"}>
              <Td className="font-mono text-xs">{h.id}</Td><Td className="font-medium">{h.name}</Td>
              <Td className="text-xs text-slate-500">{h.aliases.join(", ")}</Td>
              <Td>{h.is_fallback ? <Badge v="pending">Fallback</Badge> : h.in_auto_pool ? <Badge v="approved">Main pool</Badge> : <Badge v="in_progress">Manual only</Badge>}</Td>
              <Td>{h.night_eligible ? "✓" : "—"}</Td><Td className="tabular">{h.sort_order}</Td>
              <Td><Badge v={h.active ? "approved" : "rejected"}>{h.active ? "Active" : "Inactive"}</Badge></Td>
              <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit({ ...h })}>Edit</Button></Td>
            </tr>
          ))}
        </Table>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? `Edit ${edit.name}` : "Add handler"}
        footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy === "h"} disabled={!edit?.name} onClick={save}>Save</Button></>}>
        <Field label="Name (as used in schedules)"><Input className="w-full" value={edit?.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Email"><Input className="w-full" value={edit?.email ?? ""} onChange={(e) => setEdit({ ...edit, email: e.target.value })} /></Field>
        <Field label="Other spellings (comma separated)"><Input className="w-full" value={Array.isArray(edit?.aliases) ? edit!.aliases.join(", ") : (edit?.aliases as unknown as string) ?? ""}
          onChange={(e) => setEdit({ ...edit, aliases: e.target.value as unknown as string[] })} /></Field>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit?.in_auto_pool ?? true} onChange={(e) => setEdit({ ...edit, in_auto_pool: e.target.checked })} /> In auto-assign pool</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit?.is_fallback ?? false} onChange={(e) => setEdit({ ...edit, is_fallback: e.target.checked })} /> Fallback (when all busy)</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit?.night_eligible ?? true} onChange={(e) => setEdit({ ...edit, night_eligible: e.target.checked })} /> Takes night calls</label>
          <label className="flex items-center gap-2"><input type="checkbox" checked={edit?.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
        </div>
        <Field label="Order (lower = earlier tie-break)"><Input type="number" value={edit?.sort_order ?? 100} onChange={(e) => setEdit({ ...edit, sort_order: Number(e.target.value) })} /></Field>
      </Modal>
    </Card>
  );
}

// ------------------------------------------------------------------ Preferences
function Preferences() {
  const s = useSession();
  const { busy, run } = useAction();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const data = useAsync(async () => (await q(supabase.from("handler_preferences").select("*").eq("team_id", s.teamId!).order("candidate_label"))) as { id: string; handler_id: string; candidate_label: string }[], [s.teamId]);
  const add = (hid: string) => run("p" + hid, async () => {
    await q(supabase.from("handler_preferences").insert({ team_id: s.teamId, handler_id: hid, candidate_label: draft[hid].trim() }).select());
    setDraft({ ...draft, [hid]: "" }); data.reload();
  });
  const del = (id: string) => run("d" + id, async () => { await q(supabase.from("handler_preferences").delete().eq("id", id).select()); data.reload(); });
  if (data.loading) return <Loading />;
  return (
    <>
      <p className="mb-3 text-sm text-slate-500">Candidates on a handler's list are auto-assigned to that handler when free (fuzzy name match, ≥ 70%).</p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {s.handlers.filter((h) => h.active).map((h) => (
          <Card key={h.id} title={h.name}>
            <ul className="mb-2 space-y-1 text-sm">
              {(data.data ?? []).filter((p) => p.handler_id === h.id).map((p) => (
                <li key={p.id} className="flex items-center justify-between"><span>{p.candidate_label}</span>
                  <button className="text-xs text-slate-400 hover:text-rose-600" disabled={busy === "d" + p.id} onClick={() => del(p.id)}>remove</button></li>
              ))}
            </ul>
            <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (draft[h.id]?.trim()) add(h.id); }}>
              <Input placeholder="Add candidate" value={draft[h.id] ?? ""} onChange={(e) => setDraft({ ...draft, [h.id]: e.target.value })} className="flex-1" />
              <Button size="sm" busy={busy === "p" + h.id}>Add</Button>
            </form>
          </Card>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ Leaves
function Leaves() {
  const s = useSession();
  const { busy, run } = useAction();
  const [f, setF] = useState({ handler_id: "", leave_date: todayWorkDate(), from: "", to: "", reason: "" });
  const ids = s.handlers.map((h) => h.id);
  const data = useAsync(async () => (await q(supabase.from("handler_leaves").select("*").in("handler_id", ids.length ? ids : ["-"]).gte("leave_date", todayWorkDate()).order("leave_date"))) as { id: string; handler_id: string; leave_date: string; start_min: number | null; end_min: number | null; reason: string | null }[], [s.teamId, ids.join()]);
  const add = () => run("l", async () => {
    const start = f.from ? operationalMinutes(f.from) : null;
    const end = f.to ? operationalMinutes(f.to) : null;
    await q(supabase.from("handler_leaves").insert({ handler_id: f.handler_id, leave_date: f.leave_date, start_min: start, end_min: end, reason: f.reason || null }).select());
    data.reload();
  }, "Leave added");
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card title="Add leave / busy slot">
        <div className="space-y-3">
          <Field label="Handler"><Select className="w-full" value={f.handler_id} onChange={(e) => setF({ ...f, handler_id: e.target.value })}><option value="">Choose…</option>{s.handlers.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}</Select></Field>
          <Field label="Working date"><Input type="date" value={f.leave_date} onChange={(e) => setF({ ...f, leave_date: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-2">
            <Field label="From (blank = all day)"><Input placeholder="e.g. 9:00 PM" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
            <Field label="To"><Input placeholder="e.g. 1:00 AM" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
          </div>
          <Field label="Reason"><Input className="w-full" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
          <Button variant="primary" disabled={!f.handler_id} busy={busy === "l"} onClick={add}>Add</Button>
        </div>
      </Card>
      <Card title="Upcoming" pad={false} className="lg:col-span-2">
        {data.loading ? <Loading /> : !data.data?.length ? <Empty>No upcoming leave.</Empty> : (
          <Table head={["Date", "Handler", "When", "Reason", ""]} dense>
            {data.data.map((l) => (
              <tr key={l.id}><Td>{prettyDate(l.leave_date)}</Td><Td>{s.handlerName(l.handler_id)}</Td>
                <Td>{l.start_min == null ? "All day" : `${formatMinutes(l.start_min)} – ${formatMinutes(l.end_min)}`}</Td><Td className="text-xs">{l.reason}</Td>
                <Td className="text-right"><Button size="sm" variant="ghost" busy={busy === "x" + l.id} onClick={() => run("x" + l.id, async () => { await q(supabase.from("handler_leaves").delete().eq("id", l.id).select()); data.reload(); })}>Remove</Button></Td></tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ Rules
function Rules() {
  const { busy, run } = useAction();
  const data = useAsync(async () => (await q(supabase.from("incentive_rules").select("*").order("rule"))) as { id: string; team_id: string | null; rule: string; amount: number }[], []);
  const [vals, setVals] = useState<Record<string, string>>({});
  const label: Record<string, string> = { first_promotion: "1st round → any higher round", promotion: "2nd+ round → any higher round", selection: "Candidate selected" };
  return (
    <Card title="Incentive amounts" className="max-w-xl">
      {data.loading ? <Loading /> : (
        <div className="space-y-3">
          {(data.data ?? []).map((r) => (
            <div key={r.id} className="flex items-center gap-3">
              <div className="flex-1 text-sm">{label[r.rule] ?? r.rule}<span className="ml-1 text-xs text-slate-400">{r.team_id ?? "all teams"}</span></div>
              <Input type="number" className="w-28" value={vals[r.id] ?? String(r.amount)} onChange={(e) => setVals({ ...vals, [r.id]: e.target.value })} />
              <Button size="sm" disabled={vals[r.id] == null || Number(vals[r.id]) === Number(r.amount)} busy={busy === r.id}
                onClick={() => run(r.id, async () => { await q(supabase.from("incentive_rules").update({ amount: Number(vals[r.id]), updated_at: new Date().toISOString() }).eq("id", r.id).select()); data.reload(); }, `Saved ${inr(Number(vals[r.id]))}`)}>Save</Button>
            </div>
          ))}
          <p className="text-xs text-slate-500">New amounts apply to incentives found from now on; existing ledger rows keep their amount.</p>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ Teams
function Teams() {
  const s = useSession();
  const { busy, run } = useAction();
  const [edit, setEdit] = useState<Partial<Team> | null>(null);
  const data = useAsync(async () => (await q(supabase.from("teams").select("*").order("name"))) as Team[], []);
  const save = () => run("t", async () => {
    const row = { id: edit!.id!.trim().toUpperCase(), name: edit!.name!.trim(), support_mode: edit!.support_mode ?? "SETUP_SUPPORT", require_identity: edit!.require_identity ?? true, active: edit!.active ?? true, notes: edit!.notes ?? null };
    await q(supabase.from("teams").upsert(row).select());
    setEdit(null); data.reload(); await s.refreshContext();
  }, "Team saved");
  return (
    <Card pad={false} title="Teams" actions={<Button size="sm" variant="primary" onClick={() => setEdit({ id: "TEAM-", active: true, support_mode: "SETUP_SUPPORT", require_identity: true })}>Add team</Button>}>
      {data.loading ? <Loading /> : (
        <Table head={["ID", "Name", "Support mode", "Identity check", "Status", ""]}>
          {(data.data ?? []).map((t) => (
            <tr key={t.id}><Td className="font-mono text-xs">{t.id}</Td><Td className="font-medium">{t.name}</Td><Td className="text-xs">{t.support_mode}</Td>
              <Td className="text-xs">{t.require_identity ? "Required" : "Off"}</Td>
              <Td><Badge v={t.active ? "approved" : "rejected"}>{t.active ? "Active" : "Inactive"}</Badge></Td>
              <Td className="text-right"><Button size="sm" variant="ghost" onClick={() => setEdit(t)}>Edit</Button></Td></tr>
          ))}
        </Table>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title="Team" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" busy={busy === "t"} disabled={!edit?.id || !edit?.name} onClick={save}>Save</Button></>}>
        <Field label="Team ID"><Input className="w-full" value={edit?.id ?? ""} onChange={(e) => setEdit({ ...edit, id: e.target.value })} /></Field>
        <Field label="Name"><Input className="w-full" value={edit?.name ?? ""} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
        <Field label="Support mode"><Select className="w-full" value={edit?.support_mode ?? "SETUP_SUPPORT"} onChange={(e) => setEdit({ ...edit, support_mode: e.target.value })}>
          <option value="SETUP_SUPPORT">Setup support</option><option value="SELF_SUPPORT">Self support</option></Select></Field>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit?.require_identity ?? true} onChange={(e) => setEdit({ ...edit, require_identity: e.target.checked })} /> Handlers must map candidate &amp; client before submitting an outcome</label>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={edit?.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active</label>
      </Modal>
    </Card>
  );
}
