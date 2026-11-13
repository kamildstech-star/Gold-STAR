import { useEffect, useMemo, useState } from "react";
import { fetchPipelines, fetchStages, resolvePipeline, type PipelineStage } from "@/lib/pipeline";

/**
 * Job status is configurable: it lives in `pipeline_stages` on the "Jobs"
 * pipeline (entity_type = 'job'), not in the `job_status` enum. The enum column
 * is still written by a database trigger so older reads keep working, but the
 * stage is the source of truth and the only thing the UI should offer.
 */
export type JobStage = PipelineStage & { is_intake?: boolean; is_exit?: boolean };

export function useJobStages(locationId: string | null) {
  const [stages, setStages] = useState<JobStage[]>([]);
  const [pipelineId, setPipelineId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const pipelines = await fetchPipelines("job");
        const pipeline = resolvePipeline(pipelines, locationId ?? null);
        if (!pipeline) {
          if (!cancelled) {
            setStages([]);
            setPipelineId(null);
          }
          return;
        }
        const rows = (await fetchStages(pipeline.id)) as JobStage[];
        if (!cancelled) {
          setPipelineId(pipeline.id);
          setStages(rows.filter((s) => s.is_active));
        }
      } catch {
        if (!cancelled) setStages([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [locationId]);

  const stageById = useMemo(() => new Map(stages.map((s) => [s.id, s] as const)), [stages]);
  const stageByKey = useMemo(() => new Map(stages.map((s) => [s.key, s] as const)), [stages]);
  const defaultStage = useMemo(
    () => stages.find((s) => s.is_intake) ?? stages[0] ?? null,
    [stages],
  );

  return { stages, stageById, stageByKey, defaultStage, pipelineId, loading };
}

/** Stage colours are admin-chosen, so tint from the stored hex rather than a token map. */
export function stageBadgeStyle(color: string | undefined) {
  const c = color || "#64748B";
  return { backgroundColor: `${c}1A`, color: c, borderColor: `${c}33` };
}

export function isClosedStage(stage: JobStage | undefined | null): boolean {
  return !!stage && Boolean(stage.is_won || stage.is_lost || stage.is_exit);
}
