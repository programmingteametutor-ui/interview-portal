// Compares the ported parser with the original Apps Script Parser.gs on real rows.
// usage: tsx scripts/test/parser-parity.ts <path/to/Parser.js> <incentive_tracker.json>
import fs from "node:fs";
import vm from "node:vm";
import { parseInterview, normKey } from "../../shared/parser";

const [parserPath, dataPath] = process.argv.slice(2);
const ctx: any = { console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(parserPath, "utf8"), ctx);
// Stub the sheet-backed identity layer: keep names as written.
vm.runInContext(`
  PARSER_identityCanonicalCandidate_ = function(n){ return n; };
  PARSER_reconcileClientFromFullSourceV16_ = function(o, info){ return info; };
  PARSER_identityResolveClientRoleFromParts_ = function(parts){ return { client: parts[0], role: parts.slice(1).join(" - ") }; };
`, ctx);

const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const lines: string[] = [];
for (const r of data["Raw Data"]) if (r[1] && !/^\d{1,2}\/\d{1,2}\/\d{4}/.test(r[1])) lines.push(r[1]);
for (const r of data["Team Data"]) if (r[1]) lines.push(r[1]);

let both = 0, onlyOld = 0, onlyNew = 0, neither = 0;
const diffs: Record<string, number> = { candidate: 0, round: 0, time: 0, client: 0 };
const samples: Record<string, string[]> = { candidate: [], round: [], time: [], client: [], onlyOld: [], onlyNew: [] };
for (const line of lines) {
  const o = ctx.parseInterview(line);
  const n = parseInterview(line);
  const okNew = n.parse_ok;
  if (o && okNew) both++; else if (o) { onlyOld++; samples.onlyOld.length < 8 && samples.onlyOld.push(line + "  ::  " + n.parse_note); }
  else if (okNew) { onlyNew++; samples.onlyNew.length < 5 && samples.onlyNew.push(line); } else neither++;
  if (!o || !okNew) continue;
  const chk = (k: string, a: any, b: any) => { if (a !== b) { diffs[k]++; samples[k].length < 6 && samples[k].push(`${line}\n     old=${a} | new=${b}`); } };
  chk("candidate", normKey(o.candidate), normKey(n.candidate_name));
  chk("round", o.roundNo, n.round_no);
  // old regex misreads "2.35 am" as "35:00 AM"; skip those
  if (!/\d[.]\d{2}\s*[ap]m/i.test(line)) chk("time", o.time || null, n.time_label);
  // old parser splits Mercedes-Benz into "Mercedes"/"Benz"; compare normalized w/o spaces
  chk("client", normKey(o.client).replace(/ /g, ""), normKey(n.client_name).replace(/ /g, "").slice(0, normKey(o.client).replace(/ /g, "").length));
}
console.log({ total: lines.length, both, onlyOld, onlyNew, neither, diffs });
for (const [k, v] of Object.entries(samples)) if (v.length) console.log(`\n--- ${k} ---\n` + v.join("\n"));
