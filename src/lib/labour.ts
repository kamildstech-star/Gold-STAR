// Labour tracking: hours, days and people against a job, and what that costs.
//
// Time is the largest controllable cost on a restoration job and the one the
// carrier never itemises. These helpers read the database rollups rather than
// recomputing cost in the browser — rate history lives in labour_rates and
// must not be duplicated client-side.

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { TONE } from "@/lib/tone";

export type TimeEntry = Database["public"]["Tables"]["time_entries"]["Row"];
export type TimeEntryStatus = Database["public"]["Enums"]["time_entry_status"];
export type TimeEntryType = Database["public"]["Enums"]["time_entry_type"];
export type LabourRate = Database["public"]["Tables"]["labour_rates"]["Row"];
export type AppRole = Database["public"]["Enums"]["app_role"];

export const TIME_ENTRY_STATUSES: TimeEntryStatus[] = [
  "draft",
  "submitted",
  "approved",
  "rejected",
];

export const TIME_ENTRY_STATUS_LABEL: Record<TimeEntryStatus, string> = {
  draft: "Draft",
  submitted: "Awaiting approval",
  approved: "Approved",
  rejected: "Rejected",
};

export const TIME_ENTRY_STATUS_TONE: Record<TimeEntryStatus, string> = {
  draft: TONE.neutral,
  submitted: TONE.warning,
  approved: TONE.success,
  rejected: TONE.danger,
};

export const TIME_ENTRY_TYPES: TimeEntryType[] = ["labour", "travel", "standby"];

export const TIME_ENTRY_TYPE_LABEL: Record<TimeEntryType, string> = {
  labour: "Labor",
  travel: "Travel",
  standby: "Standby",
};

export type LabourSummary = {
  total_minutes: number;
  approved_minutes: number;
  headcount: number;
  days_on_site: number;
  crew_days: number;
  labour_cost: number;
};

export type PersonHours = {
  user_id: string;
  full_name: string | null;
  minutes: number;
  days: number;
  cost: number;
};

export type Profitability = {
  billed: number;
  collected: number;
  labour_cost: number;
  equipment_days: number;
  total_minutes: number;
  margin: number;
  margin_pct: number;
};

export async function jobLabourSummary(jobId: string): Promise<LabourSummary> {
  const { data, error } = await supabase.rpc("job_labour_summary", { _job_id: jobId });
  if (error) throw error;
  return (
    (data?.[0] as LabourSummary | undefined) ?? {
      total_minutes: 0,
      approved_minutes: 0,
      headcount: 0,
      days_on_site: 0,
      crew_days: 0,
      labour_cost: 0,
    }
  );
}

export async function jobPersonHours(jobId: string): Promise<PersonHours[]> {
  const { data, error } = await supabase.rpc("job_person_hours", { _job_id: jobId });
  if (error) throw error;
  return (data ?? []) as PersonHours[];
}

export async function jobProfitability(jobId: string): Promise<Profitability> {
  const { data, error } = await supabase.rpc("job_profitability", { _job_id: jobId });
  if (error) throw error;
  return (
    (data?.[0] as Profitability | undefined) ?? {
      billed: 0,
      collected: 0,
      labour_cost: 0,
      equipment_days: 0,
      total_minutes: 0,
      margin: 0,
      margin_pct: 0,
    }
  );
}

export async function jobTimeEntries(jobId: string): Promise<TimeEntry[]> {
  const { data, error } = await supabase
    .from("time_entries")
    .select("*")
    .eq("job_id", jobId)
    .order("work_date", { ascending: false })
    .order("started_at", { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Crew-chief bulk entry: one date, one span, several people. Each person still
 * gets their own row so approval, correction and cost stay per-person.
 */
export async function bulkAddTimeEntries(input: {
  jobId: string;
  userIds: string[];
  workDate: string;
  startTime: string;
  endTime: string;
  entryType: TimeEntryType;
  notes?: string | null;
  enteredBy: string;
}): Promise<number> {
  const startedAt = new Date(`${input.workDate}T${input.startTime}`);
  const endedAt = new Date(`${input.workDate}T${input.endTime}`);
  if (Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()))
    throw new Error("Enter a valid start and end time.");
  if (endedAt <= startedAt) throw new Error("End time must be after the start time.");

  const rows = input.userIds.map((user_id) => ({
    job_id: input.jobId,
    user_id,
    work_date: input.workDate,
    started_at: startedAt.toISOString(),
    ended_at: endedAt.toISOString(),
    entry_type: input.entryType,
    status: "submitted" as TimeEntryStatus,
    notes: input.notes ?? null,
    entered_by: input.enteredBy,
  }));
  const { error } = await supabase.from("time_entries").insert(rows);
  if (error) throw error;
  return rows.length;
}

/**
 * Approval and correction both write an audit row. A manager editing crew
 * hours is exactly the change a payroll dispute turns on, so before/after is
 * always kept.
 */
export async function setTimeEntryStatus(
  entry: TimeEntry,
  status: TimeEntryStatus,
  opts: { approverId: string; reason?: string | null },
): Promise<void> {
  const patch: Partial<TimeEntry> = {
    status,
    approved_at: status === "approved" ? new Date().toISOString() : null,
    approved_by: status === "approved" ? opts.approverId : null,
    rejected_reason: status === "rejected" ? (opts.reason ?? null) : null,
  };
  const { error } = await supabase.from("time_entries").update(patch).eq("id", entry.id);
  if (error) throw error;
  await supabase.from("time_entry_corrections").insert({
    time_entry_id: entry.id,
    before_data: { status: entry.status } as never,
    after_data: { status } as never,
    changed_by: opts.approverId,
    reason: opts.reason ?? null,
  });
}

export async function correctTimeEntry(
  entry: TimeEntry,
  patch: {
    started_at?: string;
    ended_at?: string | null;
    entry_type?: TimeEntryType;
    notes?: string | null;
  },
  opts: { changedBy: string; reason: string },
): Promise<void> {
  const { error } = await supabase.from("time_entries").update(patch).eq("id", entry.id);
  if (error) throw error;
  await supabase.from("time_entry_corrections").insert({
    time_entry_id: entry.id,
    before_data: {
      started_at: entry.started_at,
      ended_at: entry.ended_at,
      entry_type: entry.entry_type,
      notes: entry.notes,
    } as never,
    after_data: patch as never,
    changed_by: opts.changedBy,
    reason: opts.reason,
  });
}

/* ------------------------------------------------------------------ */
/* Rates                                                               */
/* ------------------------------------------------------------------ */

export async function listLabourRates(locationId?: string | null): Promise<LabourRate[]> {
  let q = supabase.from("labour_rates").select("*").order("effective_from", { ascending: false });
  if (locationId) q = q.or(`location_id.is.null,location_id.eq.${locationId}`);
  const { data, error } = await q;
  if (error) throw error;
  return data ?? [];
}

/**
 * Rates are effective-dated, never edited: closing the current row and opening
 * a new one keeps historical job costs correct after a pay rise.
 */
export async function supersedeRate(input: {
  existing?: LabourRate | null;
  role: AppRole | null;
  userId: string | null;
  /** A field-ticket crew box instead of a role: gsr (Gold Star) or temp. */
  crewClass?: "gsr" | "temp" | null;
  locationId: string | null;
  hourlyRate: number;
  effectiveFrom: string;
  note: string | null;
  createdBy: string;
}): Promise<void> {
  if (input.existing) {
    const dayBefore = new Date(`${input.effectiveFrom}T00:00:00`);
    dayBefore.setDate(dayBefore.getDate() - 1);
    const { error } = await supabase
      .from("labour_rates")
      .update({ effective_to: dayBefore.toISOString().slice(0, 10) })
      .eq("id", input.existing.id);
    if (error) throw error;
  }
  const { error } = await supabase.from("labour_rates").insert({
    role: input.role,
    user_id: input.userId,
    crew_class: input.crewClass ?? null,
    location_id: input.locationId,
    hourly_rate: input.hourlyRate,
    effective_from: input.effectiveFrom,
    note: input.note,
    created_by: input.createdBy,
  });
  if (error) throw error;
}

/** The field crew's cost today at one office: its own rate, else the company-wide one. */
export function officeCrewCost(
  rates: readonly LabourRate[],
  officeId: string,
  today = new Date().toISOString().slice(0, 10),
): { rate: number; own: boolean } | null {
  const live = rates
    .filter(
      (r) =>
        r.crew_class === "gsr" &&
        r.user_id === null &&
        r.effective_from <= today &&
        (!r.effective_to || r.effective_to >= today),
    )
    .sort((x, y) => y.effective_from.localeCompare(x.effective_from));
  const own = live.find((r) => r.location_id === officeId);
  if (own) return { rate: Number(own.hourly_rate), own: true };
  const all = live.find((r) => r.location_id === null);
  return all ? { rate: Number(all.hourly_rate), own: false } : null;
}

/**
 * The job ledger's Labor cost rate for an office (David, 23 Oct: "field hours
 * by the cost put in to the crew cost"), read from the field crew rates.
 * Null when none is set or the rates cannot be read (only managers may).
 */
export async function fetchLedgerLaborCosts(
  locationIds: readonly string[],
): Promise<Map<string, { rate: number; source: string } | null>> {
  const out = new Map<string, { rate: number; source: string } | null>();
  const { data, error } = await supabase
    .from("labour_rates")
    .select("*")
    .eq("crew_class", "gsr")
    .is("user_id", null);
  for (const id of locationIds) {
    const c = error ? null : officeCrewCost((data ?? []) as LabourRate[], id);
    out.set(
      id,
      c
        ? { rate: c.rate, source: c.own ? "this office's crew cost" : "the default crew cost" }
        : null,
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

export function fmtHours(minutes: number | null | undefined): string {
  if (!minutes) return "0h";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${String(m).padStart(2, "0")}m` : `${h}h`;
}

export function fmtMoney(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
  });
}
