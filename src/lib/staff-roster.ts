/**
 * The staff roster as the admin screen shows it — see
 * 20261022120000_staff_roster_import.sql and staff-roster.functions.ts.
 * Pure, so the summary and the per-row actions are tested without a DOM.
 */

export type RosterOutcome =
  "created" | "updated" | "unchanged" | "awaiting_account" | "held" | "error";

export type RosterProvisionMode = "account" | "link" | "invite";

export type StaffRosterRow = {
  email: string;
  full_name: string;
  roles: string[];
  job_title: string | null;
  primary_office: string | null;
  office_scope: "primary" | "all" | "all_except";
  except_office: string | null;
  invite_policy: "invite" | "hold";
  note: string | null;
  user_id: string | null;
  last_outcome: RosterOutcome | null;
  last_detail: string | null;
  invited_at: string | null;
  account_created_at: string | null;
};

export const ROSTER_OUTCOME_LABEL: Record<RosterOutcome, string> = {
  created: "Account created",
  updated: "Updated",
  unchanged: "Up to date",
  awaiting_account: "Needs an account",
  held: "Held (no invite)",
  error: "Error",
};

/** Counts per outcome, for the panel's summary line. */
export function rosterSummary(rows: readonly StaffRosterRow[]): Record<RosterOutcome, number> {
  const out: Record<RosterOutcome, number> = {
    created: 0,
    updated: 0,
    unchanged: 0,
    awaiting_account: 0,
    held: 0,
    error: 0,
  };
  for (const r of rows) {
    const k: RosterOutcome = r.last_outcome ?? (r.user_id ? "unchanged" : "awaiting_account");
    out[k] += 1;
  }
  return out;
}

/** What the admin may do with a row. A held row is never invited. */
export function rosterActions(r: StaffRosterRow): RosterProvisionMode[] {
  if (r.user_id) return [];
  if (r.invite_policy === "hold") return ["account"];
  return ["invite", "link", "account"];
}

/** "Lakewood, NJ", "All offices (primary Brooklyn, NY)", … */
export function rosterOfficeText(r: StaffRosterRow, label: (key: string) => string): string {
  const primary = r.primary_office ? label(r.primary_office) : null;
  if (r.office_scope === "all") return `All offices${primary ? ` (primary ${primary})` : ""}`;
  if (r.office_scope === "all_except") {
    const except = r.except_office ? label(r.except_office) : "one";
    return `All except ${except}${primary ? ` (primary ${primary})` : ""}`;
  }
  return primary ?? "No office";
}
