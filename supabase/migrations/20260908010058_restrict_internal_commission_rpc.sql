-- Direct calls can rewrite pending payouts for arbitrary jobs with the
-- function owner's privileges. The browser calls recompute_all_commissions(),
-- whose body checks can_view_finance(auth.uid()); it never calls this helper.
-- jobs_commission_sync() and recompute_all_commissions() are SECURITY DEFINER
-- and retain their owner's access. No function body or business row changes.
-- Apply transactionally after checking deployed signatures, owners and callers.
REVOKE ALL ON FUNCTION public.compute_job_commissions(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.compute_job_commissions(uuid) TO service_role;
