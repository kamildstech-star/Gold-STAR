-- Client portal, slice 1: the only five doors a customer session has, and the
-- audit that proves they are the only five.
--
-- WRITTEN, NOT APPLIED. Runs after 20260928130000_client_portal_foundation.
--
-- EDITED IN PLACE, 2026-09-28. The first apply on the live database rolled
-- back whole ("return type mismatch in function declared to return uuid ...
-- Actual return type is text", SQL function portal_set_photos), so nothing
-- from this file exists anywhere and editing it beats a repair migration.
-- The cause: `photos.id` is TEXT — a client-generated ULID
-- (20260728175932, src/lib/photos.ts) — and `photo_variants.photo_id` with
-- it, but this file declared photo ids as uuid in three places. Only the
-- SQL-language function was checked at CREATE; the two plpgsql ones would
-- have failed later, at their first call. All three now say text, because a
-- ULID is not a uuid and casting one would fail on every real photo:
--   * portal_set_photos   RETURNS SETOF text           (was SETOF uuid)
--   * portal_photos       RETURNS TABLE (photo_id text) (was uuid)
--   * portal_file_refs    _ids text[], returns id text  (were uuid[] / uuid)
-- Document, album, folder, job and invoice ids are uuid and are unchanged.
--
-- Every function here:
--   * is EXECUTE-able by portal_customer and by nobody else — not anon, not
--     authenticated staff, not PUBLIC;
--   * first asks portal_caller(): is this a signed-in customer (JWT role
--     portal_customer, a linked portal_customers row, access not turned off)?
--     Otherwise it raises;
--   * then asks whether THIS job is shared with THIS customer, and whether the
--     item is on the share and still on the job. Otherwise it returns nothing
--     — the same nothing a made-up id returns, so changing an id in a request
--     cannot even tell a customer whether someone else's job exists;
--   * returns a written-out list of fields. Per-field enforcement is that the
--     customer has no privilege on any base table, so the only columns that
--     can ever reach them are the ones named below. No costs, no margins, no
--     internal notes, no staff names, no other customer.

-- The caller's portal customer id, or null. The JWT role and the auth user's
-- role must both say portal_customer: a staff session that somehow reached
-- one of these functions still gets null.
CREATE OR REPLACE FUNCTION goldstar_private.portal_caller()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT pc.id
    FROM public.portal_customers pc
    JOIN auth.users u ON u.id = pc.user_id
   WHERE pc.user_id = auth.uid()
     AND pc.disabled_at IS NULL
     AND u.role = 'portal_customer'
     AND coalesce(auth.jwt() ->> 'role', '') = 'portal_customer';
$$;

-- The photos behind one shared album or folder. A folder brings its
-- subfolders with it (UNION, not UNION ALL, so a looping folder tree ends).
-- Photo ids are text (ULIDs), so the set is text; the album and folder being
-- asked about are uuid.
CREATE OR REPLACE FUNCTION goldstar_private.portal_set_photos(_kind text, _item_id uuid)
RETURNS SETOF text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  WITH RECURSIVE folders AS (
    SELECT f.id FROM public.photo_folders f WHERE _kind = 'photo_folder' AND f.id = _item_id
    UNION
    SELECT f.id FROM public.photo_folders f JOIN folders t ON f.parent_folder_id = t.id
  )
  SELECT p.id FROM public.photos p
   WHERE p.deleted_at IS NULL AND p.storage_path_original IS NOT NULL
     AND ((_kind = 'photo_album' AND p.project_id = _item_id)
       OR (_kind = 'photo_folder' AND p.folder_id IN (SELECT id FROM folders)));
$$;

REVOKE ALL ON FUNCTION goldstar_private.portal_caller() FROM PUBLIC, anon, authenticated, portal_customer;
REVOKE ALL ON FUNCTION goldstar_private.portal_set_photos(text, uuid) FROM PUBLIC, anon, authenticated, portal_customer;

/* ------------------------------------------------------------------ */
/* 1. My shared jobs                                                    */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION public.portal_my_jobs()
RETURNS TABLE (job_id uuid, job_number text, address text, locality text, region text,
               shared_at timestamptz, documents integer, photo_sets integer, invoices integer)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me uuid := goldstar_private.portal_caller();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Customer portal sessions only.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT j.id, j.job_number::text, j.address::text, j.locality::text, j.region::text, s.created_at,
         (SELECT count(*)::int FROM public.portal_share_items i
           WHERE i.share_id = s.id AND i.item_kind = 'document'
             AND goldstar_private.portal_item_on_job(i.item_kind, i.item_id, s.job_id)),
         (SELECT count(*)::int FROM public.portal_share_items i
           WHERE i.share_id = s.id AND i.item_kind IN ('photo_album', 'photo_folder')
             AND goldstar_private.portal_item_on_job(i.item_kind, i.item_id, s.job_id)),
         (SELECT count(*)::int FROM public.portal_share_items i
           WHERE i.share_id = s.id AND i.item_kind = 'invoice'
             AND goldstar_private.portal_item_on_job(i.item_kind, i.item_id, s.job_id))
    FROM public.portal_job_shares s
    JOIN public.jobs j ON j.id = s.job_id
   WHERE s.portal_customer_id = me
   ORDER BY s.created_at DESC;
END $$;

/* ------------------------------------------------------------------ */
/* 2. One shared job: what is shared on it                              */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION public.portal_job(_job_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me uuid := goldstar_private.portal_caller();
  sid uuid;
  result jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Customer portal sessions only.' USING ERRCODE = '42501';
  END IF;
  SELECT s.id INTO sid FROM public.portal_job_shares s
   WHERE s.job_id = _job_id AND s.portal_customer_id = me;
  IF sid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'job', jsonb_build_object(
      'id', j.id, 'job_number', j.job_number, 'address', j.address,
      'locality', j.locality, 'region', j.region, 'postal_code', j.postal_code),
    'documents', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', d.id, 'name', d.name, 'mime', d.mime,
               'size_bytes', d.size_bytes, 'created_at', d.created_at)
             ORDER BY d.created_at DESC)
        FROM public.portal_share_items i
        JOIN public.documents d ON d.id = i.item_id
       WHERE i.share_id = sid AND i.item_kind = 'document'
         AND goldstar_private.portal_item_on_job('document', d.id, _job_id)), '[]'::jsonb),
    'photo_sets', coalesce((
      SELECT jsonb_agg(x.o ORDER BY x.name)
        FROM (
          SELECT p.name AS name, jsonb_build_object(
                   'kind', 'photo_album', 'id', p.id, 'name', p.name,
                   'photo_count', (SELECT count(*) FROM goldstar_private.portal_set_photos('photo_album', p.id))) AS o
            FROM public.portal_share_items i
            JOIN public.projects p ON p.id = i.item_id
           WHERE i.share_id = sid AND i.item_kind = 'photo_album'
             AND goldstar_private.portal_item_on_job('photo_album', p.id, _job_id)
          UNION ALL
          SELECT f.name, jsonb_build_object(
                   'kind', 'photo_folder', 'id', f.id, 'name', f.name,
                   'photo_count', (SELECT count(*) FROM goldstar_private.portal_set_photos('photo_folder', f.id)))
            FROM public.portal_share_items i
            JOIN public.photo_folders f ON f.id = i.item_id
           WHERE i.share_id = sid AND i.item_kind = 'photo_folder'
             AND goldstar_private.portal_item_on_job('photo_folder', f.id, _job_id)
        ) x), '[]'::jsonb),
    'invoices', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', v.id, 'invoice_number', v.invoice_number, 'title', v.title,
               'issue_date', v.issue_date, 'due_date', v.due_date,
               'status', v.status, 'total', v.total)
             ORDER BY v.issue_date DESC NULLS LAST)
        FROM public.portal_share_items i
        JOIN public.invoices v ON v.id = i.item_id
       WHERE i.share_id = sid AND i.item_kind = 'invoice'
         AND goldstar_private.portal_item_on_job('invoice', v.id, _job_id)), '[]'::jsonb)
  ) INTO result
  FROM public.jobs j WHERE j.id = _job_id;

  RETURN result;
END $$;

/* ------------------------------------------------------------------ */
/* 3. The photo ids in one shared set                                   */
/* ------------------------------------------------------------------ */

CREATE OR REPLACE FUNCTION public.portal_photos(_job_id uuid, _kind text, _item_id uuid)
RETURNS TABLE (photo_id text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me uuid := goldstar_private.portal_caller();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Customer portal sessions only.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.portal_job_shares s
      JOIN public.portal_share_items i ON i.share_id = s.id
     WHERE s.job_id = _job_id AND s.portal_customer_id = me
       AND i.item_kind = _kind AND i.item_id = _item_id
       AND _kind IN ('photo_album', 'photo_folder')
       AND goldstar_private.portal_item_on_job(_kind, _item_id, _job_id)) THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT p.id FROM public.photos p
   WHERE p.id IN (SELECT goldstar_private.portal_set_photos(_kind, _item_id))
   ORDER BY p.captured_at NULLS LAST, p.created_at, p.id;
END $$;

/* ------------------------------------------------------------------ */
/* 4. One shared invoice, read-only                                     */
/* ------------------------------------------------------------------ */

-- The customer-facing face of the invoice: what it says on the page they
-- would be mailed. Not unit_cost, not the line notes, not collected /
-- uncollected, not the carrier shortfall, not the internal notes field.
CREATE OR REPLACE FUNCTION public.portal_invoice(_invoice_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  me uuid := goldstar_private.portal_caller();
  result jsonb;
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Customer portal sessions only.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.portal_job_shares s
      JOIN public.portal_share_items i ON i.share_id = s.id
     WHERE s.portal_customer_id = me AND i.item_kind = 'invoice' AND i.item_id = _invoice_id
       AND goldstar_private.portal_item_on_job('invoice', _invoice_id, s.job_id)) THEN
    RETURN NULL;
  END IF;

  SELECT jsonb_build_object(
    'id', v.id, 'job_id', v.job_id, 'invoice_number', v.invoice_number, 'title', v.title,
    'issue_date', v.issue_date, 'due_date', v.due_date, 'status', v.status,
    'customer_name', v.customer_name,
    'address', v.address, 'address_line2', v.address_line2, 'locality', v.locality,
    'region', v.region, 'postal_code', v.postal_code,
    'office_name', v.office_name, 'office_phone', v.office_phone,
    'office_email', v.office_email, 'office_address', v.office_address,
    'subtotal', v.subtotal, 'tax_rate', v.tax_rate, 'tax', v.tax, 'total', v.total,
    'lines', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'position', l.position, 'name', l.name, 'description', l.description,
               'quantity', l.quantity, 'uom', l.uom, 'unit_price', l.unit_price,
               'subtotal', l.subtotal, 'is_discount', l.is_discount)
             ORDER BY l.position, l.created_at)
        FROM public.invoice_lines l WHERE l.invoice_id = v.id), '[]'::jsonb)
  ) INTO result
  FROM public.invoices v WHERE v.id = _invoice_id;
  RETURN result;
END $$;

/* ------------------------------------------------------------------ */
/* 5. Where a shared file lives — for the signing server only           */
/* ------------------------------------------------------------------ */

-- Called by the portal's signing server function WITH THE CUSTOMER'S OWN
-- TOKEN, so this check runs as the customer. Only rows that pass come back;
-- the server signs exactly those, for five minutes, and nothing else.
-- `thumb` and `display` prefer the re-encoded variants, which carry no EXIF;
-- a photograph old enough to predate variants falls back to its original.
--
-- Ids travel as text because the one list carries either kind: document ids
-- are uuid, photo ids are ULIDs. A document is matched on `d.id::text`, so a
-- string that is not a uuid simply matches nothing — the same empty answer a
-- made-up or foreign id gets — instead of raising a cast error that would
-- tell the caller something the other answers do not.
CREATE OR REPLACE FUNCTION public.portal_file_refs(_kind text, _ids text[], _size text DEFAULT 'display')
RETURNS TABLE (id text, bucket text, path text, mime text, name text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE me uuid := goldstar_private.portal_caller();
BEGIN
  IF me IS NULL THEN
    RAISE EXCEPTION 'Customer portal sessions only.' USING ERRCODE = '42501';
  END IF;
  IF _ids IS NULL OR cardinality(_ids) = 0 THEN
    RETURN;
  END IF;
  IF cardinality(_ids) > 200 THEN
    RAISE EXCEPTION 'Too many files in one request.' USING ERRCODE = '22023';
  END IF;

  IF _kind = 'document' THEN
    RETURN QUERY
    SELECT DISTINCT d.id::text, d.storage_bucket::text, d.storage_path::text, d.mime::text, d.name::text
      FROM public.documents d
      JOIN public.portal_share_items i ON i.item_kind = 'document' AND i.item_id = d.id
      JOIN public.portal_job_shares s ON s.id = i.share_id
     WHERE d.id::text = ANY (_ids) AND s.portal_customer_id = me
       AND goldstar_private.portal_item_on_job('document', d.id, s.job_id)
       AND d.storage_bucket IS NOT NULL AND d.storage_path IS NOT NULL;
  ELSIF _kind = 'photo' THEN
    RETURN QUERY
    SELECT DISTINCT ON (p.id) p.id,
           coalesce(p.storage_bucket, 'project-photos')::text,
           coalesce(
             (SELECT v.storage_path FROM public.photo_variants v
               WHERE v.photo_id = p.id AND v.variant = CASE WHEN _size = 'thumb' THEN 'thumb' ELSE 'display' END
                 AND v.storage_path IS NOT NULL LIMIT 1),
             p.storage_path_original)::text,
           p.mime::text,
           NULL::text
      FROM public.photos p
      JOIN public.portal_job_shares s ON s.portal_customer_id = me
      JOIN public.portal_share_items i ON i.share_id = s.id AND i.item_kind IN ('photo_album', 'photo_folder')
     WHERE p.id = ANY (_ids)
       AND goldstar_private.portal_item_on_job(i.item_kind, i.item_id, s.job_id)
       AND p.id IN (SELECT goldstar_private.portal_set_photos(i.item_kind, i.item_id))
     ORDER BY p.id;
  END IF;
END $$;

/* ------------------------------------------------------------------ */
/* 6. Grants: portal_customer, and only portal_customer                 */
/* ------------------------------------------------------------------ */

REVOKE ALL ON FUNCTION public.portal_my_jobs() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_job(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_photos(uuid, text, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_invoice(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.portal_file_refs(text, text[], text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.portal_my_jobs() TO portal_customer;
GRANT EXECUTE ON FUNCTION public.portal_job(uuid) TO portal_customer;
GRANT EXECUTE ON FUNCTION public.portal_photos(uuid, text, uuid) TO portal_customer;
GRANT EXECUTE ON FUNCTION public.portal_invoice(uuid) TO portal_customer;
GRANT EXECUTE ON FUNCTION public.portal_file_refs(text, text[], text) TO portal_customer;

/* ------------------------------------------------------------------ */
/* 7. The audit — refuses to finish if deny-by-default is not true      */
/* ------------------------------------------------------------------ */

-- Run against the live catalog at apply time, inside this migration's
-- transaction, so a failure rolls all of it back. Extension-owned objects
-- (PostGIS's spatial_ref_sys, pg_trgm's operators) are reference data and
-- are excluded by dependency, not by name. The same query is in
-- supabase/tests/client-portal-live-audit.sql to re-run whenever.
DO $$
DECLARE
  bad text;
  allowed text[] := ARRAY['portal_my_jobs', 'portal_job', 'portal_photos', 'portal_invoice', 'portal_file_refs'];
  public_policies int;
BEGIN
  -- (a) No table, view or sequence a customer can reach.
  SELECT string_agg(format('%I.%I', n.nspname, c.relname), ', ' ORDER BY n.nspname, c.relname) INTO bad
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
     AND n.nspname NOT LIKE 'pg\_%'
     AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
     AND has_schema_privilege('portal_customer', n.oid, 'USAGE')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_class'::regclass
                        AND d.objid = c.oid AND d.deptype = 'e')
     AND CASE WHEN c.relkind = 'S'
              THEN has_sequence_privilege('portal_customer', c.oid, 'USAGE,SELECT,UPDATE')
              ELSE has_table_privilege('portal_customer', c.oid,
                     'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') END;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'portal audit: portal_customer can reach relations it must not: %', bad;
  END IF;

  -- (b) No callable function in our schemas beyond the five. Trigger and
  -- event-trigger functions can not be called, so they are not doors.
  SELECT string_agg(p.oid::regprocedure::text, ', ') INTO bad
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'goldstar_private')
     AND p.prorettype NOT IN ('pg_catalog.trigger'::regtype, 'pg_catalog.event_trigger'::regtype)
     AND has_function_privilege('portal_customer', p.oid, 'EXECUTE')
     AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend d
                      WHERE d.classid = 'pg_catalog.pg_proc'::regclass
                        AND d.objid = p.oid AND d.deptype = 'e')
     AND NOT (n.nspname = 'public' AND p.proname = ANY (allowed));
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'portal audit: portal_customer can execute functions it must not: %', bad;
  END IF;

  -- (c) The five really are the customer's, and no staff session holds them.
  SELECT string_agg(p.proname, ', ') INTO bad
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = ANY (allowed)
     AND (has_function_privilege('authenticated', p.oid, 'EXECUTE')
          OR has_function_privilege('anon', p.oid, 'EXECUTE')
          OR NOT has_function_privilege('portal_customer', p.oid, 'EXECUTE')
          OR NOT p.prosecdef);
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'portal audit: portal functions granted wrongly: %', bad;
  END IF;

  -- (d) The customer role inherits nothing and cannot sign in by itself.
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
               JOIN pg_catalog.pg_roles r ON r.oid = m.member
              WHERE r.rolname = 'portal_customer')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_roles
                 WHERE rolname = 'portal_customer'
                   AND (rolcanlogin OR rolinherit OR rolbypassrls OR rolsuper OR rolcreaterole)) THEN
    RAISE EXCEPTION 'portal audit: portal_customer is a member of another role or holds attributes it must not';
  END IF;

  -- For the record, not a failure: policies written TO public would apply to
  -- any role holding the table privilege. portal_customer holds none, and
  -- every RLS table also carries its restrictive portal_customer_denied.
  SELECT count(*) INTO public_policies FROM pg_catalog.pg_policies
   WHERE schemaname IN ('public', 'storage') AND 'public' = ANY (roles);
  RAISE NOTICE 'portal audit passed. Policies written TO public (inert for portal_customer): %', public_policies;
END $$;
