// Compares shared/recovery.ts scoring with the original RecoveryEngine.gs on real name pairs.
// usage: tsx scripts/test/recovery-parity.ts <RecoveryEngine.js> <incentive_tracker.json>
import fs from "node:fs";
import vm from "node:vm";
import { candidateScore, clientScore, confidence } from "../../shared/recovery";
import { parseInterview } from "../../shared/parser";

const [enginePath, dataPath] = process.argv.slice(2);
const ctx: any = { console, Logger: { log() {} }, CONFIG: { RECOVERY: { MIN_CONFIDENCE: 95, CANDIDATE_WEIGHT: 50, CLIENT_WEIGHT: 30, ROUND_WEIGHT: 10, DATE_WEIGHT: 10 } } };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(enginePath, "utf8"), ctx);

const data = JSON.parse(fs.readFileSync(dataPath, "utf8"));
const parsed = (data["Team Data"] as string[][]).map((r) => r[1]).filter(Boolean).map((t) => parseInterview(t)).filter((p) => p.parse_ok);
const cands = [...new Set(parsed.map((p) => p.candidate_name!))];
const clients = [...new Set(parsed.map((p) => p.client_name!))];

// pairs: neighbours in sorted order (similar names) + random pairs
const pairs = (xs: string[]) => {
  const s = [...xs].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const out: [string, string][] = [];
  for (let i = 0; i + 1 < s.length; i++) out.push([s[i], s[i + 1]]);
  let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 3000; i++) out.push([xs[Math.floor(rnd() * xs.length)], xs[Math.floor(rnd() * xs.length)]]);
  return out;
};
let cDiff = 0, kDiff = 0, n = 0; const samples: string[] = [];
for (const [a, b] of pairs(cands)) { n++; const o = ctx.REC_candidateScore(a, b), m = candidateScore(a, b); if (o !== m) { cDiff++; samples.length < 5 && samples.push(`cand ${a} | ${b}: ${o} vs ${m}`); } }
for (const [a, b] of pairs(clients)) { n++; const o = ctx.REC_clientScore(a, b), m = clientScore(a, b); if (o !== m) { kDiff++; samples.length < 10 && samples.push(`client ${a} | ${b}: ${o} vs ${m}`); } }
let confDiff = 0;
for (const [c, k, d] of [[100, 100, 100], [96, 88, 100], [90, 100, 90], [98, 98, 0]]) if (ctx.REC_calculateConfidence(c, k, 100, d) !== confidence(c, k, 100, d)) confDiff++;
console.log({ pairs: n, candidateDiffs: cDiff, clientDiffs: kDiff, confidenceDiffs: confDiff });
samples.forEach((s) => console.log(s));
if (cDiff + kDiff + confDiff) process.exit(1);
