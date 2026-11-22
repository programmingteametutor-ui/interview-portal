import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from "react";
import { errorText } from "../lib/supabase";
import { isReadOnly } from "../lib/readonly";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");
export { cx };

// ---------- Buttons ----------
type Variant = "primary" | "secondary" | "ghost" | "danger" | "success";
const V: Record<Variant, string> = {
  primary: "bg-indigo-600 text-white hover:bg-indigo-700 shadow-sm",
  secondary: "bg-white text-slate-700 ring-1 ring-inset ring-slate-300 hover:bg-slate-50",
  ghost: "text-slate-600 hover:bg-slate-100",
  danger: "bg-rose-600 text-white hover:bg-rose-700 shadow-sm",
  success: "bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm",
};
export function Button({ variant = "secondary", size = "md", busy, className, children, ...p }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md"; busy?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || busy}
      className={cx("inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap",
        size === "sm" ? "px-2 py-1 text-xs" : "px-3 py-1.5 text-sm", V[variant], className)}>
      {busy && <Spinner className="h-3.5 w-3.5" />}{children}
    </button>
  );
}

// ---------- Inputs ----------
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => (
  <input {...p} className={cx("rounded-md border-0 px-2.5 py-1.5 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-500 outline-none bg-white", p.className)} />
);
export const Select = ({ className, ...p }: SelectHTMLAttributes<HTMLSelectElement>) => (
  <select {...p} className={cx("rounded-md border-0 py-1.5 pl-2.5 pr-8 text-sm ring-1 ring-inset ring-slate-300 focus:ring-2 focus:ring-indigo-500 outline-none bg-white", className)} />
);
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="block text-xs text-slate-400">{hint}</span>}
    </label>
  );
}

// ---------- Layout bits ----------
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <div className="mt-0.5 text-sm text-slate-500">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
export function Card({ title, actions, children, className, pad = true }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("rounded-lg bg-white ring-1 ring-slate-200 shadow-sm", className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </div>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}
export function Stat({ label, value, sub, tone = "slate" }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "slate" | "indigo" | "amber" | "emerald" | "rose" }) {
  const t = { slate: "text-slate-900", indigo: "text-indigo-700", amber: "text-amber-700", emerald: "text-emerald-700", rose: "text-rose-700" }[tone];
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-slate-200 shadow-sm">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className={cx("mt-1 text-2xl font-semibold tabular", t)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const BADGE: Record<string, string> = {
  scheduled: "bg-slate-100 text-slate-700", completed: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  rescheduled: "bg-amber-50 text-amber-700 ring-amber-600/20", cancelled: "bg-rose-50 text-rose-700 ring-rose-600/20",
  pending: "bg-amber-50 text-amber-700 ring-amber-600/20", approved: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  rejected: "bg-rose-50 text-rose-700 ring-rose-600/20", paid: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  selected: "bg-violet-50 text-violet-700 ring-violet-600/20", in_progress: "bg-slate-50 text-slate-600",
  on_hold: "bg-slate-100 text-slate-600", night: "bg-slate-800 text-white", open: "bg-sky-50 text-sky-700 ring-sky-600/20",
  promotion: "bg-sky-50 text-sky-700 ring-sky-600/20", selection: "bg-violet-50 text-violet-700 ring-violet-600/20",
  support: "bg-orange-50 text-orange-700 ring-orange-600/20",
};
export function Badge({ v, children }: { v: string; children?: ReactNode }) {
  return (
    <span className={cx("inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ring-transparent whitespace-nowrap", BADGE[v] ?? "bg-slate-100 text-slate-700")}>
      {children ?? v.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase())}
    </span>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <svg className={cx("animate-spin", className ?? "h-5 w-5 text-indigo-600")} viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" /><path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" /></svg>;
}
export function Loading() { return <div className="flex justify-center py-16"><Spinner /></div>; }
export function Empty({ children }: { children: ReactNode }) {
  return <div className="py-10 text-center text-sm text-slate-500">{children}</div>;
}
export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  return <div className="rounded-md bg-rose-50 p-3 text-sm text-rose-700 ring-1 ring-rose-200">{errorText(error)}</div>;
}

// ---------- Table ----------
export function Table({ head, children, dense }: { head: ReactNode[]; children: ReactNode; dense?: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead>
          <tr className="border-b border-slate-200 bg-slate-50/70 text-left text-xs font-medium uppercase tracking-wide text-slate-500">
            {head.map((h, i) => <th key={i} className={cx("px-3 font-medium", dense ? "py-1.5" : "py-2")}>{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">{children}</tbody>
      </table>
    </div>
  );
}
export const Td = ({ children, className, ...p }: { children?: ReactNode; className?: string; colSpan?: number; title?: string }) =>
  <td {...p} className={cx("px-3 py-2 align-top", className)}>{children}</td>;

// ---------- Tabs ----------
export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: ReactNode }[] }) {
  return (
    <div className="mb-4 flex gap-1 border-b border-slate-200">
      {items.map((i) => (
        <button key={i.id} onClick={() => onChange(i.id)}
          className={cx("-mb-px border-b-2 px-3 py-2 text-sm font-medium", value === i.id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-700")}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

// ---------- Modal ----------
export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-[8vh]" onMouseDown={onClose}>
      <div className={cx("w-full rounded-lg bg-white shadow-xl ring-1 ring-slate-200", wide ? "max-w-3xl" : "max-w-md")} onMouseDown={(e) => e.stopPropagation()}>
        <div className="border-b border-slate-100 px-5 py-3 font-semibold text-slate-900">{title}</div>
        <div className="space-y-3 px-5 py-4">{children}</div>
        {footer && <div className="flex justify-end gap-2 border-t border-slate-100 bg-slate-50/60 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

// ---------- Toasts ----------
type Toast = { id: number; text: string; tone: "ok" | "err" };
const ToastCtx = createContext<{ ok: (t: string) => void; err: (e: unknown) => void } | null>(null);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const n = useRef(0);
  const push = useCallback((text: string, tone: Toast["tone"]) => {
    const id = ++n.current;
    setItems((x) => [...x, { id, text, tone }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), tone === "err" ? 7000 : 3500);
  }, []);
  const api = { ok: (t: string) => push(t, "ok"), err: (e: unknown) => push(errorText(e), "err") };
  return (
    <ToastCtx.Provider value={api}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 space-y-2">
        {items.map((t) => (
          <div key={t.id} className={cx("max-w-sm rounded-md px-4 py-2.5 text-sm shadow-lg", t.tone === "ok" ? "bg-slate-900 text-white" : "bg-rose-600 text-white")}>{t.text}</div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export function useToast() {
  const v = useContext(ToastCtx);
  if (!v) throw new Error("useToast outside provider");
  return v;
}

// ---------- Async data hook ----------
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; loading: boolean; error: unknown; reload: () => void } {
  const [state, setState] = useState<{ data?: T; loading: boolean; error: unknown }>({ loading: true, error: null });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then((data) => live && setState({ data, loading: false, error: null }))
        .catch((error) => live && setState({ loading: false, error }));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { data: state.data, loading: state.loading, error: state.error, reload: () => setTick((t) => t + 1) };
}

/** Wrap an action with busy state + toasts. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, okText?: string) => {
    if (isReadOnly()) { toast.err("Preview is read-only — exit the preview to make changes."); return false; }
    setBusy(key);
    try { await fn(); if (okText) toast.ok(okText); return true; }
    catch (e) { toast.err(e); return false; }
    finally { setBusy(null); }
  };
  return { busy, run };
}
