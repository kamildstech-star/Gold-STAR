REVOKE EXECUTE ON FUNCTION public.is_lead_visible_to_field(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_lead_visible_to_field(uuid, uuid) TO authenticated, service_role;