import { useQuery } from "@tanstack/react-query";
import { PackageOpen } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { countOnSiteByType, type OnSiteCount } from "@/lib/equipment";

/*
 * Equipment on site, counted by type, on the Equipment tab and on the job's
 * main page. David, 24 Sep: "on top of the equipment page, and probably on the
 * main job page — a count of equipment dropped off at the property: air
 * movers 15, dehumidifier 6, stuff like this."
 *
 * Read live from the open placements, so retrieving a unit takes it off the
 * count. The Equipment tab refreshes the `["job-onsite", jobId]` key whenever
 * it places or retrieves, so the header chip follows without a reload.
 */

export const onSiteKey = (jobId: string) => ["job-onsite", jobId] as const;

export function useOnSiteCounts(jobId: string) {
  return useQuery({
    queryKey: onSiteKey(jobId),
    queryFn: async (): Promise<OnSiteCount[]> => {
      const { data, error } = await supabase
        .from("equipment_placements")
        .select("id, equipment:equipment_id(equipment_type)")
        .eq("job_id", jobId)
        .is("retrieved_at", null);
      if (error) throw error;
      return countOnSiteByType(
        ((data ?? []) as unknown as { equipment: { equipment_type: string } | null }[]).map(
          (r) => ({
            equipment_type: r.equipment?.equipment_type ?? null,
          }),
        ),
      );
    },
  });
}

/** The strip atop the Equipment tab: one figure per type. */
export function EquipmentCountStrip({ counts }: { counts: OnSiteCount[] }) {
  if (counts.length === 0) return null;
  return (
    <ul data-onsite-strip className="flex flex-wrap gap-2" aria-label="Equipment on site by type">
      {counts.map((c) => (
        <li
          key={c.type}
          className="flex min-h-11 items-baseline gap-1.5 rounded-sm border bg-card px-3 py-1.5 sm:min-h-9"
        >
          <span className="text-lg font-semibold tabular-nums">{c.count}</span>
          <span className="text-xs text-muted-foreground">{c.label}</span>
        </li>
      ))}
    </ul>
  );
}

/** The compact version for the job's header: "On site: 15 air movers · 6 dehumidifiers". */
export function EquipmentOnSiteChip({ jobId, onOpen }: { jobId: string; onOpen: () => void }) {
  const { data } = useOnSiteCounts(jobId);
  if (!data || data.length === 0) return null;
  const total = data.reduce((s, c) => s + c.count, 0);
  const text = data
    .slice(0, 3)
    .map((c) => `${c.count} ${c.label.toLowerCase()}`)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={onOpen}
      data-onsite-chip
      className="inline-flex min-h-7 items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] hover:bg-accent"
      title={`${total} unit${total === 1 ? "" : "s"} on site — open Equipment on the Drying log tab`}
    >
      <PackageOpen className="size-3.5 text-muted-foreground" aria-hidden />
      <span>
        On site: {text}
        {data.length > 3 ? ` · +${data.length - 3} more` : ""}
      </span>
    </button>
  );
}
