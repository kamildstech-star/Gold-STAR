-- Adding a unit to the equipment register straight from a scan (CEO, 26 Oct).
--
-- The scanner's "not in the register" now offers "Add to register". The add
-- goes through this function rather than a plain insert, for three reasons:
--
-- 1. NO TWINS. The scan's own lookup reads the register through RLS, so it
--    sees only the offices this person can view — a unit registered to another
--    office reads as "unregistered" to them. This looks across the WHOLE
--    register by the scanner's matching rule (upper case, every separator
--    dropped: GSR-AM00001-NY = GSRAM00001NY) and hands back the existing unit
--    instead of making a second one. Exact spelling first; a serialised lock
--    on the key stops two phones adding the same plate at the same moment.
-- 2. ONLY A PLATE. A NEW unit's tag must be plate-shaped — the same shape the
--    scanner accepts (src/lib/equipment-scan.ts TAG_SHAPE). A misread never
--    becomes a register entry. (Any spelling that matches an existing unit's
--    key still finds that unit, as the scanner's lookup does.)
-- 3. THE REGISTER'S OWN RULE. Whoever may add a unit on the register screen
--    (equipment_insert: can_manage_location on the home office — owners and
--    admins, and an office's office staff, location managers and regionals)
--    may add one here; anyone else gets 42501 'not_permitted', which the app
--    turns into "ask an admin to add this tag".
--
-- AUDIT: the unit records who added it (created_by), from which screen
-- (created_via, e.g. 'scan:equipment_setup') and on which job (created_job_id).
-- Units added any other way leave both new columns NULL.

ALTER TABLE public.equipment
  ADD COLUMN IF NOT EXISTS created_via text,
  ADD COLUMN IF NOT EXISTS created_job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.equipment.created_via IS
  'How the unit was first registered when not by the register screen or import: scan:equipment_setup, scan:field_ticket.';
COMMENT ON COLUMN public.equipment.created_job_id IS
  'The job being worked when the unit was added from a scan.';

CREATE OR REPLACE FUNCTION public.add_equipment_from_scan(
  _tag text,
  _equipment_type text,
  _location_id uuid,
  _notes text DEFAULT NULL,
  _via text DEFAULT NULL,
  _job_id uuid DEFAULT NULL
)
RETURNS TABLE (
  outcome text,
  id uuid,
  asset_tag text,
  equipment_type text,
  status public.equipment_status,
  location_id uuid,
  purchase_cost_cents integer
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
  v_uid uuid := auth.uid();
  v_tag text;
  v_key text;
  v_type text;
  v_existing public.equipment%ROWTYPE;
  v_new public.equipment%ROWTYPE;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  -- The scanner's cleaning (cleanAssetTag) and plate shape (TAG_SHAPE).
  v_tag := upper(btrim(coalesce(_tag, '')));
  v_tag := regexp_replace(v_tag, '[‐-―−_[:space:]]+', '-', 'g');
  v_tag := regexp_replace(v_tag, '-{2,}', '-', 'g');
  v_tag := regexp_replace(v_tag, '^-|-$', '', 'g');
  v_key := regexp_replace(v_tag, '[^A-Z0-9]', '', 'g');
  IF length(v_key) < 3 OR length(v_key) > 32 THEN
    RAISE EXCEPTION 'not_a_tag: %', left(coalesce(_tag, ''), 40) USING ERRCODE = '22023';
  END IF;

  -- One add per plate at a time, whoever is scanning it.
  PERFORM pg_advisory_xact_lock(hashtext('equipment_tag:' || v_key));

  SELECT e.* INTO v_existing
    FROM public.equipment e
   WHERE upper(regexp_replace(e.asset_tag, '[^A-Za-z0-9]', '', 'g')) = v_key
   ORDER BY (e.asset_tag = v_tag) DESC, e.created_at
   LIMIT 1;
  IF FOUND THEN
    RETURN QUERY SELECT 'existing'::text, v_existing.id, v_existing.asset_tag,
      v_existing.equipment_type, v_existing.status, v_existing.location_id,
      v_existing.purchase_cost_cents;
    RETURN;
  END IF;

  -- Nothing registered under it: only a plate-shaped tag may become a unit.
  IF v_tag !~ '^[A-Z]{2,5}-[A-Z]{0,4}[0-9]{1,8}-[A-Z]{2,3}[0-9]?$' THEN
    RAISE EXCEPTION 'not_a_tag: %', left(coalesce(_tag, ''), 40) USING ERRCODE = '22023';
  END IF;

  IF _location_id IS NULL OR NOT public.can_manage_location(v_uid, _location_id) THEN
    RAISE EXCEPTION 'not_permitted' USING ERRCODE = '42501';
  END IF;

  v_type := nullif(btrim(coalesce(_equipment_type, '')), '');
  IF v_type IS NULL OR length(v_type) > 40 THEN
    v_type := 'other';
  END IF;

  INSERT INTO public.equipment
    (asset_tag, equipment_type, location_id, status, notes, created_by, created_via, created_job_id)
  VALUES
    (v_tag, v_type, _location_id, 'available', nullif(btrim(coalesce(_notes, '')), ''),
     v_uid, left(nullif(btrim(coalesce(_via, '')), ''), 40), _job_id)
  RETURNING * INTO v_new;

  RETURN QUERY SELECT 'created'::text, v_new.id, v_new.asset_tag, v_new.equipment_type,
    v_new.status, v_new.location_id, v_new.purchase_cost_cents;
END;
$$;

REVOKE ALL ON FUNCTION public.add_equipment_from_scan(text, text, uuid, text, text, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.add_equipment_from_scan(text, text, uuid, text, text, uuid)
  TO authenticated, service_role;
