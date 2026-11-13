-- 1. Rooms: the spine of mitigation documentation
CREATE TABLE public.job_rooms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  name text NOT NULL,
  floor text,
  length_ft numeric,
  width_ft numeric,
  height_ft numeric,
  affected_materials text[] NOT NULL DEFAULT '{}',
  notes text,
  sort_order integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.job_rooms TO authenticated;
GRANT ALL ON public.job_rooms TO service_role;

ALTER TABLE public.job_rooms ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_rooms_select" ON public.job_rooms
  FOR SELECT TO authenticated USING (public.can_view_job(auth.uid(), job_id));
CREATE POLICY "job_rooms_insert" ON public.job_rooms
  FOR INSERT TO authenticated WITH CHECK (public.can_manage_job(auth.uid(), job_id));
CREATE POLICY "job_rooms_update" ON public.job_rooms
  FOR UPDATE TO authenticated USING (public.can_manage_job(auth.uid(), job_id))
  WITH CHECK (public.can_manage_job(auth.uid(), job_id));
CREATE POLICY "job_rooms_delete" ON public.job_rooms
  FOR DELETE TO authenticated USING (public.can_manage_job(auth.uid(), job_id));

CREATE INDEX job_rooms_job_idx ON public.job_rooms (job_id, sort_order);

CREATE TRIGGER job_rooms_set_updated_at
  BEFORE UPDATE ON public.job_rooms
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 2. Room links: folders generate from rooms, equipment records where it sits
ALTER TABLE public.photo_folders
  ADD COLUMN room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL;
ALTER TABLE public.equipment_placements
  ADD COLUMN room_id uuid REFERENCES public.job_rooms(id) ON DELETE SET NULL;
CREATE INDEX photo_folders_room_idx ON public.photo_folders (room_id);
CREATE INDEX equipment_placements_room_idx ON public.equipment_placements (room_id);

-- 3. Default contact method per job, and ordering
ALTER TABLE public.job_contacts
  ADD COLUMN is_default_contact boolean NOT NULL DEFAULT false,
  ADD COLUMN sort_order integer NOT NULL DEFAULT 0;

-- Only one default per job.
CREATE UNIQUE INDEX job_contacts_one_default_idx
  ON public.job_contacts (job_id) WHERE is_default_contact;

CREATE INDEX job_contacts_contact_role_idx ON public.job_contacts (contact_id, role);
CREATE INDEX job_contacts_account_role_idx ON public.job_contacts (account_id, role);

-- 4. Share links scoped by relationship
ALTER TABLE public.share_links
  ADD COLUMN audience_role text;

-- 5. The client's relationship list, replacing ours where it overlaps
DO $$
DECLARE
  v_list uuid;
  v_roles text[][] := ARRAY[
    ARRAY['customer','Customer'],
    ARRAY['caller','Caller'],
    ARRAY['property_owner','Property Owner'],
    ARRAY['tenant','Tenant'],
    ARRAY['association_rep','Association Rep'],
    ARRAY['claims_manager','Claims Manager'],
    ARRAY['field_adjuster','Field Adjuster'],
    ARRAY['independent_adjuster','Independent Adjuster'],
    ARRAY['inside_examiner','Inside Examiner'],
    ARRAY['desk_adjuster','Desk Adjuster'],
    ARRAY['public_adjuster','Public Adjuster'],
    ARRAY['referrer','Referrer'],
    ARRAY['property_manager','Property Manager'],
    ARRAY['carrier_back_office','Carrier Back Office'],
    ARRAY['attorney','Attorney'],
    ARRAY['other','Other']
  ];
  i integer;
BEGIN
  SELECT id INTO v_list FROM public.option_lists WHERE key = 'job_contact_role';
  IF v_list IS NULL THEN
    INSERT INTO public.option_lists (key, name)
    VALUES ('job_contact_role', 'Job contact relationship')
    RETURNING id INTO v_list;
  END IF;

  FOR i IN 1 .. array_length(v_roles, 1) LOOP
    UPDATE public.option_list_values
       SET label = v_roles[i][2], sort_order = i * 10, active = true
     WHERE list_id = v_list AND key = v_roles[i][1];
    IF NOT FOUND THEN
      INSERT INTO public.option_list_values (list_id, key, label, sort_order, active)
      VALUES (v_list, v_roles[i][1], v_roles[i][2], i * 10, true);
    END IF;
  END LOOP;

  -- Anything not in the client's list stays available but drops out of pickers.
  UPDATE public.option_list_values
     SET active = false
   WHERE list_id = v_list
     AND key <> ALL (ARRAY(SELECT v_roles[s][1] FROM generate_subscripts(v_roles, 1) AS s));
END $$;

-- 6. Relationship rollups. Both run as the caller, so RLS still decides
--    which jobs count toward the totals.
CREATE OR REPLACE FUNCTION public.contact_job_roles(_contact_id uuid)
RETURNS TABLE (role text, job_count bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jc.role, count(DISTINCT jc.job_id)
    FROM public.job_contacts jc
   WHERE jc.contact_id = _contact_id
   GROUP BY jc.role
   ORDER BY count(DISTINCT jc.job_id) DESC, jc.role;
$$;

CREATE OR REPLACE FUNCTION public.account_job_roles(_account_id uuid)
RETURNS TABLE (role text, job_count bigint)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT jc.role, count(DISTINCT jc.job_id)
    FROM public.job_contacts jc
   WHERE jc.account_id = _account_id
   GROUP BY jc.role
   ORDER BY count(DISTINCT jc.job_id) DESC, jc.role;
$$;

REVOKE EXECUTE ON FUNCTION public.contact_job_roles(uuid) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.account_job_roles(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.contact_job_roles(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.account_job_roles(uuid) TO authenticated;