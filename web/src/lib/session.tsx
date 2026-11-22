import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, rpc, q, cleanAuthParams } from "./supabase";
import type { AppRole, Handler, MyContext, RoleAssignment } from "./types";
import { setReadOnly } from "./readonly";

// Page access per role — mirrors PAC_navigation_() in PortalAccessControl.gs
export const PAGES: Record<AppRole, string[]> = {
  SUPER_ADMIN: ["dashboard", "intake", "schedule", "approvals", "interviews", "incentives", "promotions", "monthly", "recovery", "identity", "reports", "health", "admin", "audit"],
  ADMIN: ["dashboard", "intake", "schedule", "approvals", "interviews", "incentives", "promotions", "monthly", "recovery", "identity", "reports", "health", "admin", "audit"],
  HANDLER: ["dashboard", "schedule", "interviews", "incentives", "promotions", "monthly", "recovery", "identity", "reports"],
  SETUP_SUPPORT: ["dashboard", "schedule", "reports"],
  TECH_SUPPORT: ["dashboard", "schedule", "reports"],
};
export const ROLE_LABEL: Record<AppRole, string> = {
  SUPER_ADMIN: "Super Admin", ADMIN: "Admin", HANDLER: "Handler", SETUP_SUPPORT: "Setup Support", TECH_SUPPORT: "Technical Support",
};
const ROLE_ORDER: AppRole[] = ["SUPER_ADMIN", "ADMIN", "HANDLER", "SETUP_SUPPORT", "TECH_SUPPORT"];

interface SessionState {
  session: Session | null;
  loading: boolean;
  ctx: MyContext | null;
  role: AppRole | null;
  setRole: (r: AppRole) => void;
  teamId: string | null;
  setTeamId: (t: string) => void;
  teams: { id: string; name: string }[];
  handlers: Handler[];            // handlers of the current team
  handlerName: (id: string | null | undefined) => string;
  myHandlerIds: string[];
  isSuper: boolean;
  isTeamAdmin: boolean;           // current role can administer the current team
  canSee: (page: string) => boolean;
  refreshContext: () => Promise<void>;
  readOnly: boolean;                       // previewing another user (view-as)
  realCtx: MyContext | null;
  startPreview: (userId: string) => Promise<void>;
  stopPreview: () => void;
  refreshHandlers: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [realCtx, setCtx] = useState<MyContext | null>(null);
  const [preview, setPreview] = useState<MyContext | null>(null);
  const ctx = preview ?? realCtx;
  const [role, setRoleState] = useState<AppRole | null>(() => (localStorageGet("portal.role") as AppRole) || null);
  const [teamId, setTeamState] = useState<string | null>(() => localStorageGet("portal.team"));
  const [handlers, setHandlers] = useState<Handler[]>([]);
  const [allHandlers, setAllHandlers] = useState<Handler[]>([]);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); if (!data.session) setLoading(false); });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); if (s) cleanAuthParams(); if (!s) { setCtx(null); setLoading(false); } });
    return () => sub.subscription.unsubscribe();
  }, []);

  const refreshContext = useCallback(async () => {
    let c = await rpc<MyContext>("my_context");
    if (!c.linked && c.needs_link) c = await rpc<MyContext>("claim_my_account");
    setCtx(c);
    setLoading(false);
  }, []);

  useEffect(() => { if (session) refreshContext().catch(() => setLoading(false)); }, [session, refreshContext]);

  const roles: RoleAssignment[] = ctx?.roles ?? [];
  const distinctRoles = ROLE_ORDER.filter((r) => roles.some((x) => x.role === r));
  const effectiveRole: AppRole | null = role && distinctRoles.includes(role) ? role : distinctRoles[0] ?? null;
  const isSuper = roles.some((r) => r.role === "SUPER_ADMIN");
  useEffect(() => { setReadOnly(!!preview); }, [preview]);

  // Teams the current role can act on
  const teams = useMemo(() => {
    const all = ctx?.teams ?? [];
    if (effectiveRole === "SUPER_ADMIN") return all;
    const ids = new Set(roles.filter((r) => r.role === effectiveRole).map((r) => r.team_id ?? ctx?.user?.primary_team_id));
    return all.filter((t) => ids.has(t.id));
  }, [ctx, roles, effectiveRole]);
  const effectiveTeam = teamId && teams.some((t) => t.id === teamId) ? teamId : teams[0]?.id ?? null;

  const refreshHandlers = useCallback(async () => {
    if (!session) return;
    const rows = await q(supabase.from("handlers").select("*").order("sort_order").order("name"));
    setAllHandlers(rows as Handler[]);
  }, [session]);
  useEffect(() => { if (realCtx?.linked) refreshHandlers().catch(() => {}); }, [realCtx, refreshHandlers]);
  useEffect(() => { setHandlers(allHandlers.filter((h) => h.team_id === effectiveTeam)); }, [allHandlers, effectiveTeam]);

  const value: SessionState = {
    session, loading, ctx,
    role: effectiveRole,
    setRole: (r) => { localStorageSet("portal.role", r); setRoleState(r); },
    teamId: effectiveTeam,
    setTeamId: (t) => { localStorageSet("portal.team", t); setTeamState(t); },
    teams,
    handlers,
    handlerName: (id) => (id ? allHandlers.find((h) => h.id === id)?.name ?? id : "—"),
    myHandlerIds: roles.filter((r) => r.role === "HANDLER" && r.handler_id).map((r) => r.handler_id!) ,
    isSuper,
    isTeamAdmin: effectiveRole === "SUPER_ADMIN" || (effectiveRole === "ADMIN" && roles.some((r) => r.role === "ADMIN" && r.team_id === effectiveTeam)),
    canSee: (page) => !!effectiveRole && PAGES[effectiveRole].includes(page),
    refreshContext, refreshHandlers,
    readOnly: !!preview,
    realCtx,
    startPreview: async (userId) => { const c = await rpc<MyContext>("preview_context", { p_user: userId }); setPreview(c); setRoleState(null); setTeamState(null); },
    stopPreview: () => { setPreview(null); setRoleState(null); setTeamState(null); },
    signOut: async () => { await supabase.auth.signOut(); },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("useSession outside provider");
  return v;
}

export function useRolesList(): AppRole[] {
  const { ctx } = useSession();
  return ROLE_ORDER.filter((r) => (ctx?.roles ?? []).some((x) => x.role === r));
}

// browser storage can throw (private mode / sandboxed frames)
function localStorageGet(k: string): string | null { try { return localStorage.getItem(k); } catch { return null; } }
function localStorageSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }
