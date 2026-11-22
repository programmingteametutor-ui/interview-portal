export type AppRole = "SUPER_ADMIN" | "ADMIN" | "HANDLER" | "SETUP_SUPPORT" | "TECH_SUPPORT";
export type CallOutcome = "scheduled" | "completed" | "rescheduled" | "cancelled";
export type RequestStatus = "pending" | "approved" | "rejected";
export type SelectionStatus = "in_progress" | "selected" | "rejected" | "on_hold";
export type IncentiveStatus = "pending" | "approved" | "paid" | "rejected";

export interface RoleAssignment {
  role: AppRole;
  team_id: string | null;
  handler_id: string | null;
  handler_name: string | null;
  team_name: string | null;
}
export interface MyContext {
  linked: boolean;
  needs_link?: boolean;
  user?: { id: string; email: string; name: string; primary_team_id: string | null };
  roles?: RoleAssignment[];
  teams?: { id: string; name: string }[];
}

export interface Team { id: string; name: string; support_mode: string; require_identity: boolean; active: boolean; notes: string | null }
export interface Handler {
  id: string; name: string; team_id: string; email: string | null; aliases: string[]; active: boolean;
  in_auto_pool: boolean; is_fallback: boolean; night_eligible: boolean; sort_order: number; notes: string | null;
}
export interface Interview {
  id: string; call_code: string; team_id: string; work_date: string; seq: number; raw_text: string;
  candidate_name: string | null; candidate_id: string | null; client_name: string | null; client_id: string | null;
  job_role: string | null; location_tag: string | null; round_label: string | null; round_no: number | null;
  is_loop: boolean; time_label: string | null; start_min: number | null; duration_min: number | null; is_night: boolean;
  parse_ok: boolean; parse_note: string | null; handler_id: string | null; assignment_mode: string | null;
  outcome: CallOutcome; selection: SelectionStatus; selection_date: string | null; source: string;
}
export interface OutcomeRequest {
  id: string; interview_id: string; team_id: string; kind: "outcome" | "correction";
  previous_outcome: CallOutcome | null; requested_outcome: CallOutcome; handler_id: string | null;
  status: RequestStatus; submitted_email: string | null; submitted_at: string; reviewed_email: string | null;
  reviewed_at: string | null; review_note: string | null;
}
export interface ReassignmentRequest {
  id: string; interview_id: string; team_id: string; from_handler_id: string | null; to_handler_id: string;
  status: RequestStatus; requested_email: string | null; requested_at: string; review_note: string | null;
}
export interface SelectionRequest {
  id: string; interview_id: string; team_id: string; current_selection: SelectionStatus | null;
  requested_selection: SelectionStatus; selection_date: string | null; status: RequestStatus;
  requested_email: string | null; requested_at: string;
}
export interface Incentive {
  id: string; team_id: string; type: "promotion" | "selection"; candidate_name: string; client_name: string;
  from_round: string | null; to_round: string | null; previous_date: string | null; event_date: string;
  handler_id: string | null; handler_name: string; amount: number; status: IncentiveStatus; source: string;
  notes: string | null; created_at: string;
}
export interface MonthlySummary {
  team_id: string; month: string; handler_id: string | null; handler_name: string;
  promotion_amount: number | null; selection_amount: number | null; total_amount: number;
  promotion_count: number; selection_count: number; paid_amount: number | null;
}
export interface CallStats {
  team_id: string; month: string; handler_id: string | null; handler_name: string | null; total_calls: number;
  completed: number; rescheduled: number; cancelled: number; open_calls: number; night_calls: number; selections: number;
}
export interface AppUser { id: string; email: string; official_name: string; primary_team_id: string | null; active: boolean; auth_user_id: string | null; notes: string | null }
export interface UserRoleRow { id: string; user_id: string; role: AppRole; team_id: string | null; handler_id: string | null; active: boolean }
