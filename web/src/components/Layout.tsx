import { useState, type ReactNode } from "react";
import { supabase, q } from "../lib/supabase";
import { useSession, useRolesList, ROLE_LABEL } from "../lib/session";
import { cx, Select } from "./ui";
import { navigate } from "../lib/router";
import type { AppRole } from "../lib/types";

const NAV: { id: string; label: string; icon: string }[] = [
  { id: "dashboard", label: "Dashboard", icon: "M3 12l9-9 9 9M5 10v10h14V10" },
  { id: "intake", label: "Day Intake", icon: "M12 4v16m8-8H4" },
  { id: "schedule", label: "Call Schedule", icon: "M8 7V3m8 4V3M4 11h16M5 5h14a1 1 0 011 1v14a1 1 0 01-1 1H5a1 1 0 01-1-1V6a1 1 0 011-1z" },
  { id: "approvals", label: "Approvals", icon: "M9 12l2 2 4-4M7 4h10a2 2 0 012 2v14l-7-3-7 3V6a2 2 0 012-2z" },
  { id: "interviews", label: "Interviews", icon: "M17 20h5v-2a3 3 0 00-5.4-1.8M9 20H2v-2a3 3 0 015.4-1.8M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" },
  { id: "incentives", label: "Incentive Tracker", icon: "M12 8c-2 0-3 .9-3 2s1 2 3 2 3 .9 3 2-1 2-3 2m0-8V6m0 10v2M4 12a8 8 0 1016 0 8 8 0 00-16 0z" },
  { id: "promotions", label: "Promotions", icon: "M5 10l7-7 7 7M12 3v18" },
  { id: "monthly", label: "Monthly Summary", icon: "M4 19h16M7 16V9m5 7V5m5 11v-4" },
  { id: "recovery", label: "Recovery", icon: "M4 4v6h6M20 20v-6h-6M5.5 15a7 7 0 0012.2 2.5M18.5 9A7 7 0 006.3 6.5" },
  { id: "identity", label: "Identity Mapping", icon: "M16 7a4 4 0 11-8 0 4 4 0 018 0zM4 21a8 8 0 0116 0" },
  { id: "reports", label: "Reports", icon: "M9 17v-6m4 6V7m4 10v-3M5 21h14a1 1 0 001-1V4a1 1 0 00-1-1H5a1 1 0 00-1 1v16a1 1 0 001 1z" },
  { id: "admin", label: "Administration", icon: "M10.3 4.3a1.7 1.7 0 013.4 0 1.7 1.7 0 002.6 1.1 1.7 1.7 0 012.4 2.4 1.7 1.7 0 001 2.6 1.7 1.7 0 010 3.4 1.7 1.7 0 00-1 2.6 1.7 1.7 0 01-2.4 2.4 1.7 1.7 0 00-2.6 1 1.7 1.7 0 01-3.4 0 1.7 1.7 0 00-2.6-1 1.7 1.7 0 01-2.4-2.4 1.7 1.7 0 00-1-2.6 1.7 1.7 0 010-3.4 1.7 1.7 0 001-2.6 1.7 1.7 0 012.4-2.4 1.7 1.7 0 002.6-1.1zM12 15a3 3 0 100-6 3 3 0 000 6z" },
  { id: "health", label: "Data Health", icon: "M3 12h4l3 8 4-16 3 8h4" },
  { id: "audit", label: "Audit Log", icon: "M12 8v4l3 3M21 12a9 9 0 11-18 0 9 9 0 0118 0z" },
];

export function Layout({ page, children }: { page: string; children: ReactNode }) {
  const s = useSession();
  const roles = useRolesList();
  const realSuper = (s.realCtx?.roles ?? []).some((r) => r.role === "SUPER_ADMIN");
  const [users, setUsers] = useState<{ id: string; official_name: string; email: string }[] | null>(null);
  const loadUsers = async () => { if (!users) setUsers((await q(supabase.from("app_users").select("id,official_name,email").eq("active", true).order("official_name"))) as never); };
  return (
    <div className="flex h-full flex-col">
    {s.readOnly && (
      <div className="flex items-center justify-center gap-3 bg-amber-400 px-4 py-1.5 text-sm text-amber-950">
        Previewing as <b>{s.ctx?.user?.name}</b> ({s.ctx?.user?.email}) — read-only
        <button className="rounded bg-amber-950/10 px-2 py-0.5 font-medium hover:bg-amber-950/20" onClick={s.stopPreview}>Exit preview</button>
      </div>
    )}
    <div className="flex min-h-0 flex-1">
      <aside className="hidden w-56 shrink-0 flex-col bg-slate-900 text-slate-300 md:flex">
        <div className="px-4 py-4">
          <div className="text-sm font-semibold text-white">Interview Portal</div>
          <div className="text-xs text-slate-400">Calls · Incentives</div>
        </div>
        <nav className="flex-1 space-y-0.5 px-2">
          {NAV.filter((n) => s.canSee(n.id)).map((n) => (
            <a key={n.id} href={`#/${n.id}`}
              className={cx("flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm", page === n.id ? "bg-slate-800 text-white" : "hover:bg-slate-800/60 hover:text-white")}>
              <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" viewBox="0 0 24 24"><path d={n.icon} /></svg>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="border-t border-slate-800 p-3 text-xs">
          <div className="truncate text-slate-200">{s.ctx?.user?.name}</div>
          <div className="truncate text-slate-500">{s.ctx?.user?.email}</div>
          <button onClick={s.signOut} className="mt-2 text-slate-400 hover:text-white">Sign out</button>
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
          <Select className="md:hidden" value={page} onChange={(e) => navigate(e.target.value)}>
            {NAV.filter((n) => s.canSee(n.id)).map((n) => <option key={n.id} value={n.id}>{n.label}</option>)}
          </Select>
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-sm">
            {s.teams.length > 0 && (
              <label className="flex items-center gap-1.5 text-slate-500"><span className="hidden sm:inline">Team</span>
                <Select value={s.teamId ?? ""} onChange={(e) => s.setTeamId(e.target.value)}>
                  {s.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </Select>
              </label>
            )}
            {roles.length > 1 && (
              <label className="flex items-center gap-1.5 text-slate-500"><span className="hidden sm:inline">Acting as</span>
                <Select value={s.role ?? ""} onChange={(e) => s.setRole(e.target.value as AppRole)}>
                  {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </Select>
              </label>
            )}
            {roles.length === 1 && s.role && <span className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-600">{ROLE_LABEL[s.role]}</span>}
            {realSuper && !s.readOnly && (
              <Select value="" onFocus={loadUsers} onMouseDown={loadUsers} onChange={(e) => e.target.value && s.startPreview(e.target.value)} className="max-w-40 text-xs">
                <option value="">View as…</option>
                {(users ?? []).map((u) => <option key={u.id} value={u.id}>{u.official_name} · {u.email}</option>)}
              </Select>
            )}
            <button onClick={s.signOut} className="text-xs text-slate-500 md:hidden">Sign out</button>
          </div>
        </header>
        <main className="min-w-0 flex-1 overflow-y-auto p-4 md:p-6">{children}</main>
      </div>
    </div>
    </div>
  );
}
