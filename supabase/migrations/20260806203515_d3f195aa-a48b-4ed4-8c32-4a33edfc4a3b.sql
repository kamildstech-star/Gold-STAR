CREATE OR REPLACE FUNCTION public.convert_lead_to_opportunity(_lead_id uuid)
RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  _lead public.fire_leads%ROWTYPE;
  _uid uuid := auth.uid();
  _account_id uuid;
  _name text;
  _pipeline uuid;
BEGIN
  SELECT * INTO _lead FROM public.fire_leads WHERE id = _lead_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Lead not found'; END IF;
  IF NOT public.can_view_lead(_uid, _lead_id) THEN RAISE EXCEPTION 'Not permitted'; END IF;
  IF _lead.account_id IS NOT NULL THEN RETURN _lead.account_id; END IF;
  IF _lead.location_id IS NULL THEN RAISE EXCEPTION 'Lead has no location; assign one before converting'; END IF;

  _name := COALESCE(NULLIF(btrim(_lead.org_name), ''), NULLIF(btrim(_lead.title), ''),
                    NULLIF(btrim(_lead.owner_name), ''), NULLIF(btrim(_lead.address), ''), 'Untitled opportunity');
  _pipeline := public.default_pipeline_for(_lead.location_id, 'account');

  INSERT INTO public.accounts (name, location_id, assigned_rep, status, stage, pipeline_id,
                               estimated_annual_value, notes, created_by, is_demo)
  VALUES (_name, _lead.location_id, COALESCE(_lead.assigned_rep, _uid), 'prospect', 'target', _pipeline,
          _lead.value_amount, NULLIF(btrim(concat_ws(E'\n',
            CASE WHEN _lead.address IS NOT NULL THEN 'Property: ' || _lead.address END,
            CASE WHEN _lead.source_system <> 'manual' THEN 'Source: ' || _lead.source_system END)), ''),
          _uid, _lead.is_demo)
  RETURNING id INTO _account_id;

  IF COALESCE(btrim(_lead.contact_name), '') <> '' THEN
    INSERT INTO public.contacts (account_id, full_name, email, phone, is_primary, created_by, is_demo)
    VALUES (_account_id, _lead.contact_name, _lead.contact_email, _lead.contact_phone, true, _uid, _lead.is_demo);
  END IF;

  INSERT INTO public.account_tags (account_id, tag_id, created_by)
  SELECT _account_id, lt.tag_id, _uid FROM public.lead_tags lt WHERE lt.lead_id = _lead_id
  ON CONFLICT DO NOTHING;

  INSERT INTO public.account_notes (account_id, body, created_by, created_at, is_demo)
  SELECT _account_id, ln.body, ln.author_id, ln.created_at, ln.is_demo
  FROM public.lead_notes ln WHERE ln.lead_id = _lead_id;

  INSERT INTO public.account_notes (account_id, body, created_by, is_demo)
  SELECT _account_id,
         'Converted from lead' ||
         CASE WHEN _lead.source_system <> 'manual' THEN ' (' || _lead.source_system || ')' ELSE '' END ||
         CASE WHEN _lead.address IS NOT NULL THEN ' - ' || _lead.address ELSE '' END,
         _uid, _lead.is_demo;

  UPDATE public.fire_leads
     SET account_id = _account_id,
         archived_at = COALESCE(archived_at, now()),
         archived_by = COALESCE(archived_by, _uid)
   WHERE id = _lead_id;

  RETURN _account_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.convert_lead_to_opportunity(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_opportunity(uuid) TO authenticated, service_role;