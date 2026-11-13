-- Demo-only: give the chaser performance screens a previous month to compare
-- against, plus a few chases with no arrival / no outcome.
INSERT INTO public.incidents (
  incident_type, source, status, lifecycle, address, locality, reported_at,
  accepted_at, accepted_by, arrived_at, outcome, is_demo
)
SELECT
  i.incident_type,
  i.source,
  i.status,
  CASE WHEN g.n % 3 = 0 THEN 'won'::incident_lifecycle ELSE 'dead'::incident_lifecycle END,
  i.address,
  i.locality,
  i.reported_at - interval '1 month',
  i.accepted_at - interval '1 month',
  i.accepted_by,
  CASE WHEN g.n % 4 = 0 THEN NULL ELSE i.accepted_at - interval '1 month' + interval '25 minutes' END,
  CASE WHEN g.n % 3 = 0 THEN 'contract_signed'::incident_outcome
       WHEN g.n % 4 = 0 THEN 'no_contact'::incident_outcome
       ELSE 'competitor_present'::incident_outcome END,
  true
FROM (
  SELECT * FROM public.incidents
  WHERE accepted_by IS NOT NULL AND accepted_at IS NOT NULL
  ORDER BY accepted_at DESC
  LIMIT 18
) i
CROSS JOIN LATERAL (SELECT row_number() OVER () AS n FROM (SELECT 1) x) g0
JOIN LATERAL (SELECT (abs(hashtext(i.id::text)) % 12) AS n) g ON true;

-- A couple of current-month chases left open, so the dismissible nudge has data.
UPDATE public.incidents SET outcome = NULL, arrived_at = NULL
WHERE id IN (
  SELECT id FROM public.incidents
  WHERE accepted_by IS NOT NULL
    AND accepted_at >= date_trunc('month', now())
    AND lifecycle <> 'won'
    AND accepted_at < now() - interval '1 day'
  ORDER BY accepted_at
  LIMIT 3
);