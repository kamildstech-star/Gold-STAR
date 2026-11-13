import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { personLabel } from "@/lib/chat";

/**
 * Competitor sightings: leads closed with the "Another company signed"
 * outcome (`incidents.outcome = 'competitor_present'`). One fetcher feeds both
 * the chase cockpit card (rolling 24 hours) and the Performance snapshot
 * (the page's date range plus the period before it), so the two never drift.
 *
 * Who logged it and which competitor come from the attempt that closed the
 * lead (`log_incident_outcome` writes the competitor into
 * `incident_attempts.sub_reason_label`); `incidents.outcome_detail` is the
 * older free-text column and still wins when it is filled in.
 */

export type CompetitorSighting = {
  id: string;
  competitor: string;
  /** When the outcome was logged (ISO). */
  at: string;
  locationId: string | null;
  /** Zone name, else the incident's locality. */
  area: string;
  loggedBy: string | null;
};

export type CompetitorWindow =
  { kind: "rolling"; hours: number } | { kind: "range"; from: Date; to: Date };

export const UNNAMED_COMPETITOR = "Unnamed competitor";
export const UNKNOWN_AREA = "Unknown area";

type IncidentRow = {
  id: string;
  outcome_detail: string | null;
  outcome_at: string | null;
  locality: string | null;
  location_id: string | null;
  accepted_by: string | null;
  zone: { name: string | null } | null;
};

type AttemptRow = {
  incident_id: string;
  chaser_id: string | null;
  sub_reason_label: string | null;
  attended_at: string;
};

function resolveWindow(w: CompetitorWindow): { from: Date; to: Date | null } {
  if (w.kind === "rolling") return { from: new Date(Date.now() - w.hours * 3_600_000), to: null };
  return { from: w.from, to: w.to };
}

/**
 * Sightings in a window, newest first. `officeIds` narrows "All" while viewing
 * as a person (see usePreviewOfficeScope); null leaves scoping to RLS, exactly
 * as the cockpit card always has.
 */
export async function fetchCompetitorSightings(
  window: CompetitorWindow,
  officeIds: readonly string[] | null,
): Promise<CompetitorSighting[]> {
  if (officeIds && officeIds.length === 0) return [];
  const { from, to } = resolveWindow(window);

  let q = supabase
    .from("incidents")
    .select(
      "id, outcome_detail, outcome_at, locality, location_id, accepted_by, zone:zones!incidents_zone_id_fkey(name)",
    )
    .eq("outcome", "competitor_present")
    .gte("outcome_at", from.toISOString())
    .order("outcome_at", { ascending: false });
  if (to) q = q.lt("outcome_at", to.toISOString());
  if (officeIds) q = q.in("location_id", [...officeIds]);
  const { data, error } = await q;
  if (error) throw error;
  const incidents = (data ?? []) as unknown as IncidentRow[];
  if (incidents.length === 0) return [];

  const { data: attemptData, error: attemptError } = await supabase
    .from("incident_attempts")
    .select("incident_id, chaser_id, sub_reason_label, attended_at")
    .in(
      "incident_id",
      incidents.map((i) => i.id),
    )
    .eq("kept_live", false)
    .order("attended_at", { ascending: false });
  if (attemptError) throw attemptError;
  // Newest closing attempt per incident.
  const closing = new Map<string, AttemptRow>();
  for (const a of (attemptData ?? []) as AttemptRow[]) {
    if (!closing.has(a.incident_id)) closing.set(a.incident_id, a);
  }

  const userIds = [
    ...new Set(
      incidents
        .map((i) => closing.get(i.id)?.chaser_id ?? i.accepted_by)
        .filter((x): x is string => !!x),
    ),
  ];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: people } = await supabase
      .from("profiles")
      .select("user_id, full_name")
      .in("user_id", userIds);
    for (const p of people ?? []) names.set(p.user_id, personLabel(p));
  }

  return incidents.map((i) => {
    const attempt = closing.get(i.id);
    const who = attempt?.chaser_id ?? i.accepted_by;
    const competitor =
      i.outcome_detail?.trim() || attempt?.sub_reason_label?.trim() || UNNAMED_COMPETITOR;
    return {
      id: i.id,
      competitor,
      at: i.outcome_at ?? attempt?.attended_at ?? from.toISOString(),
      locationId: i.location_id,
      area: i.zone?.name?.trim() || i.locality?.trim() || UNKNOWN_AREA,
      loggedBy: who ? (names.get(who) ?? null) : null,
    };
  });
}

/** The same query for every surface; the key carries the window and scope. */
export function useCompetitorSightings(
  window: CompetitorWindow,
  officeIds: readonly string[] | null,
  options: { enabled?: boolean } = {},
) {
  const windowKey =
    window.kind === "rolling"
      ? `${window.hours}h`
      : `${window.from.toISOString()}..${window.to.toISOString()}`;
  return useQuery({
    queryKey: ["competitor-activity", windowKey, officeIds ? officeIds.join(",") : "rls"],
    staleTime: 120_000,
    enabled: options.enabled ?? true,
    queryFn: () => fetchCompetitorSightings(window, officeIds),
  });
}

export type CountRow = { label: string; count: number };

/** Count sightings by a field, biggest first, ties alphabetical. */
export function countBy(
  sightings: readonly CompetitorSighting[],
  key: "competitor" | "area",
): CountRow[] {
  const counts = new Map<string, number>();
  for (const s of sightings) counts.set(s[key], (counts.get(s[key]) ?? 0) + 1);
  return [...counts.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

/** The window of the same length immediately before [from, to). */
export function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - span), to: from };
}
