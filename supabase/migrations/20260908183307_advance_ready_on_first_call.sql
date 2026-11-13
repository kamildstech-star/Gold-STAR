-- A salesperson's first logged call starts active outreach immediately.
-- Resolve stages by semantic keys so this applies to every office-specific
-- prospecting pipeline without depending on seeded UUIDs.
WITH ready_to_outreach AS (
  SELECT ready.id AS ready_stage_id,
         outreach.id AS outreach_stage_id
    FROM public.pipeline_stages ready
    JOIN public.pipelines pipeline
      ON pipeline.id = ready.pipeline_id
    JOIN public.pipeline_stages outreach
      ON outreach.pipeline_id = ready.pipeline_id
     AND outreach.key = 'active_outreach'
     AND outreach.is_active = true
   WHERE pipeline.entity_type = 'account'
     AND pipeline.is_active = true
     AND ready.key = 'ready'
     AND ready.is_active = true
)
UPDATE public.pipeline_stages stage
   SET auto_advance = true,
       advance_match = 'all',
       advance_min_count = 1,
       advance_to_stage_id = mapping.outreach_stage_id,
       advance_conditions = '[{"kind":"call_logged","min_count":1}]'::jsonb
  FROM ready_to_outreach mapping
 WHERE stage.id = mapping.ready_stage_id;
