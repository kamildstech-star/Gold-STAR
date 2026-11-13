import { useQuery } from "@tanstack/react-query";
import { Flame, Home } from "lucide-react";

import { useCan } from "@/lib/permissions";
import { OUTCOME_LABEL, type Incident, type IncidentOutcome } from "@/lib/incidents";
import { fetchExposureGroupDetail, type ExposureGroupRow } from "@/lib/exposures";

/**
 * The fire and every neighbour taken off it, each with its own status, owner,
 * outcome and value. Signing the fire says nothing about the house next door
 * and vice versa — this panel is where a chaser reads that at a glance.
 */
export function ExposureGroupPanel({
  incident,
  onOpen,
}: {
  incident: Incident;
  onOpen?: (incidentId: string) => void;
}) {
  const canViewCommission = useCan("commission.view");
  const canViewMargin = useCan("job.view_margin");
  const canMoney = canViewCommission || canViewMargin;

  const q = useQuery({
    queryKey: [
      "chase",
      "exposure-group-detail",
      incident.exposure_group_id ?? incident.id,
      canMoney,
    ],
    queryFn: () => fetchExposureGroupDetail(incident, { canSeeMoney: canMoney }),
    staleTime: 30_000,
  });

  const group = q.data;
  if (!group || group.exposures.length === 0) return null;

  const signed = group.exposures.filter((e) => e.outcome === "contract_signed").length;
  const open = group.exposures.filter((e) => !e.outcome).length;

  return (
    <div className="space-y-2 rounded-sm border px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <div className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
          Exposure group
        </div>
        <div className="text-[11px] text-muted-foreground">
          {group.exposures.length} neighbor{group.exposures.length === 1 ? "" : "s"} · {signed}{" "}
          signed
          {open > 0 ? ` · ${open} open` : ""}
        </div>
      </div>

      <div className="divide-y">
        {group.origin && (
          <GroupRow
            row={group.origin}
            current={group.origin.id === incident.id}
            canMoney={canMoney}
            onOpen={onOpen}
          />
        )}
        {group.exposures.map((e) => (
          <GroupRow
            key={e.id}
            row={e}
            current={e.id === incident.id}
            canMoney={canMoney}
            onOpen={onOpen}
          />
        ))}
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">
        Each address is its own lead — own owner, own contract, own job. An outcome on one never
        changes another.
      </p>
    </div>
  );
}

function GroupRow({
  row,
  current,
  canMoney,
  onOpen,
}: {
  row: ExposureGroupRow;
  current: boolean;
  canMoney: boolean;
  onOpen?: (id: string) => void;
}) {
  const state = row.outcome
    ? OUTCOME_LABEL[row.outcome as IncidentOutcome]
    : row.ownerId
      ? "Claimed"
      : "Open";
  const won = row.outcome === "contract_signed";

  return (
    <button
      type="button"
      disabled={!onOpen || current}
      onClick={() => onOpen?.(row.id)}
      className={
        "flex w-full items-center justify-between gap-2 py-1.5 text-left text-[13px] " +
        (current ? "opacity-100" : onOpen ? "hover:bg-accent/40" : "")
      }
    >
      <span className="flex min-w-0 items-center gap-1.5">
        {row.isExposure ? (
          <Home className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <Flame className="size-3.5 shrink-0 text-[var(--brand-red)]" />
        )}
        <span className="min-w-0">
          <span className="block truncate font-medium">
            {row.address}
            {current && <span className="ml-1 text-[11px] text-muted-foreground">· this lead</span>}
          </span>
          <span className="block truncate text-[11px] text-muted-foreground">
            {row.isExposure ? "Exposure" : "Origin fire"}
            {row.ownerName ? ` · ${row.ownerName}` : " · unassigned"}
          </span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span
          className={
            "block text-[11px] font-semibold uppercase " +
            (won ? "text-[var(--success)]" : "text-muted-foreground")
          }
        >
          {state}
        </span>
        {canMoney && row.value != null && row.value > 0 && (
          <span className="block text-[11px] text-muted-foreground">
            ${Math.round(row.value).toLocaleString("en-US")}
          </span>
        )}
      </span>
    </button>
  );
}

/**
 * Shown on a neighbour lead so the relationship reads from either direction.
 */
export function ExposureOriginLeadChip({
  incident,
  onOpen,
}: {
  incident: Incident;
  onOpen?: (id: string) => void;
}) {
  const q = useQuery({
    queryKey: ["chase", "exposure-origin", incident.exposure_group_id],
    enabled: !!incident.is_exposure && !!incident.exposure_group_id,
    staleTime: 300_000,
    queryFn: async () => {
      const { data, error } = await (
        await import("@/integrations/supabase/client")
      ).supabase
        .from("incidents")
        .select("id,address")
        .eq("exposure_group_id", incident.exposure_group_id!)
        .eq("is_exposure", false)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });

  if (!incident.is_exposure || !q.data?.address) return null;

  return (
    <button
      type="button"
      disabled={!onOpen}
      onClick={() => onOpen?.(q.data!.id)}
      className="inline-flex items-center gap-1 rounded bg-[var(--brand-red)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--brand-red)]"
      title="This lead came off the fire next door — it carries its own owner, contract and job"
    >
      <Flame className="size-3" />
      Exposure of {q.data.address}
    </button>
  );
}
