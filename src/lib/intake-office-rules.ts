/**
 * The Territory page's intake office rules — "PA goes to NY-Upstate" — and the
 * re-route of the forms already waiting when a rule changes.
 *
 * Mark: "add in here a address match for intake, that will set certain states
 * to certain offices that overrides the closest match".
 *
 * The matching itself is `matchLocationForAddress` (intake-routing.ts), shared
 * with the public submit. This file only reads and writes the rules
 * (`intake_office_rules`, 20261006170000 — written, not applied: until it is,
 * `available` is false and the page says so) and re-routes waiting forms.
 *
 * Writes are privileged-only in the database (the same predicate that guards
 * markets and zones), so the page that calls these is the only door and RLS
 * is the lock.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import {
  INTAKE_GENERAL_SETTINGS_KEY,
  INTAKE_OFFICE_RULES_TABLE,
  isUsStateCode,
  normalizeZipPrefix,
  planIntakeRematch,
  rulesFromRows,
  type IntakeOfficeRule,
  type RematchCandidate,
  type RoutableLocation,
} from "./intake-routing";
import { isMissingSchema } from "./schema-fallback";

/** The generated types do not know the table until the migration is applied. */
const db = () => supabase as unknown as SupabaseClient;

export type StoredIntakeOfficeRule = IntakeOfficeRule & { id: string };

export const INTAKE_OFFICE_RULES_QUERY_KEY = ["intake-office-rules"] as const;

export async function fetchIntakeOfficeRules(): Promise<{
  available: boolean;
  rules: StoredIntakeOfficeRule[];
}> {
  const { data, error } = await db()
    .from(INTAKE_OFFICE_RULES_TABLE)
    .select("id, match_kind, match_value, location_id")
    .order("match_kind")
    .order("match_value");
  if (error) {
    if (isMissingSchema(error)) return { available: false, rules: [] };
    throw error;
  }
  const rules = ((data ?? []) as { id: string }[]).flatMap((row) =>
    rulesFromRows([row]).map((rule) => ({ ...rule, id: row.id })),
  );
  return { available: true, rules };
}

/**
 * Why a rule cannot be saved, in words, or null when it can. The database
 * checks the same shape; this is so the button can say it before the round
 * trip, and so a duplicate reads as "PA already goes to …", not a constraint.
 */
export function intakeRuleProblem(
  draft: { kind: "state" | "zip"; value: string; locationId: string },
  existing: readonly StoredIntakeOfficeRule[],
  officeName: (id: string) => string,
): string | null {
  if (!draft.locationId) return "Choose the office.";
  const value = draft.kind === "state" ? draft.value.trim().toUpperCase() : draft.value.trim();
  if (draft.kind === "state" && !isUsStateCode(value)) return "Choose a state.";
  if (draft.kind === "zip" && !normalizeZipPrefix(value)) {
    return "A ZIP rule is the first 3 to 5 digits of a ZIP code.";
  }
  const clash = existing.find((r) => r.kind === draft.kind && r.value === value);
  if (clash) return `${value} already goes to ${officeName(clash.location_id)}. Remove that first.`;
  return null;
}

export async function addIntakeOfficeRule(draft: {
  kind: "state" | "zip";
  value: string;
  locationId: string;
}): Promise<void> {
  const value = draft.kind === "state" ? draft.value.trim().toUpperCase() : draft.value.trim();
  const { error } = await db()
    .from(INTAKE_OFFICE_RULES_TABLE)
    .insert({ match_kind: draft.kind, match_value: value, location_id: draft.locationId });
  if (error) throw error;
}

export async function removeIntakeOfficeRule(id: string): Promise<void> {
  const { error } = await db().from(INTAKE_OFFICE_RULES_TABLE).delete().eq("id", id);
  if (error) throw error;
}

const CANDIDATE_COLUMNS =
  "id, job_id, status, fields, location_id, location_auto_assigned, location_route_reason, location_route_detail, intake_requests(job_id, location_id, tradeshow_id)";

/**
 * Route the waiting forms again under the current rules; returns how many
 * moved. Which forms are eligible is `planIntakeRematch` — in short, waiting
 * forms from a general link that the address placed, never one a person
 * placed and never one that is already a job.
 *
 * Each update repeats the eligibility in its filter (still no job, still
 * pending, still auto-assigned or unplaced), so a form that someone turned
 * into a job or re-routed by hand while this ran is left alone.
 */
export async function rematchWaitingIntakes(): Promise<number> {
  const [candidates, locations, setting, rules] = await Promise.all([
    db()
      .from("intake_submissions")
      .select(CANDIDATE_COLUMNS)
      .is("job_id", null)
      .eq("status", "pending"),
    db().from("locations").select("id, code, name, region, locality, lat, lon, active"),
    db().from("app_settings").select("value").eq("key", INTAKE_GENERAL_SETTINGS_KEY).maybeSingle(),
    db().from(INTAKE_OFFICE_RULES_TABLE).select("match_kind, match_value, location_id"),
  ]);
  // Before the migration there is nothing to say why, and no rules to apply.
  if (candidates.error) {
    if (isMissingSchema(candidates.error)) return 0;
    throw candidates.error;
  }
  if (locations.error) throw locations.error;
  if (rules.error) {
    if (isMissingSchema(rules.error)) return 0;
    throw rules.error;
  }

  const rows: RematchCandidate[] = ((candidates.data ?? []) as Record<string, unknown>[]).map(
    (r) => {
      const req = Array.isArray(r.intake_requests) ? r.intake_requests[0] : r.intake_requests;
      return {
        id: r.id as string,
        job_id: (r.job_id as string | null) ?? null,
        status: String(r.status ?? ""),
        fields: (r.fields ?? {}) as Record<string, string | null>,
        location_id: (r.location_id as string | null) ?? null,
        location_auto_assigned: r.location_auto_assigned === true,
        location_route_reason: (r.location_route_reason as string | null) ?? null,
        location_route_detail: (r.location_route_detail as string | null) ?? null,
        request: req
          ? {
              job_id: (req as { job_id?: string | null }).job_id ?? null,
              location_id: (req as { location_id?: string | null }).location_id ?? null,
              tradeshow_id: (req as { tradeshow_id?: string | null }).tradeshow_id ?? null,
            }
          : null,
      };
    },
  );
  const fallback =
    (setting.data?.value as { fallback_location_id?: string | null } | null)
      ?.fallback_location_id ?? null;
  const changes = planIntakeRematch(
    rows,
    (locations.data ?? []) as RoutableLocation[],
    fallback,
    rulesFromRows(rules.data),
  );

  let moved = 0;
  for (const c of changes) {
    const { data, error } = await db()
      .from("intake_submissions")
      .update({
        location_id: c.locationId,
        location_auto_assigned: c.locationId !== null,
        location_route_reason: c.reason,
        location_route_detail: c.detail,
      })
      .eq("id", c.id)
      .is("job_id", null)
      .eq("status", "pending")
      .or("location_auto_assigned.eq.true,location_id.is.null")
      .select("id");
    if (error) throw error;
    moved += (data ?? []).length;
  }
  return moved;
}
