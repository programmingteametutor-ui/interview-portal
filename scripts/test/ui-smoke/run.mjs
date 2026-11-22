// UI smoke test: bundles the app with the mock Supabase client, compiles Tailwind,
// opens every page in headless Chrome, fails on any runtime error, saves screenshots.
// usage: NODE_PATH=/opt/npm-tools/node_modules node scripts/test/ui-smoke/run.mjs <outdir>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

// tools live in a global node_modules (NODE_PATH); ESM import ignores NODE_PATH, so require them
const require = createRequire((process.env.NODE_PATH || "/opt/npm-tools/node_modules") + "/");
const { build } = require("esbuild");
const { compile } = require("tailwindcss");
const { chromium } = require("playwright");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../..");
const out = path.resolve(process.argv[2] || "/tmp/ui-smoke");
fs.mkdirSync(out, { recursive: true });

// 1. bundle
await build({
  entryPoints: [path.join(root, "web/src/main.tsx")], bundle: true, format: "esm", jsx: "automatic",
  outfile: path.join(out, "app.js"), loader: { ".css": "empty", ".json": "json" }, logLevel: "warning",
  alias: { "@shared": path.join(root, "shared"), "@supabase/supabase-js": path.join(root, "scripts/test/ui-smoke/mock-supabase.ts") },
  nodePaths: [process.env.NODE_PATH || "/opt/npm-tools/node_modules"],
  define: { "import.meta.env.VITE_SUPABASE_URL": '"mock"', "import.meta.env.VITE_SUPABASE_ANON_KEY": '"mock"' },
});

// 2. tailwind (v4 compile API; candidates scraped from sources)
const twDir = path.dirname(require.resolve("tailwindcss/package.json", { paths: [process.env.NODE_PATH || "/opt/npm-tools/node_modules"] }));
const src = fs.readdirSync(path.join(root, "web/src"), { recursive: true }).filter((f) => /\.tsx?$/.test(f))
  .map((f) => fs.readFileSync(path.join(root, "web/src", f), "utf8")).join("\n");
const candidates = new Set(src.match(/[a-z0-9:_\-\[\]\/.%#]+/gi));
const compiler = await compile(fs.readFileSync(path.join(root, "web/src/index.css"), "utf8"), {
  base: twDir,
  loadStylesheet: async (id, base) => {
    const file = id === "tailwindcss" ? path.join(twDir, "index.css") : path.resolve(base, id);
    return { content: fs.readFileSync(file, "utf8"), base: path.dirname(file), path: file };
  },
});
fs.writeFileSync(path.join(out, "app.css"), compiler.build([...candidates]));
fs.writeFileSync(path.join(out, "index.html"),
  `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="app.css"></head><body class="bg-slate-50"><div id="root"></div><script type="module" src="app.js"></script></body></html>`);

// 3. browse every page
const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", args: ["--allow-file-access-from-files", "--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const base = "file://" + path.join(out, "index.html");
const pages = ["dashboard", "intake", "schedule", "approvals", "interviews", "incentives", "promotions", "monthly", "recovery", "identity", "reports", "health", "admin", "audit"];
for (const p of pages) {
  await page.goto(`${base}#/${p}`);
  await page.waitForTimeout(700);
  await page.screenshot({ path: path.join(out, `${p}.png`), fullPage: false });
  const h1 = await page.locator("h1").first().textContent().catch(() => null);
  console.log(`${p.padEnd(11)} → ${h1}`);
}
// interactions: schedule for yesterday (pending), approvals batch approve, intake parse + auto-assign
await page.goto(`${base}#/approvals`); await page.waitForTimeout(500);
await page.getByRole("button", { name: /Approve batch/ }).first().click(); await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, "approvals-after.png") });
await page.goto(`${base}#/intake`); await page.waitForTimeout(600);
await page.locator("textarea").fill([
  "S.no,11/21/2026 Saturday",
  "1,Meghana B (UK) – Interview – Expana – 1:30 PM IST – Duration: 30 Mins (2nd Round)",
  "2,Naga Sankar Nakkina – Interview – Mercedes-Benz – 7:30 PM IST – Duration: 45 Mins (1st Round)",
  "3,ramya perumal-FRC-(2nd round)-waiting for invite",
  "4,Pinky Sachdev – Interview – O.C. Tanner - Systems Analyst – 2:30 AM IST – Duration: 30 Mins (1st Round)",
  "5,Some broken line without structure",
].join("\n"));
await page.getByRole("button", { name: "Parse" }).click(); await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, "intake-preview.png"), fullPage: true });
await page.getByRole("button", { name: "Discard" }).click();
// use the latest working date present in the fixture
const latest = JSON.parse(fs.readFileSync(path.join(root, "scripts/test/ui-smoke/fixture.json"), "utf8")).interviews.map((i) => i.work_date).sort().pop();
await page.locator('input[type="date"]').first().fill(latest); await page.waitForTimeout(800);
await page.getByRole("button", { name: /Auto-assign/ }).click(); await page.waitForTimeout(800);
await page.screenshot({ path: path.join(out, "intake-autoassign.png") });
const proposed = await page.locator("text=Proposed assignments").count();
console.log("auto-assign modal:", proposed ? "shown" : "MISSING");
// Phase 2: recovery scan runs the shared engine in the browser; suggestions tab; view-as preview
await page.goto(`${base}#/recovery`); await page.waitForTimeout(500);
await page.getByRole("button", { name: "Run recovery scan" }).click(); await page.waitForTimeout(4000);
const scanArgs = await page.evaluate(() => window.__rpcLog.filter((x) => x[0] === "save_recovery_scan").map((x) => x[1].p_rows.length));
console.log("recovery scan rows sent:", scanArgs);
await page.getByRole("button", { name: /Needs review/ }).click(); await page.waitForTimeout(400);
await page.screenshot({ path: path.join(out, "recovery-review.png") });
await page.goto(`${base}#/identity`); await page.waitForTimeout(400);
await page.getByRole("button", { name: "Suggested client aliases" }).click(); await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, "identity-suggestions.png") });
const handlerUser = await page.evaluate(() => 0);
await page.goto(`${base}#/dashboard`); await page.waitForTimeout(400);
const sel = page.locator("select", { hasText: "View as…" });
await sel.focus(); await page.waitForTimeout(400);
const opts = await sel.locator("option").allTextContents();
const target = opts.find((o) => /dhruvakumarveerla819/.test(o));
if (target) { await sel.selectOption({ label: target }); await page.waitForTimeout(800); }
await page.screenshot({ path: path.join(out, "view-as.png") });
console.log("view-as banner:", await page.locator("text=read-only").count() ? "shown" : "MISSING");
await page.goto(`${base}#/schedule`); await page.waitForTimeout(400);
const btn = page.getByRole("button", { name: "Completed" }).first();
if (await btn.count()) { await btn.click(); await page.waitForTimeout(300); console.log("read-only toast:", await page.locator("text=Preview is read-only").count() ? "shown" : "MISSING"); }
await page.getByRole("button", { name: "Exit preview" }).click(); await page.waitForTimeout(300);
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${base}#/schedule`); await page.waitForTimeout(500);
await page.screenshot({ path: path.join(out, "schedule-mobile.png") });
await browser.close();
if (errors.length) { console.error("RUNTIME ERRORS:\n" + [...new Set(errors)].join("\n")); process.exit(1); }
console.log("ui smoke ok →", out);
