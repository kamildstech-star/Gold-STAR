-- Vehicle paperwork: the DOT inspection, the document behind each date, and
-- alerts that read like every other lapse in the app.
--
-- Mark, on Fleet: "add more boxes for insurance, registration, etc, with
-- alerts for each vehicle to make sure nothing lapses" and "add fields in here
-- the maintance".
--
-- Builds on 20260928124000_vehicle_maintenance.sql (David, 24 Sep), which is
-- live: vehicle_due_items already holds one row per van per kind with the due
-- date, the policy / plate / certificate number and the carrier / issuer, and
-- run_vehicle_due_alerts() already runs daily from pg_cron. This file adds
-- only what that one does not have:
--
--   1. 'dot_inspection' as a due kind (and a maintenance record kind). The
--      FMCSA annual periodic inspection (49 CFR 396.17) applies to a vehicle
--      over 10,000 lb GVWR used across state lines — a box truck running
--      jobs between the NJ and NY offices. Vans under that weight never get a
--      row, so it is optional per vehicle, not a gap on every van.
--   2. vehicle_documents: the insurance card, the registration, the
--      inspection report, the receipt for a brake job. Shaped like
--      compliance_requirement_files: a renewal SUPERSEDES the previous
--      document instead of overwriting it, so the card we held on the day of
--      an accident is still on file.
--   3. A private 'vehicle-documents' bucket whose policies ask the same two
--      questions as the tables: can_view_vehicle to read, can_manage_vehicle
--      to write. The first path segment is the vehicle id.
--   4. run_vehicle_due_alerts() reworded so a lapsing registration reads the
--      way a lapsing contractor certificate does (run_credential_expiry_alerts:
--      "has expired", "expires today", "expires in N days", high priority once
--      expired), and so an EXPIRED document also reaches owners and admins,
--      not only the van's office managers. The stages, the dedupe and the cron
--      job are unchanged.
--
-- Safe to re-run. Does not touch the cron schedule: 'vehicle-due-alerts'
-- (10 11 * * *) keeps calling the same function name.

-- ---------------------------------------------------------------------------
-- 1. 'dot_inspection'. The kind checks were written inline, so their names are
--    Postgres's; drop whichever check on the table mentions kind rather than
--    trusting a generated name — a second, stricter check left behind would
--    still refuse the new value.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conrelid::regclass AS tbl, conname
      FROM pg_constraint
     WHERE contype = 'c'
       AND conrelid IN ('public.vehicle_due_items'::regclass,
                        'public.vehicle_maintenance_records'::regclass)
       AND pg_get_constraintdef(oid) ~ '\mkind\M'
  LOOP
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', c.tbl, c.conname);
  END LOOP;
END $$;

ALTER TABLE public.vehicle_due_items
  ADD CONSTRAINT vehicle_due_items_kind_check
  CHECK (kind IN ('inspection', 'registration', 'insurance', 'dot_inspection', 'service'));

ALTER TABLE public.vehicle_maintenance_records
  ADD CONSTRAINT vehicle_maintenance_records_kind_check
  CHECK (kind IN (
    'service', 'oil_change', 'tires', 'brakes', 'repair',
    'inspection', 'dot_inspection', 'registration', 'insurance', 'other'
  ));

-- So a receipt can be pinned to a record AND its van in one foreign key: a
-- receipt filed under van A can never point at a brake job on van B.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'vehicle_maintenance_records_id_vehicle_key'
       AND conrelid = 'public.vehicle_maintenance_records'::regclass
  ) THEN
    ALTER TABLE public.vehicle_maintenance_records
      ADD CONSTRAINT vehicle_maintenance_records_id_vehicle_key UNIQUE (id, vehicle_id);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. Documents.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.vehicle_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vehicle_id uuid NOT NULL REFERENCES public.vehicles(id) ON DELETE CASCADE,
  -- Exactly one of these: the paperwork it evidences, or the record it is a
  -- receipt for.
  due_kind text CHECK (due_kind IS NULL OR due_kind IN (
    'inspection', 'registration', 'insurance', 'dot_inspection', 'service'
  )),
  maintenance_record_id uuid,
  storage_path text NOT NULL UNIQUE,
  file_name text NOT NULL,
  mime_type text,
  size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes >= 0),
  is_current boolean NOT NULL DEFAULT true,
  superseded_at timestamptz,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicle_documents_one_owner
    CHECK ((due_kind IS NULL) <> (maintenance_record_id IS NULL)),
  CONSTRAINT vehicle_documents_record_same_vehicle
    FOREIGN KEY (maintenance_record_id, vehicle_id)
    REFERENCES public.vehicle_maintenance_records (id, vehicle_id) ON DELETE CASCADE,
  -- The row and the file agree about whose van it is, so a manager of one van
  -- cannot register a row pointing at another van's file.
  CONSTRAINT vehicle_documents_path_is_the_vehicles
    CHECK (split_part(storage_path, '/', 1) = vehicle_id::text)
);

-- One CURRENT document per van per kind; superseded ones stay as history.
CREATE UNIQUE INDEX IF NOT EXISTS vehicle_documents_one_current
  ON public.vehicle_documents (vehicle_id, due_kind)
  WHERE is_current AND due_kind IS NOT NULL;
CREATE INDEX IF NOT EXISTS vehicle_documents_vehicle_idx
  ON public.vehicle_documents (vehicle_id, created_at DESC);
CREATE INDEX IF NOT EXISTS vehicle_documents_record_idx
  ON public.vehicle_documents (maintenance_record_id)
  WHERE maintenance_record_id IS NOT NULL;

-- A new card supersedes the old one in the same statement, so the
-- one-current index never sees two and the client never has to do it in two
-- round trips. Invoker rights: the caller's own RLS decides whether they may
-- touch the old row, and anyone who may insert the new one may.
CREATE OR REPLACE FUNCTION public.tg_vehicle_documents_supersede()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.due_kind IS NOT NULL AND NEW.is_current THEN
    UPDATE public.vehicle_documents
       SET is_current = false, superseded_at = now()
     WHERE vehicle_id = NEW.vehicle_id
       AND due_kind = NEW.due_kind
       AND is_current
       AND id <> NEW.id;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.tg_vehicle_documents_supersede() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS vehicle_documents_supersede ON public.vehicle_documents;
CREATE TRIGGER vehicle_documents_supersede BEFORE INSERT ON public.vehicle_documents
  FOR EACH ROW EXECUTE FUNCTION public.tg_vehicle_documents_supersede();

-- Same audience as vehicle_due_items and vehicle_maintenance_records,
-- policy for policy (20260928124000).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vehicle_documents TO authenticated;
GRANT ALL ON public.vehicle_documents TO service_role;
ALTER TABLE public.vehicle_documents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS vehicle_documents_select ON public.vehicle_documents;
CREATE POLICY vehicle_documents_select ON public.vehicle_documents
  FOR SELECT TO authenticated
  USING (public.can_view_vehicle((SELECT auth.uid()), vehicle_id));

DROP POLICY IF EXISTS vehicle_documents_write ON public.vehicle_documents;
CREATE POLICY vehicle_documents_write ON public.vehicle_documents
  FOR ALL TO authenticated
  USING (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id))
  WITH CHECK (public.can_manage_vehicle((SELECT auth.uid()), vehicle_id));

-- The second lock for portal customers (they hold no table privileges at all);
-- the live audit fails any RLS table without it. Guarded for a database the
-- portal migrations have not reached.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.vehicle_documents;
    CREATE POLICY portal_customer_denied ON public.vehicle_documents
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3. The bucket. Private; none of the existing buckets has this audience
--    ('documents' follows a location, 'compliance-files' an account).
--    Path: {vehicle_id}/{kind | receipts}/{timestamp}-{filename}.
-- ---------------------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'vehicle-documents',
  'vehicle-documents',
  false,
  15728640,
  ARRAY['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
)
ON CONFLICT (id) DO UPDATE
  SET public = false,
      file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;

-- The vehicle a stored file belongs to, or NULL for a path that does not start
-- with one. A CASE, not a bare cast: a malformed path must read as "no
-- vehicle" (so no access), never raise inside a storage policy.
CREATE OR REPLACE FUNCTION public.vehicle_document_vehicle_id(_path text)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
           WHEN split_part(_path, '/', 1)
                ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
             THEN split_part(_path, '/', 1)::uuid
         END;
$$;
REVOKE ALL ON FUNCTION public.vehicle_document_vehicle_id(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.vehicle_document_vehicle_id(text) TO authenticated, service_role;

DROP POLICY IF EXISTS vehicle_documents_object_read ON storage.objects;
CREATE POLICY vehicle_documents_object_read ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'vehicle-documents'
    AND public.can_view_vehicle((SELECT auth.uid()), public.vehicle_document_vehicle_id(name))
  );

DROP POLICY IF EXISTS vehicle_documents_object_insert ON storage.objects;
CREATE POLICY vehicle_documents_object_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'vehicle-documents'
    AND public.can_manage_vehicle((SELECT auth.uid()), public.vehicle_document_vehicle_id(name))
  );

-- No UPDATE: a document is what was on file at the time. Upload a new one.
DROP POLICY IF EXISTS vehicle_documents_object_delete ON storage.objects;
CREATE POLICY vehicle_documents_object_delete ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'vehicle-documents'
    AND public.can_manage_vehicle((SELECT auth.uid()), public.vehicle_document_vehicle_id(name))
  );

-- ---------------------------------------------------------------------------
-- 4. Alerts. Same stages as before — once on entering the warning window
--    (warn_days, 30 by default), again in the last week, then weekly while
--    expired — and the same per-stage dedupe. What changed:
--
--    * Paperwork reads like a credential: "Van 12: Insurance has expired",
--      "... expires today", "... expires in 6 days". Service keeps "due" /
--      "overdue", because an oil change is late, not lapsed.
--    * An expired document is high priority (as run_credential_expiry_alerts
--      does) and ALSO goes to owners and admins. A van on the road with no
--      insurance is the company's exposure, not only its office's, and owners
--      are not necessarily members of every office.
--    * The kind is named properly: initcap('dot_inspection') would print
--      "Dot_Inspection".
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_vehicle_due_alerts()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  rec record;
  u uuid;
  n integer := 0;
  stage text;
  what text;
  paperwork boolean;
  dedupe interval;
BEGIN
  FOR rec IN
    SELECT d.id, d.kind, d.due_on, d.due_odometer, d.warn_days, d.warn_miles,
           v.id AS vehicle_id, v.label AS vehicle_label, v.location_id,
           (d.due_on - current_date) AS days_left,
           d.due_odometer - (
             SELECT max(r.odometer) FROM public.vehicle_maintenance_records r
              WHERE r.vehicle_id = v.id
           ) AS miles_left
      FROM public.vehicle_due_items d
      JOIN public.vehicles v ON v.id = d.vehicle_id
     WHERE COALESCE(v.is_demo, false) = false
  LOOP
    stage := CASE
      WHEN rec.days_left < 0 OR rec.miles_left < 0 THEN 'overdue'
      WHEN rec.days_left <= LEAST(7, rec.warn_days) THEN 'week'
      WHEN rec.days_left <= rec.warn_days OR rec.miles_left <= rec.warn_miles THEN 'window'
      ELSE NULL
    END;
    CONTINUE WHEN stage IS NULL;

    paperwork := rec.kind IN ('insurance', 'registration', 'inspection', 'dot_inspection');

    dedupe := CASE stage
      WHEN 'overdue' THEN interval '7 days'
      WHEN 'week' THEN interval '8 days'
      ELSE make_interval(days => rec.warn_days + 1)
    END;

    what := CASE rec.kind
      WHEN 'insurance' THEN 'Insurance'
      WHEN 'registration' THEN 'Registration'
      WHEN 'inspection' THEN 'State inspection'
      WHEN 'dot_inspection' THEN 'DOT inspection'
      WHEN 'service' THEN 'Service'
      ELSE initcap(replace(rec.kind, '_', ' '))
    END;

    FOR u IN
      SELECT DISTINCT x FROM (
        SELECT lm.user_id AS x
          FROM public.location_members lm
         WHERE rec.location_id IS NOT NULL
           AND lm.location_id = rec.location_id
           AND (public.can_manage_location(lm.user_id, rec.location_id)
                OR public.has_permission(lm.user_id, 'fleet.manage', rec.location_id))
        UNION
        SELECT ur.user_id
          FROM public.user_roles ur
         WHERE ur.role::text IN ('owner', 'admin')
           AND (rec.location_id IS NULL OR (paperwork AND stage = 'overdue'))
      ) t
      WHERE x IS NOT NULL
    LOOP
      CONTINUE WHEN EXISTS (
        SELECT 1 FROM public.notifications nt
         WHERE nt.user_id = u
           AND nt.entity_type = 'vehicle_due:' || stage
           AND nt.entity_id = rec.id
           AND nt.created_at > now() - dedupe
      );

      INSERT INTO public.notifications
        (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        u,
        'vehicle_due',
        CASE
          WHEN paperwork AND rec.days_left < 0 THEN format('%s: %s has expired', rec.vehicle_label, what)
          WHEN paperwork AND rec.days_left = 0 THEN format('%s: %s expires today', rec.vehicle_label, what)
          WHEN paperwork AND rec.days_left IS NOT NULL THEN format('%s: %s expires in %s days', rec.vehicle_label, what, rec.days_left)
          WHEN rec.days_left < 0 THEN format('%s: %s overdue by %s days', rec.vehicle_label, what, -rec.days_left)
          WHEN rec.miles_left < 0 THEN format('%s: %s overdue by %s miles', rec.vehicle_label, what, -rec.miles_left)
          WHEN rec.days_left = 0 THEN format('%s: %s due today', rec.vehicle_label, what)
          WHEN rec.days_left IS NOT NULL AND rec.days_left <= rec.warn_days
            THEN format('%s: %s due in %s days', rec.vehicle_label, what, rec.days_left)
          ELSE format('%s: %s due in %s miles', rec.vehicle_label, what, rec.miles_left)
        END,
        CASE
          WHEN paperwork AND rec.days_left < 0 THEN format(
            'Expired %s (%s days ago). Renew it and upload the new document on the vehicle page.',
            to_char(rec.due_on, 'Mon DD, YYYY'), -rec.days_left)
          WHEN paperwork AND rec.due_on IS NOT NULL THEN format('Expires %s.', to_char(rec.due_on, 'Mon DD, YYYY'))
          WHEN rec.due_on IS NOT NULL THEN format('Due %s.', to_char(rec.due_on, 'Mon DD, YYYY'))
          ELSE format('Due at %s miles.', rec.due_odometer)
        END,
        'vehicle_due:' || stage,
        rec.id,
        '/fleet/' || rec.vehicle_id,
        CASE WHEN stage = 'overdue' THEN 'high'::public.notification_priority
             ELSE 'normal'::public.notification_priority END
      );
      n := n + 1;
    END LOOP;
  END LOOP;
  RETURN n;
END;
$$;
REVOKE ALL ON FUNCTION public.run_vehicle_due_alerts() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.run_vehicle_due_alerts() TO service_role;
