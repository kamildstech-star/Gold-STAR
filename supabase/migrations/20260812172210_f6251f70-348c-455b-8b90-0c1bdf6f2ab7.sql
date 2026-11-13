REVOKE EXECUTE ON FUNCTION public.can_write_translation(uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_write_translation(uuid, text, uuid) TO authenticated;