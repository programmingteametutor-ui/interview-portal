// tsx scripts/test/scheduler.test.ts
import assert from "node:assert/strict";
import { autoAssign, findPreferredHandler, SchedHandler } from "../../shared/scheduler";
import { operationalMinutes } from "../../shared/parser";

const H = (id: string, extra: Partial<SchedHandler> = {}): SchedHandler =>
  ({ id, name: id, in_auto_pool: true, is_fallback: false, night_eligible: true, sort_order: 100, active: true, ...extra });
const iv = (id: string, time: string, dur: number, extra: any = {}) =>
  ({ id, candidate_name: id, candidate_id: null, start_min: operationalMinutes(time), duration_min: dur,
     is_night: false, handler_id: null, locked: false, ...extra });

// Cross-midnight rule (testCrossMidnightConflictRule): 11:30 PM/50 min blocks until 12:20 AM
{
  const r = autoAssign({
    handlers: [H("Gopal"), H("Pradeep", { is_fallback: true, in_auto_pool: false })],
    interviews: [iv("a", "11:30 PM", 50), iv("b", "12:00 AM", 30), iv("c", "12:20 AM", 30)],
    leaves: [], preferences: [], weeklyNightCounts: {},
  });
  const m = Object.fromEntries(r.map((x) => [x.interview_id, x]));
  assert.equal(m.a.handler_id, "Gopal");
  assert.equal(m.b.handler_id, "Pradeep");    // Gopal busy -> fallback
  assert.equal(m.c.handler_id, "Gopal");      // touching end is allowed
}
// Everyone busy -> Support
{
  const r = autoAssign({ handlers: [H("A")], interviews: [iv("x", "7:00 PM", 60), iv("y", "7:30 PM", 30)],
    leaves: [], preferences: [], weeklyNightCounts: {} });
  assert.equal(r.find((x) => x.interview_id === "y")!.mode, "support");
}
// Lowest load wins for day calls; night calls use weekly night fairness first
{
  const r = autoAssign({ handlers: [H("A"), H("B")],
    interviews: [iv("d1", "6:00 PM", 30), iv("d2", "6:00 PM", 30), iv("n1", "3:00 AM", 30, { is_night: true })],
    leaves: [], preferences: [], weeklyNightCounts: { A: 0, B: 5 } });
  assert.equal(r.find((x) => x.interview_id === "n1")!.handler_id, "A");
  assert.notEqual(r.find((x) => x.interview_id === "d1")!.handler_id, r.find((x) => x.interview_id === "d2")!.handler_id);
}
// Leave blocks the handler; preferred handler wins when free
{
  const r = autoAssign({ handlers: [H("A"), H("B")],
    interviews: [iv("Sai Swetha Kandula", "5:00 PM", 30), iv("other", "8:00 PM", 30)],
    leaves: [{ handler_id: "A", start_min: null, end_min: null }],
    preferences: [{ handler_id: "A", candidate_key: "sai swetha k", candidate_id: null }], weeklyNightCounts: {} });
  assert.ok(r.every((x) => x.handler_id === "B"), "A is on leave");
}
assert.equal(findPreferredHandler(iv("Sai Swetha Kandula", "5:00 PM", 30), [{ handler_id: "A", candidate_key: "sai swetha k", candidate_id: null }]), "A");
console.log("scheduler tests passed");
