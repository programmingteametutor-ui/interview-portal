// ---------------------------------------------------------------------------
// Auto-assignment — port of Call Tracker Scheduler.gs (V3)
//
// 1. Preferred handler (Preference List match on candidate) when available.
// 2. Otherwise the main pool: available handlers only;
//      night calls (AM, >= 2:00) -> lowest weekly night count, then today's load, then order;
//      other calls             -> lowest today's load, then name.
// 3. Every main handler busy -> fallback handler (e.g. Pradeep) if available.
// 4. Everyone busy -> "Support" (left unassigned, flagged).
// Availability: a handler is busy if [start, start+duration) overlaps an existing
// booking (touching end-to-start is allowed), or they are on leave.
// ---------------------------------------------------------------------------
import { normKey } from "./parser";

export interface SchedHandler {
  id: string;
  name: string;
  in_auto_pool: boolean;
  is_fallback: boolean;
  night_eligible: boolean;
  sort_order: number;
  active: boolean;
}
export interface SchedInterview {
  id: string;
  candidate_name: string | null;
  candidate_id: string | null;
  start_min: number | null;
  duration_min: number | null;
  is_night: boolean;
  handler_id: string | null;
  /** locked rows (manual, finalized, pending requests) keep their handler and count as bookings */
  locked: boolean;
}
export interface SchedLeave { handler_id: string; start_min: number | null; end_min: number | null }
export interface SchedPreference { handler_id: string; candidate_key: string; candidate_id: string | null }

export interface SchedInput {
  handlers: SchedHandler[];
  interviews: SchedInterview[];
  leaves: SchedLeave[];
  preferences: SchedPreference[];
  weeklyNightCounts: Record<string, number>;
  defaultDuration?: number; // SETTINGS.DEFAULT_DURATION = 30
  fuzzyThreshold?: number;  // SETTINGS.MATCH_THRESHOLD = 70 (%)
}
export interface SchedResult {
  interview_id: string;
  handler_id: string | null;
  mode: "preferred" | "auto" | "fallback" | "support";
  reason: string;
}

interface Booking { start: number; end: number }

function overlaps(a: Booking, b: Booking) { return a.start < b.end && b.start < a.end; }

/** Bigram Dice similarity (0..1) — stands in for FuzzyMatcher.gs */
export function similarity(a: string, b: string): number {
  const x = normKey(a).replace(/ /g, ""), y = normKey(b).replace(/ /g, "");
  if (!x || !y) return 0;
  if (x === y) return 1;
  const grams = (s: string) => { const m = new Map<string, number>(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); m.set(g, (m.get(g) || 0) + 1); } return m; };
  const gx = grams(x), gy = grams(y);
  let inter = 0;
  gx.forEach((n, g) => { inter += Math.min(n, gy.get(g) || 0); });
  return (2 * inter) / (x.length - 1 + (y.length - 1));
}

export function findPreferredHandler(iv: SchedInterview, prefs: SchedPreference[], threshold = 0.7): string | null {
  if (iv.candidate_id) {
    const byId = prefs.find((p) => p.candidate_id && p.candidate_id === iv.candidate_id);
    if (byId) return byId.handler_id;
  }
  const key = normKey(iv.candidate_name);
  if (!key) return null;
  const exact = prefs.find((p) => p.candidate_key === key);
  if (exact) return exact.handler_id;
  let best: { h: string; s: number } | null = null;
  for (const p of prefs) {
    // preference lists often hold first name + initial ("Sai Swetha K")
    const s = Math.max(similarity(p.candidate_key, key), key.startsWith(p.candidate_key + " ") ? 0.9 : 0);
    if (s >= threshold && (!best || s > best.s)) best = { h: p.handler_id, s };
  }
  return best ? best.h : null;
}

export function autoAssign(input: SchedInput): SchedResult[] {
  const dflt = input.defaultDuration ?? 30;
  const active = input.handlers.filter((h) => h.active);
  const main = active.filter((h) => h.in_auto_pool && !h.is_fallback).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
  const fallback = active.filter((h) => h.is_fallback);
  const order = new Map(main.map((h, i) => [h.id, i]));

  const bookings = new Map<string, Booking[]>();
  const load = new Map<string, number>();
  const nightLoad = new Map<string, number>(Object.entries(input.weeklyNightCounts));
  active.forEach((h) => { bookings.set(h.id, []); load.set(h.id, 0); });

  for (const l of input.leaves) {
    if (!bookings.has(l.handler_id)) continue;
    bookings.get(l.handler_id)!.push(l.start_min == null ? { start: -1e9, end: 1e9 } : { start: l.start_min, end: l.end_min ?? l.start_min + dflt });
  }

  const interval = (iv: SchedInterview): Booking | null =>
    iv.start_min == null ? null : { start: iv.start_min, end: iv.start_min + (iv.duration_min || dflt) };

  // Locked rows reserve their handler first.
  for (const iv of input.interviews) {
    if (!iv.locked || !iv.handler_id || !bookings.has(iv.handler_id)) continue;
    const b = interval(iv);
    if (b) bookings.get(iv.handler_id)!.push(b);
    load.set(iv.handler_id, (load.get(iv.handler_id) || 0) + 1);
  }

  const available = (hid: string, b: Booking | null) => !!b && !(bookings.get(hid) || []).some((x) => overlaps(x, b));
  const reserve = (hid: string, iv: SchedInterview, b: Booking) => {
    bookings.get(hid)!.push(b);
    load.set(hid, (load.get(hid) || 0) + 1);
    if (iv.is_night) nightLoad.set(hid, (nightLoad.get(hid) || 0) + 1);
  };

  const todo = input.interviews
    .filter((iv) => !iv.locked)
    .sort((a, b) => (a.start_min ?? 1e9) - (b.start_min ?? 1e9));

  const results: SchedResult[] = [];
  const pending: SchedInterview[] = [];

  // Pass 1 — preferred handlers (assignFixedHandlers)
  for (const iv of todo) {
    const b = interval(iv);
    const pref = findPreferredHandler(iv, input.preferences, (input.fuzzyThreshold ?? 70) / 100);
    if (pref && bookings.has(pref) && available(pref, b)) {
      reserve(pref, iv, b!);
      results.push({ interview_id: iv.id, handler_id: pref, mode: "preferred", reason: "Preference list" });
    } else {
      pending.push(iv);
    }
  }

  // Pass 2 — main pool, fallback, support (assignNormalHandlers)
  for (const iv of pending) {
    const b = interval(iv);
    if (!b) { results.push({ interview_id: iv.id, handler_id: null, mode: "support", reason: "No time — assign manually" }); continue; }
    const cands = main
      .filter((h) => available(h.id, b) && (!iv.is_night || h.night_eligible))
      .map((h) => ({ h, load: load.get(h.id) || 0, night: nightLoad.get(h.id) || 0, ord: order.get(h.id) ?? 999 }));
    if (cands.length) {
      cands.sort((a, c) =>
        iv.is_night
          ? a.night - c.night || a.load - c.load || a.ord - c.ord
          : a.load - c.load || a.h.name.localeCompare(c.h.name));
      const pick = cands[0].h;
      reserve(pick.id, iv, b);
      results.push({ interview_id: iv.id, handler_id: pick.id, mode: "auto",
        reason: iv.is_night ? `Night: weekly ${cands[0].night}, today ${cands[0].load}` : `Lowest load (${cands[0].load})` });
      continue;
    }
    const fb = fallback.find((h) => available(h.id, b));
    if (fb) { reserve(fb.id, iv, b); results.push({ interview_id: iv.id, handler_id: fb.id, mode: "fallback", reason: "All main handlers busy" }); continue; }
    results.push({ interview_id: iv.id, handler_id: null, mode: "support", reason: "Everyone busy — Support" });
  }
  return results;
}

/** Monday of the week containing d (YYYY-MM-DD) — WeeklyNightBalance uses Mon–Sun weeks. */
export function weekStart(isoDate: string): string {
  const d = new Date(isoDate + "T00:00:00Z");
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
