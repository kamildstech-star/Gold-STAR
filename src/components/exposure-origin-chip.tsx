import { useQuery } from "@tanstack/react-query";
import { Flame } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";

/**
 * A neighbour job must never look like it walked in off the street. If the job
 * came from an exposure under an original alert, say so on the record — the
 * office reads this before it reads anything else.
 */
export function ExposureOriginChip({ jobId }: { jobId: string }) {
  const q = useQuery({
    queryKey: ["job", "exposure-origin", jobId],
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await supabase.rpc("job_exposure_origin_address", {
        _job_id: jobId,
      });
      if (error) throw error;
      return (data as string | null) ?? null;
    },
    staleTime: 300_000,
  });

  if (!q.data) return null;

  return (
    <span
      className="inline-flex items-center gap-1 rounded bg-[var(--brand-red)]/10 px-2 py-0.5 text-[11px] font-medium text-[var(--brand-red)]"
      title="Created as a damaged neighbor under the original alert"
    >
      <Flame className="size-3" />
      Exposure of {q.data}
    </span>
  );
}
