-- Read-only post-deployment verification. No RPC is invoked and no rows change.
-- Every result must be true. This is intentionally not marked as executed:
-- the target connector is unavailable to this audit.
SELECT
  NOT has_function_privilege('anon', 'public.compute_job_commissions(uuid)', 'EXECUTE') AS anon_denied,
  NOT has_function_privilege('authenticated', 'public.compute_job_commissions(uuid)', 'EXECUTE') AS authenticated_denied,
  has_function_privilege('service_role', 'public.compute_job_commissions(uuid)', 'EXECUTE') AS service_allowed;

-- Definer callers must retain their owners' EXECUTE privilege on the helper.
SELECT p.oid::regprocedure AS caller,
       p.prosecdef AND has_function_privilege(p.proowner, 'public.compute_job_commissions(uuid)', 'EXECUTE') AS internal_call_allowed
FROM pg_proc p
WHERE p.oid IN (
  'public.jobs_commission_sync()'::regprocedure,
  'public.recompute_all_commissions()'::regprocedure
);
