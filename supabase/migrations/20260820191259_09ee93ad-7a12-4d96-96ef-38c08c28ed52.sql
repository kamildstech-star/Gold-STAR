CREATE OR REPLACE FUNCTION public.log_photo_view(_photo_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _project_id uuid;
BEGIN
  SELECT project_id INTO _project_id FROM public.photos WHERE id = _photo_id;
  IF _project_id IS NULL THEN
    RETURN;
  END IF;
  IF NOT public.can_view_project(auth.uid(), _project_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.photo_access_log (photo_id, project_id, actor_id, actor_kind, action)
  VALUES (_photo_id, _project_id, auth.uid(), 'user', 'view');
END;
$$;

GRANT EXECUTE ON FUNCTION public.log_photo_view(uuid) TO authenticated;