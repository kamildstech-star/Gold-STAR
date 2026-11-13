BEGIN;

-- Storage is external to Postgres. Upload immutable, attempt-specific objects
-- first; publish their paths and consume the token in this single transaction.
CREATE OR REPLACE FUNCTION public.complete_document_signing_atomic(
  _token text, _packet_id uuid, _attempt_id uuid, _evidence jsonb, _submission jsonb
) RETURNS integer
LANGUAGE plpgsql SECURITY INVOKER SET search_path = public
AS $$
DECLARE
  p public.document_send_packets;
  d public.documents;
  item record;
  e jsonb;
  signed_time timestamptz;
  written integer := 0;
  expected integer;
  answers text;
BEGIN
  SELECT * INTO p FROM public.document_send_packets
    WHERE id = _packet_id AND token = _token FOR UPDATE;
  IF NOT FOUND OR p.revoked_at IS NOT NULL OR p.expires_at IS NULL OR p.expires_at <= clock_timestamp()
     OR (p.completed_at IS NOT NULL AND p.single_use IS NOT FALSE) THEN
    RAISE EXCEPTION 'Signing link is unavailable';
  END IF;
  IF jsonb_typeof(_evidence) IS DISTINCT FROM 'array'
     OR jsonb_typeof(_submission->'field_values') IS DISTINCT FROM 'object'
     OR nullif(btrim(_submission->>'signer_name'), '') IS NULL
     OR _submission->'packet_scope' IS DISTINCT FROM jsonb_build_object(
       'location_id', p.location_id, 'job_id', p.job_id,
       'recipient_name', p.recipient_name, 'recipient_email', p.recipient_email) THEN
    RAISE EXCEPTION 'Signing packet changed';
  END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p.required_fields) f
    WHERE nullif(btrim(_submission->'field_values'->>(f->>'key')), '') IS NULL) THEN
    RAISE EXCEPTION 'Required answers are missing';
  END IF;
  signed_time := (_submission->>'signed_at')::timestamptz;
  IF signed_time IS NULL THEN RAISE EXCEPTION 'Signing time is required'; END IF;

  -- Serialize shared documents too: two distinct packet tokens may name the
  -- same document. Consistent lock order prevents multi-document deadlocks.
  PERFORM 1 FROM public.document_send_items WHERE packet_id = p.id FOR UPDATE;
  PERFORM d0.id FROM public.documents d0
    JOIN public.document_send_items i ON i.document_id = d0.id
    WHERE i.packet_id = p.id ORDER BY d0.id FOR UPDATE OF d0;
  IF EXISTS (SELECT 1 FROM public.document_send_items i
    JOIN public.documents d0 ON d0.id = i.document_id
    WHERE i.packet_id = p.id AND d0.location_id IS DISTINCT FROM p.location_id) THEN
    RAISE EXCEPTION 'Document outside packet scope';
  END IF;
  SELECT count(*) INTO expected FROM public.document_send_items i
    JOIN public.documents d0 ON d0.id = i.document_id
    WHERE i.packet_id = p.id AND d0.status <> 'signed' AND d0.locked_at IS NULL;
  IF expected <> jsonb_array_length(_evidence)
     OR (SELECT count(DISTINCT value->>'document_id') FROM jsonb_array_elements(_evidence)) <> expected THEN
    RAISE EXCEPTION 'Documents changed or already signed';
  END IF;

  FOR item IN SELECT i.document_id, i.requires_signature FROM public.document_send_items i
    JOIN public.documents d0 ON d0.id = i.document_id
    WHERE i.packet_id = p.id AND d0.status <> 'signed' AND d0.locked_at IS NULL
    ORDER BY i.document_id
  LOOP
    SELECT * INTO d FROM public.documents WHERE id = item.document_id;
    SELECT value INTO e FROM jsonb_array_elements(_evidence)
      WHERE value->>'document_id' = d.id::text;
    IF e IS NULL OR e->>'name' IS DISTINCT FROM d.name
       OR e->>'rendered_body' IS DISTINCT FROM d.rendered_body
       OR (e->>'requires_signature')::boolean IS DISTINCT FROM item.requires_signature
       OR e->>'pdf_path' IS DISTINCT FROM d.id::text || '/' || _attempt_id::text || '/signed.pdf'
       OR (item.requires_signature AND e->>'signature_path' IS DISTINCT FROM d.id::text || '/' || _attempt_id::text || '/signature.png')
       OR nullif(e->>'hash', '') IS NULL THEN
      RAISE EXCEPTION 'Document evidence does not match current document';
    END IF;
    UPDATE public.documents SET
      status = CASE WHEN item.requires_signature THEN 'signed'::public.document_status ELSE 'active'::public.document_status END,
      storage_bucket = 'documents', storage_path = e->>'pdf_path', mime = 'application/pdf',
      size_bytes = (e->>'size_bytes')::bigint,
      signed_at = CASE WHEN item.requires_signature THEN signed_time ELSE NULL END,
      content_hash = e->>'hash', locked_at = signed_time
    WHERE id = d.id;
    IF item.requires_signature THEN
      INSERT INTO public.document_signatures
        (document_id, signer_name, signer_role, signer_email, signed_at, signature_path, provider, user_agent, ip)
      VALUES (d.id, _submission->>'signer_name', _submission->>'signer_role',
        _submission->>'signer_email', signed_time, e->>'signature_path', 'native',
        _submission->>'user_agent', (_submission->>'ip')::inet);
    END IF;
    INSERT INTO public.document_events (document_id, event_type, actor_label, user_agent, detail)
      VALUES (d.id, CASE WHEN item.requires_signature THEN 'signed'::public.document_event_type ELSE 'generated'::public.document_event_type END,
        _submission->>'signer_name', _submission->>'user_agent',
        jsonb_build_object('packet_id', p.id, 'hash', e->>'hash', 'ip', _submission->>'ip'));
    written := written + 1;
  END LOOP;
  UPDATE public.document_send_packets SET completed_at = signed_time,
    field_values = _submission->'field_values', submission_count = coalesce(submission_count, 0) + 1
    WHERE id = p.id;
  IF p.job_id IS NOT NULL THEN
    SELECT string_agg((f->>'label') || ': ' || coalesce(_submission->'field_values'->>(f->>'key'), ''), E'\n')
      INTO answers FROM jsonb_array_elements(p.required_fields) f;
    INSERT INTO public.job_notes (job_id, body) VALUES (p.job_id,
      'Form link completed by ' || (_submission->>'signer_name') || E'.\n' ||
      written::text || ' document(s) filed to Job Documents.' ||
      CASE WHEN answers IS NULL THEN '' ELSE E'\n' || answers END);
  END IF;
  RETURN written;
END;
$$;
REVOKE ALL ON FUNCTION public.complete_document_signing_atomic(text, uuid, uuid, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_document_signing_atomic(text, uuid, uuid, jsonb, jsonb)
  TO service_role;
COMMIT;
