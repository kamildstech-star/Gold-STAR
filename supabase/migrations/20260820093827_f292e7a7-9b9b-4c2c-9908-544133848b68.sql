CREATE OR REPLACE FUNCTION public.incidents_no_outcome_cascade()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  bad integer;
BEGIN
  SELECT count(*) INTO bad FROM (
    SELECT COALESCE(n.exposure_group_id, n.id) AS grp
    FROM new_rows n
    JOIN old_rows o ON o.id = n.id
    WHERE n.exposure_group_id IS NOT NULL
      AND (n.outcome IS DISTINCT FROM o.outcome
        OR n.lifecycle IS DISTINCT FROM o.lifecycle
        OR n.job_id IS DISTINCT FROM o.job_id)
    GROUP BY 1
    HAVING count(*) > 1
  ) x;

  IF bad > 0 THEN
    RAISE EXCEPTION 'Exposure independence: a fire and its exposures each carry their own outcome; they cannot be changed together'
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS incidents_no_outcome_cascade_trg ON public.incidents;
CREATE TRIGGER incidents_no_outcome_cascade_trg
AFTER UPDATE ON public.incidents
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION public.incidents_no_outcome_cascade();