import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL as string;
const key = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

if (!url || !key) {
  // eslint-disable-next-line no-console
  console.error("Missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY — copy web/.env.example to web/.env");
}

export const supabase = createClient(url ?? "http://localhost", key ?? "missing", {
  // PKCE: the Google OAuth redirect comes back as ?code=… (query string), so it never collides
  // with the hash router (#/page). The implicit flow would put tokens in the hash.
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: "pkce" },
});

/** Remove OAuth leftovers (?code, ?error, …) from the address bar, keeping the #/route. */
export function cleanAuthParams() {
  try {
    const u = new URL(window.location.href);
    const keys = ["code", "error", "error_code", "error_description", "state"];
    if (!keys.some((k) => u.searchParams.has(k))) return;
    keys.forEach((k) => u.searchParams.delete(k));
    window.history.replaceState(window.history.state, "", u.pathname + u.search + u.hash);
  } catch { /* ignore */ }
}

/** Error returned by Supabase after a failed OAuth redirect (e.g. email not registered). */
export function readAuthRedirectError(): string | null {
  try {
    const qs = new URLSearchParams(window.location.search);   // PKCE returns errors in the query string
    return qs.get("error_description") ?? qs.get("error");
  } catch { return null; }
}

/** Map database error codes (raised by the RPCs) to readable messages. */
const MESSAGES: Record<string, string> = {
  ACCESS_DENIED: "You don't have permission for this action.",
  CALL_ACCESS_DENIED: "This call is not assigned to you.",
  CALL_ALREADY_FINALIZED: "This call already has an approved outcome.",
  CALL_HAS_PENDING_REASSIGNMENT: "A reassignment request is pending for this call.",
  CALL_HAS_PENDING_OUTCOME: "An outcome is pending approval for this call.",
  CALL_IDENTITY_UNRESOLVED: "Map the candidate and client to the master list first (Identity page).",
  UNASSIGNED_CALL_CANNOT_BE_SUBMITTED: "The call has no handler yet.",
  CALL_NOT_COMPLETED: "Only completed calls can be marked selected.",
  WORK_DAY_COMPLETED: "This day is closed. Reopen it to edit.",
  WORK_DAY_HAS_PENDING_REQUESTS: "Approve or reject pending requests before closing the day.",
  HANDLER_NOT_IN_TEAM: "That handler is not in this team.",
  SAME_HANDLER: "Pick a different handler.",
  CALL_ASSIGNMENT_CHANGED: "The call was reassigned meanwhile — refresh.",
  INVALID_CORRECTION: "Pick a different outcome.",
  SELECTION_UNCHANGED: "Selection status is already set to that.",
};
export function errorText(e: unknown): string {
  const raw = (e as { message?: string })?.message ?? String(e);
  const code = raw.split(":")[0].trim();
  return MESSAGES[code] ?? raw;
}

/** Throwing wrapper for RPC calls */
export async function rpc<T = unknown>(fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data as T;
}

/** Throwing wrapper for queries */
export async function q<T>(p: PromiseLike<{ data: T | null; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await p;
  if (error) throw new Error(error.message);
  return data as T;
}

/** Fetch all rows past PostgREST's 1000-row page limit.
 *  T is the caller's row shape. Without generated DB types, supabase-js types many-to-one
 *  embeds (e.g. `cli:clients(canonical_name)`) as arrays although PostgREST returns an object,
 *  so the row type is asserted rather than inferred. */
export async function fetchAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const rows = (await q(build(from, from + page - 1))) as T[];
    out.push(...rows);
    if (rows.length < page) break;
  }
  return out;
}
