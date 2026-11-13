-- 0028: no anon execution of SECURITY DEFINER functions
REVOKE EXECUTE ON FUNCTION public.accounts_compliance_indicators(uuid[]) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.incident_active_responders(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.incident_rule(uuid) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.my_commission_tiers() FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.release_incident_claim(uuid, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.search_my_past_leads(text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text) FROM anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.st_estimatedextent(text, text, text, boolean) FROM anon, PUBLIC;

-- keep the app working for signed-in users
GRANT EXECUTE ON FUNCTION public.accounts_compliance_indicators(uuid[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.incident_active_responders(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.incident_rule(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_commission_tiers() TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_incident_claim(uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.search_my_past_leads(text) TO authenticated;

-- 0029: maintenance/cron-only routines are not for end users
REVOKE EXECUTE ON FUNCTION public.run_compliance_alerts() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.expire_stale_chase_claims() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.escalate_overdue_lead_approvals() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.match_incidents_to_fire_leads() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.staff_emails(uuid[]) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.scorecard_metrics_raw(timestamptz, timestamptz, uuid[]) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.next_job_number() FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.notify_lead_approvers(uuid, text, text) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.resolve_escalation_target(escalation_target_kind, uuid, uuid, uuid, escalation_record_type, uuid) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.incident_tier_recipients(uuid, smallint) FROM authenticated, anon, PUBLIC;
REVOKE EXECUTE ON FUNCTION public.seed_demo_extras() FROM authenticated, anon, PUBLIC;
