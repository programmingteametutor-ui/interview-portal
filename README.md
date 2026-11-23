# Interview & Incentive Portal — React + Supabase

Replaces the Google Sheets + Apps Script system:

| Old | New |
|---|---|
| Call Tracker (`InterviewBot 2026`, Preference List, Scheduler/Optimizer) | **Day Intake** page + `shared/scheduler.ts` + `interviews`, `handler_preferences`, `handler_leaves` |
| Incentive tracker / HYD Incentive Tracker (`Raw Data`, `Team Data`, `Portal Call Status`) | one `interviews` table (team column), outcome fields |
| Incentive Backend - Private / HYD … Private (requests, Incentive Tracker, Summary, Action Log, V2 masters) | `outcome_requests`, `reassignment_requests`, `selection_requests`, `incentives`, `monthly_incentive_summary` view, `audit_log`, `teams`, `handlers`, `app_users`, `user_roles` |
| Interview Portal Control (Candidate/Client Master + Name Maps) | `candidates`, `candidate_aliases`, `clients`, `client_aliases` + **Identity Mapping** page |
| Interview Incentive Portal web app (OTP login, roles, pages) | `web/` React app, Supabase email-code login, Row Level Security |

```
supabase/migrations/   7 SQL files: schema, access/RLS, operations RPCs, incentive engine, auth hook, phase 2, parity pack
supabase/functions/    coverage-desk-export (Edge Function replacing PortalCoverageDeskExport.gs)
shared/                parser.ts (Parser.gs), scheduler.ts (Scheduler.gs), recovery.ts (RecoveryEngine.gs + PossibleMatches.gs)
web/                   React 19 + Vite + TypeScript + Tailwind 4 app
scripts/import/        ExportForSupabase.gs (sheets → CSV) and import.ts (CSV → one SQL file)
scripts/test/          parser parity test, scheduler tests, local DB rebuild, UI smoke test
supabase/tests/        end-to-end workflow + RLS test
```

---

See **COVERAGE.md** for a function-by-function map from the old Apps Script portal.

## 1. Create the database

1. Create a Supabase project (region **Mumbai / ap-south-1** is closest to the team).
2. Apply the migrations **in order**, either:
   - `supabase link --project-ref <ref> && supabase db push` (Supabase CLI), or
   - paste each file from `supabase/migrations/` into **SQL Editor → Run**, in file-name order (1 → 8).
     Don't skip `…000008_api_grants.sql`: newer Supabase projects don't grant table access to logged-in
     users automatically, and without it every page fails with "permission denied for table …".

## 2. Configure login (email one-time code)

In the Supabase dashboard:

1. **Authentication → Providers → Email**: enabled. Turn **Confirm email** on.
2. **Authentication → Email Templates → Magic Link**: put the code in the body so people get a 6-digit code instead of a link, e.g.
   `Your portal code is {{ .Token }}` (you can keep `{{ .ConfirmationURL }}` too).
3. **Authentication → Hooks → Before User Created** → *Postgres function* → `public.hook_before_user_created`.
   This rejects any email that is not registered in `app_users`. Without it, strangers could create a login, but RLS still shows them nothing.
4. **Authentication → URL Configuration → Site URL**: your deployed app URL.

Users are linked automatically on first login by email (a trigger on `auth.users`).

### Google sign-in ("Continue with Google")

1. **Google Cloud Console → APIs & Services**:
   - **OAuth consent screen**: user type *External* (or *Internal* if everyone is on one Google Workspace), add scopes `email`, `profile`, `openid`, then publish it.
   - **Credentials → Create credentials → OAuth client ID → Web application**:
     - *Authorized JavaScript origins*: your app URL(s), e.g. `https://portal.example.com`, `http://localhost:5173`
     - *Authorized redirect URIs*: `https://<project-ref>.supabase.co/auth/v1/callback`
   - Copy the **Client ID** and **Client secret**.
2. **Supabase → Authentication → Providers → Google**: enable it and paste the Client ID and secret.
3. **Supabase → Authentication → URL Configuration → Redirect URLs**: add every app URL people sign in from
   (e.g. `https://portal.example.com/**`, `http://localhost:5173/**`).

The same rules apply as for email codes: the **Before User Created** hook (step 2.3) rejects Google accounts whose
email is not in `app_users`. Registered users are linked by email. A user who signed in with an email code before
can use Google with the same address and lands in the same account. No database change is needed.

## 3. Migrate the data from Google Sheets

1. Open any Apps Script project that can open the workbooks (e.g. *Interview Incentive Portal*), add
   `scripts/import/ExportForSupabase.gs`, run **`exportForSupabase`**. It writes every needed tab as
   `"<Workbook> - <Tab>.csv"` into a new Drive folder (read-only on the sheets). Download the folder.
2. Generate the SQL and load it (use the **Session pooler / direct** connection string from Settings → Database):
   ```bash
   npm i -g tsx                       # or: npx tsx …
   tsx scripts/import/import.ts --dir ./Supabase-Export-YYYYMMDD-HHMM --out seed.sql
   psql "$SUPABASE_DB_URL" -v ON_ERROR_STOP=1 -f seed.sql
   ```
   It runs in one transaction and is safe to re-run. It prints row counts per sheet.
3. Run the incentive scan once per team (Incentives page → **Scan for new**, or SQL as an admin). Legacy ledger
   rows are kept **exactly** (amount + Pending/Approved/Paid); the scan only adds what's missing and skips
   anything already in the legacy ledger.

What the importer does:
- Teams, handlers (duplicate *Dhruva* HAN-000019 merged into HAN-000001), users, multi-roles, Settings amounts.
- Candidate/Client masters + name maps + legacy alias tabs.
- **Raw Data** → interviews; **Team Data** matched on (date, text, nth duplicate) → handler, outcome
  (handler name → completed, `Rescheduled`, `Cancelled`, `Support`), selection + selection date.
- **Portal Call Status**, outcome / correction / reassignment request history, last 5,000 action-log rows.
- Call IDs are recomputed with the same SHA-256 scheme as the portal, so legacy `CALL-…` IDs match exactly.
- All past days are marked closed except the latest one per team.

## 4. Run / deploy the app

```bash
cd web
cp .env.example .env          # set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY (Settings → API)
npm install
npm run dev                   # http://localhost:5173
npm run build                 # outputs web/dist — deploy to Vercel / Netlify / Cloudflare Pages
```
Routing is hash-based (`#/schedule`), so no rewrite rules are needed on the host.

## 5. Daily workflow

1. **Admin → Day Intake**: pick the working date, paste the list (numbering and date header lines are ignored), **Parse**,
   review flagged lines, **Save**. Re-pasting a day is safe.
2. **Auto-assign…** shows proposed handlers (preference list → least-loaded available handler; night calls ≥ 2:00 AM use
   weekly night fairness; fallback handler when all busy; otherwise Support) → **Apply**. Any row can be changed by hand.
3. **Handlers → Call Schedule**: mark *Completed / Rescheduled / Cancelled*, request a transfer, mark selections,
   request corrections. Works on phones.
4. **Admin → Approvals**: approve per handler/day batch (or all). Transfers, corrections, selections have their own tabs.
5. **Close day** (Day Intake) once nothing is pending → scans for new promotions/selections.
6. **Incentives**: approve / mark paid / reject, export CSV. **Monthly Summary** = handler × month totals.
7. Weekly: **Recovery → Run recovery scan**, review; **Identity → Suggested client aliases**; glance at **Data Health**.

### Roles (same as the old portal)

| Role | Sees |
|---|---|
| Super Admin | everything, all teams, Users & Roles, incentive amounts, teams |
| Admin | own team: intake, approvals, incentives, handlers, preferences, leave, audit |
| Handler | own calls (team schedule read-only), own incentives, identity mapping |
| Setup Support / Technical Support | dashboard, schedule (read), reports |

People with several roles switch with **Acting as** in the header. Every rule is enforced in the database (RLS +
`SECURITY DEFINER` functions), not only in the UI.

### Incentive rules (ported from Engine/PromotionEngine/TeamLookup)
- Earning call = approved **Completed** call with a handler and a numbered round.
- Proof = earliest later interview for the same candidate + client at a **higher** round that wasn't cancelled
  (rescheduled still counts; a "Rescheduled from …" copy supersedes the earlier occurrence; same-day only R→R+1 or Loop).
- 1st round → ₹100, 2nd+ → ₹500, selection → ₹2,000 (editable in Administration → Incentive Amounts).
- Ledger is permanent: amounts/status of existing rows never change on re-scan.

## 6. Tests

```bash
tsx scripts/test/parser-parity.ts "<path>/Parser.js" incentive_tracker.json   # vs the original Apps Script parser
tsx scripts/test/scheduler.test.ts
tsx scripts/test/recovery-parity.ts "<path>/RecoveryEngine.js" incentive_tracker.json  # vs the original RecoveryEngine.gs
psql -d portal_test -f supabase/tests/20_phase2_test.sql                            # after 10_workflow_test.sql
PGHOST=… scripts/test/rebuild-local-db.sh portal_test && psql -d portal_test -f supabase/tests/10_workflow_test.sql
NODE_PATH=<global node_modules> node scripts/test/ui-smoke/run.mjs /tmp/ui-smoke   # headless render of every page (mock data)
```
Results at hand-off: parser matches the original on all fields for 13,568 real lines (differences are improvements:
status notes no longer glued to client names); legacy ledger rows reproduced 79/79 by the SQL engine; RLS + workflow
test passes; all 10 pages render with no runtime errors.

## Phase 2

| Old | New |
|---|---|
| Promotion Recovery, Recovery Exceptions, Recovery Evidence, Recovery Applied Log (`RecoveryEngine.gs`, `PortalRecovery.gs`) | **Recovery** page + `promotion_recoveries` table. *Run recovery scan* uses `shared/recovery.ts` (same scoring: candidate ≥ 90, client ≥ 88, confidence ≥ 95 with 50/30/10/10 weights, same-day and ambiguity rules). Each item shows the earning call and the proof side by side; **Approve** writes it to the ledger (`source = recovery`), **Reject** / **Dismiss** keep it out. For ambiguous items the admin picks which interview is the proof. |
| Possible Matches + approveAliases | Identity → **Suggested client aliases**: same candidate, client written two ways (≥ 88 %). Accept = one-click alias. |
| `PortalCoverageDeskExport.gs` (doPost, target `coverageDesk`) | Edge Function `coverage-desk-export` — same request/response JSON, so the Coverage Desk app only changes URL + secret. Adds `initialAssignee` tracking (`interviews.initial_handler_id`). |
| Test-as view (`setPortalTestView`) | Super Admin → **View as…** in the header: see exactly what a user sees, read-only (every action is blocked while previewing). |
| `dataintegrity` page | **Data Health**: unparsed lines, unassigned/open calls on closed days, stale requests, pending recoveries, unmapped names, duplicate pastes, past days left open. |
| Legacy Selection Requests, Recovery decisions | Imported. Rejected recoveries from the sheets stay rejected after the first scan (`legacy_recovery_decisions`). |

**Deploying the Coverage Desk export**
```bash
supabase functions deploy coverage-desk-export --no-verify-jwt
supabase secrets set COVERAGE_DESK_EXPORT_SECRET="$(openssl rand -hex 32)"
```
Then in the Coverage Desk (Vercel) settings, point the portal URL to
`https://<project-ref>.supabase.co/functions/v1/coverage-desk-export` and set `COVERAGE_DESK_PORTAL_SECRET` to the same secret.

**Phase 2 checks at hand-off:** recovery scoring identical to `RecoveryEngine.gs` on 9,801 real name pairs; on the PA history with the
full legacy ledger (871 rows) the scan returns 9 recoveries + 20 same-day reviews, matching the legacy Promotion Recovery sheet
(Alten, Red Bull, Lahari B, Home Depot, PNC, MetroHealth, Toro…); the legacy "Rejected" decision carries over; forged scan rows are
rejected by the database; approving a recovery never creates a duplicate with the regular scan.

**Parser fix found during Phase 2:** lines written `Interview – (Interview) - Client - Role` made the legacy parser use “(Interview)” as
the client, which merged different clients for one candidate and could create false promotions. Fixed (19 lines in your history).

## Still open
- Setup-support capacity scheduling: the legacy system only *planned* this (“protected setup-gap rule will be configured in scheduler
  phase”). Send the rule you want (e.g. minimum gap between a handler's calls on self-support teams) and it slots into `shared/scheduler.ts`.
- Email/WhatsApp notifications for approvals.
- HYD data has not been test-imported yet (its tabs weren't available here); the importer treats it exactly like the PA team.
