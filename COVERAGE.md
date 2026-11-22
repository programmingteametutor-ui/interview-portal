# Apps Script → Supabase/React coverage map

Every server function the old **Working Portal.html** called (`google.script.run.*`), and where it lives now.
RPC = Postgres function in `supabase/migrations`, page = `web/src/pages`.

| Old function | New equivalent |
|---|---|
| `sendPortalOtp`, `verifyPortalOtp`, `logoutPortal` | Supabase email one-time code — `Login.tsx`; gate: `hook_before_user_created`; link: `on_auth_user_created`, `claim_my_account` |
| `getPortalAccessContext` | RPC `my_context` → `lib/session.tsx` |
| `setPortalCurrentRole`, `setPortalTeamView` | Header "Acting as" / "Team" switchers (`Layout.tsx`); enforced by RLS |
| `getPortalTestAsOptions`, `setPortalTestView`, `clearPortalTestView` | Header "View as…" → RPC `preview_context`; read-only guard `lib/readonly.ts` |
| `getPortalDashboardData` | `Dashboard.tsx` |
| `getPortalCallScheduleData`, `updatePortalCallStatus` | `Schedule.tsx` (KPIs, calls, statuses) |
| `submitPortalCallOutcome` | RPC `submit_outcome` |
| `getPortalCallApprovalData` | `Approvals.tsx` |
| `approve…` batch (handler/date) | RPC `review_outcome_requests` |
| `reversePortalApprovedCallOutcome` | RPC `reverse_outcome` |
| `repairApprovedPortalCallOutcomeBatch` | Not needed — it re-synced approved outcomes into Team Data/Call Sync Map sheets; outcomes are now written once, transactionally |
| `submitPortalCallOutcomeCorrection`, `reviewPortalCallOutcomeCorrection` | RPC `request_outcome_correction`, `review_outcome_requests` (kind = correction) |
| `submitPortalCallReassignmentRequest` | RPC `request_reassignment`, `review_reassignment` |
| `submitSelectionRequest`, `adminMarkInterviewSelected` | RPC `request_selection`, `review_selection`, `admin_set_selection` |
| `getPortalInterviewStatusData` | `Interviews.tsx` (team-handled interviews, selection status, latest request per call, month/handler/status filters) |
| `getPortalTeamDayControlState`, `completePortalTeamDay` | RPC `work_day_state`, `complete_work_day`, `reopen_work_day` |
| `getPortalSchedulerAdminState`, `getPortalSchedulerReassignOptions`, `portalSchedulerReassignCall` | `Intake.tsx` (auto-assign via `shared/scheduler.ts`, manual handler per call) → RPC `set_assignments` |
| `portalSchedulerSetLeave` | Administration → Leave (`handler_leaves`) |
| `getPortalIdentityMappingOptions`, `getPortalIdentityMappingOptionsBatch` | `Identity.tsx` → RPC `map_identity`, `relink_identities` |
| `getPortalRecoveryData`, `getPortalRecoveryEvidence`, `applyPortalApprovedRecoveries` | `Recovery.tsx` → `shared/recovery.ts`, RPC `save_recovery_scan`, `review_recovery` |
| `getPortalIncentiveScanStatus` | RPC `incentive_scan_status` → panel on Incentive Tracker |
| `getPortalReportsData`, `getPortalCallDashboardData` | `Reports.tsx` → view `daily_call_stats`, RPC `handler_performance` |
| `getPortalAdministrationData`, `savePortalAccessUser`, `savePortalHandlerMasterBatch` | `Admin.tsx` (users, roles, handlers, preference lists, leave, amounts, teams) |
| `bootstrapPortalHandlerMaster` | One-time: done by `scripts/import/import.ts` |

## Pages

| Old page | New page |
|---|---|
| dashboard | Dashboard |
| callschedule | Call Schedule (+ Day Intake for admins) |
| interviews | Interviews |
| tracker | Incentive Tracker |
| promotions | Promotions |
| monthly | Monthly Summary |
| recovery | Recovery |
| reports | Reports |
| administration | Administration |
| (dataintegrity) | Data Health |
| — | Approvals, Identity Mapping, Audit Log (were panels/sheets before) |

## Backend engines

| Old | New |
|---|---|
| `Parser.gs` parseInterview (+ call tracker extractor) | `shared/parser.ts` — same results on 13,568 real lines; fixes "(Interview)" and status-note cases |
| `Scheduler.gs` (V3, availability, weekly night balance, preference list, leave) | `shared/scheduler.ts` |
| `Optimizer.gs` | Not ported — only called from its own test functions |
| `Engine.gs`, `PromotionEngine.gs`, `TeamLookup.gs`, `SelectionDate.gs` | RPC `promotion_candidates`, `recompute_incentives` (79/79 legacy ledger rows reproduced) |
| `Summary.gs` | view `monthly_incentive_summary` |
| `RecoveryEngine.gs`, `RecoveryEvidence.gs`, `RecoveryApproval.gs` | `shared/recovery.ts` + RPCs (identical scoring on 9,801 pairs) |
| `PossibleMatches.gs` | `suggestClientAliases` in `shared/recovery.ts` |
| `PortalCoverageDeskExport.gs` | Edge Function `coverage-desk-export` |
| `Normalizer.gs` | `norm_key` (SQL) / `normKey` (TS) |
| Call IDs (`PC_hash_`) | `call_code_for` — identical IDs |
| OTP emails (`MailApp`) | Supabase Auth |
| 8 `doGet`/`doPost` web apps + `UrlFetchApp` bridges between projects | Not needed — one database |
| `LockService` / `CacheService` | Postgres transactions / row locks |
| Migration, diagnostic, `test*` functions | Not ported (one-off tooling) |
| Setup-support capacity scheduling | Never implemented in Apps Script (only planned) |
