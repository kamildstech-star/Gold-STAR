import { supabase } from "@/integrations/supabase/client";
import { enqueue, newId } from "@/lib/offline-queue";
import type { Incident } from "@/lib/incidents";

export type { BuildingType, ExposureSuggestion } from "@/lib/exposures.server";
export { BUILDING_TYPE_LABEL } from "@/lib/exposures.server";

/**
 * Origin and exposures are siblings, not parent and child. They share a group
 * id and nothing else — separate homeowner, carrier, claim, outcome and job.
 * An outcome on one never touches another.
 */
export type ExposureInput = {
  originIncidentId: string;
  address: string;
  lat?: number | null;
  lon?: number | null;
  postalCode?: string | null;
  buildingType?: string | null;
};

export type ExposureResult = { id: string | null; queued: boolean };

/**
 * A tap creates the lead there and then — no confirm step. With no signal it
 * goes on the same queue as the rest of the chase flow and lands when service
 * returns; the chaser sees it as added either way.
 */
export async function createExposure(input: ExposureInput): Promise<ExposureResult> {
  const payload = {
    originIncidentId: input.originIncidentId,
    address: input.address,
    lat: input.lat ?? null,
    lon: input.lon ?? null,
    postalCode: input.postalCode ?? null,
    buildingType: input.buildingType ?? null,
  };
  // The queue item id is the server's idempotency key, so a retry after a
  // dropped response can't create the same neighbour twice.
  const id = newId();

  if (typeof navigator !== "undefined" && !navigator.onLine) {
    await enqueue({ kind: "exposure", payload, label: input.address, id });
    return { id: null, queued: true };
  }

  try {
    const { data, error } = await supabase.rpc("apply_offline_op", {
      _key: id,
      _kind: "exposure",
      _payload: payload as never,
      _client_created_at: new Date().toISOString(),
    });
    if (error) throw new Error(error.message);
    const res = data as { result?: unknown } | null;
    return { id: (res?.result as string) ?? null, queued: false };
  } catch {
    // Treat a failed write on a flaky connection as offline rather than losing it.
    await enqueue({ kind: "exposure", payload, label: input.address, id });
    return { id: null, queued: true };
  }
}

/** Undo a tap: only the creator, only while the lead is still untouched. */
export async function undoExposure(incidentId: string): Promise<void> {
  const { error } = await supabase.rpc("undo_exposure_incident", { _incident_id: incidentId });
  if (error) throw error;
}

/** Every sibling in the group, origin included. */
export async function fetchExposureGroup(incident: Incident): Promise<Incident[]> {
  const groupId = incident.exposure_group_id ?? incident.id;
  const { data, error } = await supabase
    .from("incidents")
    .select("*")
    .eq("exposure_group_id", groupId)
    .order("created_at");
  if (error) throw error;
  return (data as Incident[]) ?? [];
}

/* ------------------------------------------------------------------ */
/*  Group view — the fire and every neighbour under it, side by side   */
/* ------------------------------------------------------------------ */

export type ExposureGroupRow = {
  id: string;
  address: string;
  isExposure: boolean;
  status: string;
  lifecycle: string;
  outcome: string | null;
  ownerId: string | null;
  ownerName: string | null;
  jobId: string | null;
  value: number | null;
};

export type ExposureGroup = {
  groupId: string;
  origin: ExposureGroupRow | null;
  exposures: ExposureGroupRow[];
};

/**
 * Reads the whole group in one go: the fire, its neighbours, who owns each
 * lead and what it signed for. Outcomes are read per row — nothing here rolls
 * one row's result onto another.
 */
export async function fetchExposureGroupDetail(
  incident: Pick<Incident, "id" | "exposure_group_id">,
  opts: { canSeeMoney: boolean },
): Promise<ExposureGroup> {
  const groupId = incident.exposure_group_id ?? incident.id;
  const { data, error } = await supabase
    .from("incidents")
    .select("id,address,is_exposure,status,lifecycle,outcome,accepted_by,job_id,created_at")
    .eq("exposure_group_id", groupId)
    .order("created_at");
  if (error) throw error;

  const rows = data ?? [];
  const ownerIds = [...new Set(rows.map((r) => r.accepted_by).filter(Boolean))] as string[];
  const jobIds = [...new Set(rows.map((r) => r.job_id).filter(Boolean))] as string[];

  const [owners, jobs] = await Promise.all([
    ownerIds.length
      ? supabase.from("profiles").select("user_id,full_name").in("user_id", ownerIds)
      : Promise.resolve({ data: [] as { user_id: string; full_name: string | null }[] }),
    opts.canSeeMoney && jobIds.length
      ? supabase
          .from("jobs")
          .select("id,estimated_amount,approved_amount,billed_amount")
          .in("id", jobIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[] }),
  ]);

  const nameOf = new Map((owners.data ?? []).map((p) => [p.user_id, p.full_name ?? null] as const));
  const valueOf = new Map(
    (
      (jobs.data ?? []) as {
        id: string;
        estimated_amount: number | null;
        approved_amount: number | null;
        billed_amount: number | null;
      }[]
    ).map(
      (j) =>
        [j.id, Number(j.billed_amount ?? j.approved_amount ?? j.estimated_amount ?? 0)] as const,
    ),
  );

  const mapped: ExposureGroupRow[] = rows.map((r) => ({
    id: r.id,
    address: r.address ?? "—",
    isExposure: r.is_exposure,
    status: r.status,
    lifecycle: r.lifecycle,
    outcome: r.outcome,
    ownerId: r.accepted_by,
    ownerName: r.accepted_by ? (nameOf.get(r.accepted_by) ?? null) : null,
    jobId: r.job_id,
    value: r.job_id ? (valueOf.get(r.job_id) ?? null) : null,
  }));

  return {
    groupId,
    origin: mapped.find((r) => !r.isExposure) ?? null,
    exposures: mapped.filter((r) => r.isExposure),
  };
}
