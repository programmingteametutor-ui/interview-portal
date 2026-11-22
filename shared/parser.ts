// ---------------------------------------------------------------------------
// Interview line parser — port of Parser.gs parseInterview() + call tracker
// duration/time helpers. Pure TypeScript, shared by the web app and importer.
//
//   "Meghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (2nd Round)"
//   -> candidate "Meghana B", location "UK", client "Expana", round 2,
//      time "1:30 PM", start_min 810, duration 30
// ---------------------------------------------------------------------------

export interface ParsedInterview {
  raw_text: string;
  candidate_name: string | null;
  client_name: string | null;
  job_role: string | null;
  location_tag: string | null;
  round_label: string | null;
  round_no: number | null; // 999 = Final
  is_loop: boolean;
  time_label: string | null;
  start_min: number | null; // operational minutes (00:00–05:59 roll over to +1440)
  duration_min: number | null;
  is_night: boolean;
  parse_ok: boolean;
  parse_note: string | null;
}

export interface ParseOptions {
  /** Return true when the name is a known client (master or alias). Used to split "Client - Role". */
  isKnownClient?: (name: string) => boolean;
  /** Hour (0-23) before which AM times belong to the previous working day. Default 6. */
  cutoverHour?: number;
  /** Clock minutes from which AM calls count as night calls. Default 120 (2:00 AM). */
  nightStartMin?: number;
}

const COUNTRY_RE =
  /^(?:uk|u\.?k\.?|ireland|germany|canada|india|usa|u\.?s\.?a?\.?|united\s+states|c2c|corp\s+to\s+corp|ir)$/i;

const DESCRIPTOR_RE =
  /^(?:interview|interview\s+call|behavioral\s+interview|final\s+interview|technical\s+(?:i?nterview|coding\s+interview)|excel\s+interview|ai\s+interview|panel\s+interview|hiring\s+manager\s+interview|manager\s+interview|assessment\s+interview|assessment\s+through\s+interview|coding\s+interview|zoom\s+interview|teams\s+interview|microsoft\s+teams\s+interview|google\s+meet\s+interview|phone\s+interview|phn\s+interview|loop\s+interview|phone\s+call|phn\s+call|google\s+voice\s+call|recruiter\s+call|phone\s+screen|prep\s+call|final\s+technical\s+discussion|final\s+discussion|technical\s+discussion(?:\s+w\/?\s*hiring\s+manager)?|discussion\s+round|discussion|technical\s+round|screening\s+round)$/i;

/** Same as PC_normalizeText_ (used for call IDs / duplicate detection). */
export function callNormalize(text: string): string {
  return String(text || "").replace(/[–—]/g, "-").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Same as Normalizer.gs normalizeText (identity keys). */
export function normKey(text: string | null | undefined): string {
  return String(text || "")
    .toLowerCase()
    .replace(/'/g, "")
    .replace(/[().,–—-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function roundLabel(n: number | null): string | null {
  if (!n || n <= 0) return null;
  if (n === 999) return "Final";
  const m100 = n % 100;
  let suf = "th";
  if (m100 < 11 || m100 > 13) {
    if (n % 10 === 1) suf = "st";
    else if (n % 10 === 2) suf = "nd";
    else if (n % 10 === 3) suf = "rd";
  }
  return `${n}${suf} Round`;
}

/** PARSER_extractRound_: explicit numbered round wins over "Final". */
export function extractRound(text: string): { round: string; roundNo: number } | null {
  const patterns = [
    /\b(\d{1,2})\s*(?:st|nd|rd|th)\s*[-:;,./]?\s*(?:Round|Rd)\b/i,
    /\bRound\s*[-:#;,./]?\s*(\d{1,2})\b/i,
    /\bR\s*[-:#;,./]?\s*(\d{1,2})\b/i,
    /\b(\d{1,2})\s*[-:;,./]?\s*Round\b/i,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const n = parseInt(m[1], 10);
    if (!isNaN(n) && n > 0) return { round: roundLabel(n)!, roundNo: n };
  }
  if (/\bCandidate(?:'s)?\s+(?:1st|first)\s+(?:Interview|Call)\b/i.test(text)) return { round: "1st Round", roundNo: 1 };
  if (/\bFinal\b/i.test(text)) return { round: "Final", roundNo: 999 };
  return null;
}

export function parseDuration(text: string): number | null {
  const m = text.match(/Duration\s*:?\s*([^()–—]*)/i);
  const seg = m ? m[1] : text;
  let total = 0;
  let found = false;
  const h = seg.match(/(\d+(?:\.\d+)?)\s*(?:hr|hrs|hour|hours)\b/i);
  if (h) { total += Math.round(parseFloat(h[1]) * 60); found = true; }
  const mi = seg.match(/(\d+)\s*(?:min|mins|minutes)\b/i);
  if (mi) { total += parseInt(mi[1], 10); found = true; }
  return found && total > 0 ? total : null;
}

export function clockMinutes(timeLabel: string): number | null {
  const m = timeLabel.match(/(\d{1,2})(?:[:.](\d{2}))?\s*([AP]M)/i);
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "PM") h += 12;
  return h * 60 + parseInt(m[2] || "0", 10);
}

/** Continuous operational day: 11:30 PM -> 1410, 12:20 AM -> 1460 (Scheduler.gs). */
export function operationalMinutes(timeLabel: string | null, cutoverHour = 6): number | null {
  if (!timeLabel) return null;
  const c = clockMinutes(timeLabel);
  if (c == null) return null;
  return c < cutoverHour * 60 ? c + 1440 : c;
}

export function formatMinutes(min: number | null): string {
  if (min == null) return "";
  const c = ((min % 1440) + 1440) % 1440;
  const h = Math.floor(c / 60), m = c % 60;
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

function isDescriptor(part: string): boolean {
  const v = part.replace(/\([^)]*(?:Round|Rd|Final)[^)]*\)/gi, " ").replace(/\s+/g, " ").trim()
    .replace(/^\((.*)\)$/, "$1").trim(); // "(Interview)" written in place of the client
  if (/^\(?\s*interview\s*\)?$/i.test(part.trim())) return true;
  return !v || DESCRIPTOR_RE.test(v);
}

function isContextQualifier(part: string): boolean {
  const v = part.replace(/[()]/g, " ").replace(/\s+/g, " ").trim();
  return !v || COUNTRY_RE.test(v);
}

// Scheduling status notes that are neither client nor role ("Waiting for Invite", "Rescheduled from 3rd")
const STATUS_RE = /^\(?\s*(?:waiting|awaiting|need(?:s)? to|resched|postpone|tentative|not provided|to be confirmed|tbc|tbd|candidate'?s?\s+(?:own|first|1st)|own side|confirmed)\b/i;

function cleanClientPart(part: string): string {
  return part
    .replace(/\([^)]*(?:Round|Rd)[^)]*\)/gi, " ")
    .replace(/^\s*\((?:UK|Ireland|Germany|Canada|India|USA|US|C2C|IR)\)\s*/i, "")
    .replace(
      /^\s*(?:Interview|Interview\s+Call|Loop\s+Interview|Technical\s+(?:I?nterview|Coding\s+Interview)|Behavioral\s+Interview|Panel\s+Interview|Final\s+Interview|Assessment(?:\s+Through)?\s+Interview|Coding\s+Interview|Phone\s+Interview|Phn\s+Interview|Phone\s+Call|Phn\s+Call|Recruiter\s+Call|Phone\s+Screen|Prep\s+Call)\b\s*[:\-]?\s*/i,
      "",
    )
    .replace(/\s*[:\-]?\s*(?:Loop|Technical|Behavioral|Final|Panel|Assessment\s+Through|Assessment)\s+Interview\s*$/i, "")
    .replace(/\s*[:\-]?\s*Interview\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Strip leading list numbering ("12,", "12.", "12)") from a pasted line. */
export function stripNumbering(line: string): string {
  return line.replace(/^\s*\d{1,3}\s*[.,)\t]\s*/, "").replace(/^"(.*)"$/, "$1").trim();
}

/** Lines such as "7/1/2026 Wednesday", "Jan 02", "S.no" are headers, not interviews. */
export function isHeaderLine(line: string): boolean {
  const v = line.trim();
  if (!v) return true;
  if (/^s\.?\s*no\b/i.test(v)) return true;
  if (/^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}(\s+\w+day)?$/i.test(v)) return true;
  if (/^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(,?\s*\d{4})?$/i.test(v)) return true;
  return false;
}

export function parseInterview(text: string, opts: ParseOptions = {}): ParsedInterview {
  const original = String(text || "").trim();
  const result: ParsedInterview = {
    raw_text: original, candidate_name: null, client_name: null, job_role: null, location_tag: null,
    round_label: null, round_no: null, is_loop: false, time_label: null, start_min: null,
    duration_min: null, is_night: false, parse_ok: false, parse_note: null,
  };
  if (!original) { result.parse_note = "Empty line"; return result; }

  // Split on spaced dashes / en-em dashes only; keep intra-word hyphens (Mercedes-Benz).
  const value = original.replace(/\s+/g, " ").trim();
  // A hyphen is a separator unless it sits between two word characters with no spaces.
  const parts = value
    .split(/\s*[–—]+\s*|\s*-{2,}\s*|\s+-+\s*|\s*-+\s+|(?<=\))\s*-+\s*|\s*-+\s*(?=\()|(?<=[A-Za-z.])-(?=\d{1,2}(?:[:.]\d{2})?\s*[ap]m\b)/i)
    .map((p) => p.trim())
    .filter(Boolean);
  // Candidate names never contain hyphens: "ramya perumal-FRC-(2nd round)" -> split the head too.
  if (parts[0] && /[A-Za-z)]-[A-Za-z(]/.test(parts[0])) {
    const headParts = parts[0].split("-").map((p) => p.trim()).filter(Boolean);
    parts.splice(0, 1, ...headParts);
  }

  const notes: string[] = [];

  // Candidate + location tag
  const head = parts[0] || "";
  const tags = Array.from(head.matchAll(/\(([^)]*)\)/g)).map((m) => m[1].trim());
  const loc = tags.find((t) => COUNTRY_RE.test(t));
  result.location_tag = loc ? loc.toUpperCase() === "IR" ? "Ireland" : loc : null;
  const cand = head.replace(/\([^)]*\)/g, " ").replace(/\s+/g, " ").trim();
  if (parts.length < 2 || !cand) notes.push("No candidate / separator found");
  else result.candidate_name = cand;

  // Round
  const r = extractRound(value);
  if (r) { result.round_label = r.round; result.round_no = r.roundNo; }
  else notes.push("Round not found");
  result.is_loop = /\bLoop\s+Interview\b/i.test(value);

  // Time
  const tm = value.match(/\b(\d{1,2})(?:[:.](\d{2}))?\s*([AP]M)\b/i);
  let timeIdx = -1;
  if (tm) {
    const h = parseInt(tm[1], 10);
    result.time_label = `${h}:${tm[2] || "00"} ${tm[3].toUpperCase()}`;
    result.start_min = operationalMinutes(result.time_label, opts.cutoverHour ?? 6);
    const clock = clockMinutes(result.time_label)!;
    const nightStart = opts.nightStartMin ?? 120;
    result.is_night = tm[3].toUpperCase() === "AM" && clock >= nightStart && clock < 12 * 60;
    timeIdx = parts.findIndex((p, i) => i > 0 && p.includes(tm[0]));
  } else notes.push("Time not found");

  // Duration
  result.duration_min = parseDuration(value);

  // Client (+ role): parts between candidate and time, minus descriptors/qualifiers
  const middle = parts.slice(1, timeIdx > 0 ? timeIdx : parts.length).filter((p) => !/^Duration\b/i.test(p));
  const clientParts: string[] = [];
  for (const p of middle) {
    if (isDescriptor(p) || isContextQualifier(p)) continue;
    const c = cleanClientPart(p).replace(/\s*\((?:waiting|awaiting|need|resched|tentative)[^)]*\)\s*$/i, "").trim();
    if (!c || isDescriptor(c) || isContextQualifier(c) || STATUS_RE.test(c)) continue;
    clientParts.push(c);
  }
  if (clientParts.length) {
    // Prefer the longest known client prefix ("Boston Scientific - Enterprise Data ..." -> client + role)
    let split = 1;
    if (opts.isKnownClient) {
      for (let k = clientParts.length; k >= 1; k--) {
        const cand1 = clientParts.slice(0, k).join(" - ");
        const cand2 = clientParts.slice(0, k).join("-");
        if (opts.isKnownClient(cand1) || opts.isKnownClient(cand2)) { split = k; break; }
      }
    }
    result.client_name = clientParts.slice(0, split).join(" - ");
    const role = clientParts.slice(split).join(" - ").trim();
    result.job_role = role || null;
  } else notes.push("Client not found");

  result.parse_ok = !!(result.candidate_name && result.client_name && result.round_no);
  result.parse_note = notes.length ? notes.join("; ") : null;
  return result;
}

/** Parse a pasted block. Header lines and blank lines are skipped. */
export function parseBlock(block: string, opts: ParseOptions = {}): ParsedInterview[] {
  return block
    .split(/\r?\n/)
    .map(stripNumbering)
    .filter((l) => !isHeaderLine(l))
    .map((l) => parseInterview(l, opts));
}
