// ---------------------------------------------------------------------------
// Promotion Recovery — port of RecoveryEngine.gs v1.4.2 (TEAM-FIRST)
//
// Finds promotions the exact scan misses because candidate / client were
// written differently between rounds. For every earning call (approved
// Completed, numbered round, handler) that is NOT already in the ledger, it
// looks for a later, higher-round interview whose candidate scores ≥ 90 and
// client ≥ 88 (Levenshtein + initials + company-suffix rules), with overall
// confidence ≥ 95 (weights 50/30/10/10). Results are proposals only:
//   recovery   → safe match, pending admin approval
//   same_day   → higher round on the same date, not a Loop → manual review
//   ambiguous  → two evidence rows equally strong at the same time → manual review
// ---------------------------------------------------------------------------

export const REC_SETTINGS = {
  MIN_CANDIDATE_SCORE: 90,
  MIN_CLIENT_SCORE: 88,
  EXCEPTION_MIN_CANDIDATE_SCORE: 92,
  EXCEPTION_MIN_CLIENT_SCORE: 88,
  MIN_CONFIDENCE: 95,
  AMBIGUITY_MARGIN: 3,
  WEIGHTS: { candidate: 50, client: 30, round: 10, date: 10 },
};

// ---------------- text scoring (identical to the legacy helpers) ----------------
export function normalizeCandidate(name: string | null | undefined): string {
  return String(name || "")
    .replace(/\([^)]*\)/g, " ")
    .toLowerCase()
    .replace(/[-–—]/g, " ")
    .replace(/[.,'’`]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stripInterviewStage(client: string): string {
  let value = String(client || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  const leading = /^(?:(?:Loop|Technical|Behavioral|Final|Assessment\s+Through|Assessment|Panel|Manager|Hiring\s+Manager)\s+Interview|Interview)\s*(?:-|:)?\s*/i;
  const trailing = /\s*(?:-|:)?\s*(?:(?:Loop|Technical|Behavioral|Final|Assessment|Panel|Manager|Hiring\s+Manager)\s+Interview|Interview)\s*$/i;
  let previous: string | null = null;
  while (previous !== value) {
    previous = value;
    value = value.replace(leading, "").replace(trailing, "").replace(/^[-:\s]+|[-:\s]+$/g, "").replace(/\s+/g, " ").trim();
  }
  return value;
}

export function normalizeClient(client: string | null | undefined): string {
  let value = stripInterviewStage(String(client || ""));
  value = value.replace(/\([^)]*\)/g, " ");
  value = stripInterviewStage(value);
  return value.toLowerCase()
    .replace(/[-–—]/g, " ")
    .replace(/[.,'’`&]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const GENERIC = ["the", "technology", "technologies", "tech", "solution", "solutions", "service", "services", "system", "systems",
  "limited", "ltd", "llc", "inc", "corporation", "corp", "company", "co", "private", "pvt", "holdings", "group"];
export function simplifyCompany(name: string): string {
  let v = String(name || "").toLowerCase();
  for (const w of GENERIC) v = v.replace(new RegExp("\\b" + w + "\\b", "g"), " ");
  return v.replace(/\s+/g, "").trim();
}

function removeSingleLetterTokens(name: string): string {
  return name.split(/\s+/).filter((t) => t.length > 1).join(" ").trim();
}

function initialCompatible(n1: string, n2: string): boolean {
  const a = n1.split(/\s+/).filter(Boolean), b = n2.split(/\s+/).filter(Boolean);
  if (a.length !== b.length) return false;
  let full = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) { if (a[i].length > 1) full++; continue; }
    if (a[i].length === 1 && b[i].length > 1 && b[i][0] === a[i]) continue;
    if (b[i].length === 1 && a[i].length > 1 && a[i][0] === b[i]) continue;
    return false;
  }
  return full >= 1;
}

export function levenshtein(a: string, b: string): number {
  const prev = Array.from({ length: a.length + 1 }, (_, j) => j);
  const cur = new Array<number>(a.length + 1);
  for (let i = 1; i <= b.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= a.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (b[i - 1] === a[j - 1] ? 0 : 1));
    }
    for (let j = 0; j <= a.length; j++) prev[j] = cur[j];
  }
  return prev[a.length];
}
export function stringSimilarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  return max === 0 ? 100 : ((max - levenshtein(a, b)) / max) * 100;
}

export function candidateScore(n1: string | null | undefined, n2: string | null | undefined): number {
  const a = normalizeCandidate(n1), b = normalizeCandidate(n2);
  if (!a || !b) return 0;
  if (a === b) return 100;
  const ca = a.replace(/\s+/g, ""), cb = b.replace(/\s+/g, "");
  if (ca === cb) return 100;
  const na = removeSingleLetterTokens(a), nb = removeSingleLetterTokens(b);
  if (na && nb && na.replace(/\s+/g, "") === nb.replace(/\s+/g, "")) return 98;
  if (initialCompatible(a, b)) return 96;
  return Math.round(Math.max(stringSimilarity(ca, cb), stringSimilarity(na.replace(/\s+/g, ""), nb.replace(/\s+/g, ""))));
}

export function clientScore(c1: string | null | undefined, c2: string | null | undefined): number {
  const a = normalizeClient(c1), b = normalizeClient(c2);
  if (!a || !b) return 0;
  if (a === b) return 100;
  if (a.replace(/\s+/g, "") === b.replace(/\s+/g, "")) return 100;
  const sa = simplifyCompany(a), sb = simplifyCompany(b);
  if (sa && sa === sb) return 100;
  if (sa.length >= 4 && sb.length >= 4 && (sa.includes(sb) || sb.includes(sa))) {
    if (Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length) >= 0.5) return 98;
  }
  return Math.round(stringSimilarity(sa, sb));
}

export function confidence(cand: number, client: number, round: number, date: number): number {
  const w = REC_SETTINGS.WEIGHTS;
  return Math.round((cand * w.candidate + client * w.client + round * w.round + date * w.date) / (w.candidate + w.client + w.round + w.date));
}

// ---------------- engine ----------------
export interface RecInterview {
  id: string;
  work_date: string;           // YYYY-MM-DD
  start_min: number | null;
  candidate_name: string | null;
  candidate_id: string | null;
  candidate_canonical?: string | null;
  client_name: string | null;
  client_id: string | null;
  client_canonical?: string | null;
  round_no: number | null;
  is_loop: boolean;
  outcome: string;
  handler_id: string | null;
  raw_text: string;
  seq?: number;
}
export interface RecLedgerRow {
  earning_interview_id: string | null;
  candidate_name: string;
  client_name: string;
  from_round: string | null;
  previous_date: string | null;
  handler_id: string | null;
}
export type RecKind = "recovery" | "same_day" | "ambiguous";
export interface RecResult {
  id: string;
  kind: RecKind;
  earning_interview_id: string;
  evidence_interview_id: string;
  second_evidence_id: string | null;
  candidate_score: number;
  client_score: number;
  confidence: number;
  from_round_no: number;
  to_round_no: number;
  reason: string;
}

const roundFromLabel = (s: string | null): number => {
  if (!s) return 0;
  if (/final/i.test(s)) return 999;
  const m = s.match(/(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
};
const candName = (r: RecInterview) => r.candidate_canonical || r.candidate_name;
const cliName = (r: RecInterview) => r.client_canonical || r.client_name;
const candNames = (r: RecInterview) => [...new Set([r.candidate_name, r.candidate_canonical].filter(Boolean) as string[])];
/** Client variants: as written, canonical, and with a trailing " - Job Role" removed (legacy canonical-client step). */
const clientVariants = (n: string | null | undefined): string[] => {
  if (!n) return [];
  const head = n.split(/\s+[-–—]\s+/)[0].trim();
  return head && head !== n ? [n, head] : [n];
};
const cliNames = (r: RecInterview) => [...new Set([...clientVariants(r.client_name), ...clientVariants(r.client_canonical)])];
/** Best score over the name as written and its canonical master name. */
const bestOf = (xs: string[], ys: string[], f: (a: string, b: string) => number) => {
  let best = 0;
  for (const x of xs) for (const y of ys) { best = Math.max(best, f(x, y)); if (best === 100) return 100; }
  return best;
};

function pairScores(a: RecInterview, b: RecInterview) {
  const cs = a.candidate_id && a.candidate_id === b.candidate_id ? 100 : bestOf(candNames(a), candNames(b), candidateScore);
  if (cs < REC_SETTINGS.MIN_CANDIDATE_SCORE) return null;
  const ks = a.client_id && a.client_id === b.client_id ? 100 : bestOf(cliNames(a), cliNames(b), clientScore);
  return { cs, ks };
}

function isHigher(from: number, to: number) {
  return to === 999 ? from !== 999 : from !== 999 && to > from;
}

/** Bucket by first letters of the normalized candidate (REC_candidateBucketKeysV141_ idea) to keep it fast. */
function bucketKeys(name: string | null): string[] {
  const n = normalizeCandidate(name).replace(/\s+/g, "");
  return n.length >= 3 ? [n.slice(0, 3)] : n ? [n] : [];
}

export function runRecovery(interviews: RecInterview[], ledger: RecLedgerRow[]): RecResult[] {
  // Effective evidence rows: drop occurrences superseded by a later "Rescheduled from" copy, and cancelled ones.
  const byGroup = new Map<string, RecInterview[]>();
  for (const r of interviews) {
    if (!r.round_no || !r.candidate_name || !r.client_name) continue;
    const k = `${normalizeCandidate(candName(r))}|${normalizeClient(cliName(r))}|${r.round_no}`;
    (byGroup.get(k) ?? byGroup.set(k, []).get(k)!).push(r);
  }
  const superseded = new Set<string>();
  byGroup.forEach((g) => {
    g.sort((a, b) => a.work_date.localeCompare(b.work_date) || (a.start_min ?? 0) - (b.start_min ?? 0) || (a.seq ?? 0) - (b.seq ?? 0));
    g.forEach((r, i) => { if (i > 0 && /\bresched(?:ule|uled|uling)?\s+from\b/i.test(r.raw_text)) superseded.add(g[i - 1].id); });
  });
  const evidence = interviews.filter((r) => r.round_no && r.candidate_name && r.client_name && r.outcome !== "cancelled" && !superseded.has(r.id));

  const buckets = new Map<string, RecInterview[]>();
  for (const r of evidence) for (const n of candNames(r)) for (const k of bucketKeys(n)) {
    const b = buckets.get(k) ?? buckets.set(k, []).get(k)!;
    if (!b.includes(r)) b.push(r);
  }

  // Ledger index for "already tracked" checks
  const trackedIds = new Set(ledger.map((l) => l.earning_interview_id).filter(Boolean) as string[]);
  const ledgerByDate = new Map<string, RecLedgerRow[]>();
  for (const l of ledger) if (l.previous_date) (ledgerByDate.get(l.previous_date) ?? ledgerByDate.set(l.previous_date, []).get(l.previous_date)!).push(l);
  const isTracked = (e: RecInterview) => {
    if (trackedIds.has(e.id)) return true;
    return (ledgerByDate.get(e.work_date) ?? []).some((l) =>
      roundFromLabel(l.from_round) === e.round_no &&
      (!l.handler_id || l.handler_id === e.handler_id) &&
      bestOf([l.candidate_name], candNames(e), candidateScore) >= REC_SETTINGS.MIN_CANDIDATE_SCORE &&
      bestOf(clientVariants(l.client_name), cliNames(e), clientScore) >= REC_SETTINGS.MIN_CLIENT_SCORE);
  };

  const results: RecResult[] = [];
  const seen = new Set<string>();
  const earning = interviews.filter((r) => r.outcome === "completed" && r.handler_id && r.round_no && r.round_no >= 1 && r.round_no <= 998 && r.candidate_name && r.client_name);

  for (const e of earning) {
    if (isTracked(e)) continue;
    const pool = new Set<RecInterview>();
    for (const n of candNames(e)) for (const k of bucketKeys(n)) (buckets.get(k) ?? []).forEach((x) => pool.add(x));
    // same candidate id may be spelled with a different first 3 letters
    if (e.candidate_id) evidence.forEach((x) => { if (x.candidate_id === e.candidate_id) pool.add(x); });

    type Item = { r: RecInterview; cs: number; ks: number; conf: number; ts: number };
    const safe: Item[] = [], sameDay: Item[] = [];
    for (const x of pool) {
      if (x.id === e.id || !isHigher(e.round_no!, x.round_no!)) continue;
      const sc = pairScores(e, x);
      if (!sc || sc.ks < REC_SETTINGS.MIN_CLIENT_SCORE) continue;
      const ts = Date.parse(x.work_date + "T00:00:00Z") / 60000 + (x.start_min ?? 0);
      // REC_compareChronology
      let valid = false, dateScore = 0, sameDayNonLoop = false;
      if (x.work_date > e.work_date) { valid = true; dateScore = 100; }
      else if (x.work_date === e.work_date) {
        if (!e.is_loop && !x.is_loop) sameDayNonLoop = true;
        else if (e.start_min != null && x.start_min != null) { valid = x.start_min > e.start_min; dateScore = valid ? 100 : 0; }
        else { valid = true; dateScore = 90; }
      }
      const conf = confidence(sc.cs, sc.ks, 100, dateScore);
      if (valid && conf >= REC_SETTINGS.MIN_CONFIDENCE) safe.push({ r: x, cs: sc.cs, ks: sc.ks, conf, ts });
      else if (sameDayNonLoop && sc.cs >= REC_SETTINGS.EXCEPTION_MIN_CANDIDATE_SCORE && sc.ks >= REC_SETTINGS.EXCEPTION_MIN_CLIENT_SCORE)
        sameDay.push({ r: x, cs: sc.cs, ks: sc.ks, conf, ts });
    }
    const sorter = (a: Item, b: Item) => a.ts - b.ts || b.conf - a.conf || (a.r.round_no ?? 0) - (b.r.round_no ?? 0);
    const push = (kind: RecKind, best: Item, second: Item | null, reason: string) => {
      const id = kind === "recovery" ? `REC|${e.id}|${best.r.id}` : `EXC|${kind}|${e.id}`;
      if (seen.has(id)) return;
      seen.add(id);
      results.push({ id, kind, earning_interview_id: e.id, evidence_interview_id: best.r.id, second_evidence_id: second?.r.id ?? null,
        candidate_score: best.cs, client_score: best.ks, confidence: best.conf, from_round_no: e.round_no!, to_round_no: best.r.round_no!, reason });
    };
    if (safe.length) {
      safe.sort(sorter);
      const best = safe[0];
      const sameTime = safe.filter((i) => Math.abs(i.ts - best.ts) <= 1);
      if (sameTime.length > 1 && Math.abs(best.conf - sameTime[1].conf) <= REC_SETTINGS.AMBIGUITY_MARGIN) {
        push("ambiguous", best, sameTime[1], "More than one higher-round interview is equally strong; pick the right one.");
      } else {
        push("recovery", best, null, `Candidate ${best.cs}% · Client ${best.ks}% · confidence ${best.conf}%`);
      }
    } else if (sameDay.length) {
      sameDay.sort(sorter);
      push("same_day", sameDay[0], null, "Higher round on the same date and not marked Loop Interview — confirm it really happened after.");
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Possible Matches (PossibleMatches.gs detectClientAliases) — same candidate,
// two client spellings that score ≥ 88 → suggest an alias to the most used one.
// ---------------------------------------------------------------------------
export interface AliasRow { candidate_name: string | null; candidate_id: string | null; client_name: string | null; client_id: string | null; client_canonical?: string | null }
export interface AliasSuggestion { alias: string; official: string; official_client_id: string | null; candidate: string; score: number; calls: number }

export function suggestClientAliases(rows: AliasRow[], minScore = REC_SETTINGS.MIN_CLIENT_SCORE): AliasSuggestion[] {
  const groups = new Map<string, AliasRow[]>();
  for (const r of rows) {
    if (!r.candidate_name || !r.client_name) continue;
    const k = r.candidate_id ?? "n:" + normalizeCandidate(r.candidate_name);
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(r);
  }
  const out = new Map<string, AliasSuggestion>();
  const key = (s: string) => normalizeClient(s).replace(/\s+/g, "");
  const head = (s: string) => key(s.split(/\s+[-–—]\s+/)[0]);
  for (const g of groups.values()) {
    const names = new Map<string, { name: string; count: number; id: string | null }>();
    for (const r of g) {
      const name = r.client_canonical || r.client_name!;
      const k = key(name);
      const cur = names.get(k) ?? { name, count: 0, id: r.client_id };
      cur.count++; cur.id = cur.id ?? r.client_id;
      names.set(k, cur);
    }
    if (names.size < 2) continue;
    const list = [...names.values()].sort((a, b) => Number(!!b.id) - Number(!!a.id) || b.count - a.count);
    const official = list[0];
    for (const other of list.slice(1)) {
      if (other.id && official.id && other.id === official.id) continue;
      if (other.id && official.id) continue;                       // both already mastered as different clients
      if (head(other.name) === key(official.name) || head(official.name) === key(other.name)) continue; // "X - role" is resolved already
      const score = clientScore(official.name, other.name);
      if (score < minScore || score === 100 && key(official.name) === key(other.name)) continue;
      const k = `${key(other.name)}→${key(official.name)}`;
      const prev = out.get(k);
      if (prev) { prev.calls += other.count; continue; }
      out.set(k, { alias: other.name, official: official.name, official_client_id: official.id, candidate: g[0].candidate_name!, score, calls: other.count });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score || b.calls - a.calls);
}
