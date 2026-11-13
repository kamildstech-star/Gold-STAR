-- Reconstruction as a third job class.
--
-- Job type is "how the work is paid for" (20260810180238): insurance, cash,
-- and undetermined for intake that cannot tell yet. The client asked for
-- reconstruction as a peer option — "it's just a routing thing" — so this is
-- one more row in the managed list and nothing else. No reconstruction-only
-- columns, screens or rules; the job form, board pills, filters and reports
-- all read the list, so they pick it up without a deploy.
--
-- WHERE NOT EXISTS rather than ON CONFLICT: production has no unique
-- constraint on option_list_values (list_id, key) (see 20260903090000), so a
-- second run of this file must not insert a duplicate.
INSERT INTO public.option_list_values (list_id, key, label, sort_order, active, is_default, metadata)
SELECT l.id, 'reconstruction', 'Reconstruction', 25, true, false, jsonb_build_object('color', 'accent')
FROM public.option_lists l
WHERE l.key = 'job_type'
  AND NOT EXISTS (
    SELECT 1 FROM public.option_list_values v
    WHERE v.list_id = l.id AND v.key = 'reconstruction'
  );
