-- ============================================================
-- PART A: ACCOUNT LIFECYCLE + UPKEEP
-- ============================================================

CREATE TYPE public.account_stage AS ENUM (
  'target','researching','attempting_contact','meeting_booked','meeting_held',
  'vendor_onboarding','active','nurture','dormant','lost'
);

ALTER TABLE public.accounts
  ADD COLUMN stage public.account_stage NOT NULL DEFAULT 'target',
  ADD COLUMN stage_changed_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN lost_reason text;

CREATE TABLE public.account_stage_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  from_stage public.account_stage,
  to_stage public.account_stage NOT NULL,
  reason text,
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX account_stage_history_account_idx ON public.account_stage_history(account_id, changed_at DESC);
GRANT SELECT ON public.account_stage_history TO authenticated;
GRANT ALL ON public.account_stage_history TO service_role;
ALTER TABLE public.account_stage_history ENABLE ROW LEVEL SECURITY;
CREATE POLICY "stage_history_select" ON public.account_stage_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
    AND (a.created_by = auth.uid() OR a.assigned_rep = auth.uid() OR public.can_view_location(auth.uid(), a.location_id))));

CREATE OR REPLACE FUNCTION public.tg_account_stage_change()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.stage = 'lost' AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
    RAISE EXCEPTION 'A reason is required when an account is marked lost';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.stage IS DISTINCT FROM OLD.stage THEN
    NEW.stage_changed_at := now();
    INSERT INTO public.account_stage_history(account_id, from_stage, to_stage, reason, changed_by)
    VALUES (NEW.id, OLD.stage, NEW.stage, NEW.lost_reason, auth.uid());
  ELSIF TG_OP = 'INSERT' THEN
    INSERT INTO public.account_stage_history(account_id, from_stage, to_stage, reason, changed_by)
    VALUES (NEW.id, NULL, NEW.stage, NEW.lost_reason, auth.uid());
  END IF;
  RETURN NEW;
END; $$;

CREATE TRIGGER trg_account_stage_change_ins AFTER INSERT ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_stage_change();
CREATE TRIGGER trg_account_stage_change_upd BEFORE UPDATE ON public.accounts
  FOR EACH ROW EXECUTE FUNCTION public.tg_account_stage_change();

-- Vendor documents -------------------------------------------------
CREATE TYPE public.vendor_doc_kind AS ENUM ('coi','w9','agreement','other');
CREATE TYPE public.vendor_doc_status AS ENUM ('missing','pending','active','expired');

CREATE TABLE public.vendor_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind public.vendor_doc_kind NOT NULL,
  name text,
  storage_path text,
  status public.vendor_doc_status NOT NULL DEFAULT 'missing',
  expiry_date date,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vendor_documents_account_idx ON public.vendor_documents(account_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.vendor_documents TO authenticated;
GRANT ALL ON public.vendor_documents TO service_role;
ALTER TABLE public.vendor_documents ENABLE ROW LEVEL SECURITY;
CREATE POLICY "vendor_documents_select" ON public.vendor_documents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
    AND (a.created_by = auth.uid() OR a.assigned_rep = auth.uid() OR public.can_view_location(auth.uid(), a.location_id))));
CREATE POLICY "vendor_documents_write" ON public.vendor_documents FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
    AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));
CREATE POLICY "vendor_documents_update" ON public.vendor_documents FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
    AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));
CREATE POLICY "vendor_documents_delete" ON public.vendor_documents FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));
CREATE TRIGGER trg_vendor_documents_updated BEFORE UPDATE ON public.vendor_documents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Gift engine -------------------------------------------------------
CREATE TYPE public.gift_occasion AS ENUM ('birthday','jewish_holiday','seasonal','thank_you','other');
CREATE TYPE public.gift_campaign_status AS ENUM ('draft','approved','sending','sent','cancelled');
CREATE TYPE public.gift_delivery_status AS ENUM ('queued','sent','delivered','returned','cancelled');

CREATE TABLE public.gift_catalog (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  unit_cost_cents integer NOT NULL DEFAULT 0,
  active boolean NOT NULL DEFAULT true,
  image_path text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gift_catalog TO authenticated;
GRANT ALL ON public.gift_catalog TO service_role;
ALTER TABLE public.gift_catalog ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gift_catalog_select" ON public.gift_catalog FOR SELECT TO authenticated USING (true);
CREATE POLICY "gift_catalog_write" ON public.gift_catalog FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid())) WITH CHECK (public.is_privileged(auth.uid()));
CREATE TRIGGER trg_gift_catalog_updated BEFORE UPDATE ON public.gift_catalog
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.gift_campaigns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  occasion public.gift_occasion NOT NULL DEFAULT 'birthday',
  target_month smallint CHECK (target_month BETWEEN 1 AND 12),
  target_year integer,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  catalog_item_id uuid REFERENCES public.gift_catalog(id) ON DELETE SET NULL,
  status public.gift_campaign_status NOT NULL DEFAULT 'draft',
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_campaigns_month_idx ON public.gift_campaigns(target_year, target_month);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gift_campaigns TO authenticated;
GRANT ALL ON public.gift_campaigns TO service_role;
ALTER TABLE public.gift_campaigns ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gift_campaigns_select" ON public.gift_campaigns FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "gift_campaigns_insert" ON public.gift_campaigns FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());
CREATE POLICY "gift_campaigns_update" ON public.gift_campaigns FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.is_privileged(auth.uid())
    OR (location_id IS NOT NULL AND public.can_manage_location(auth.uid(), location_id)));
CREATE POLICY "gift_campaigns_delete" ON public.gift_campaigns FOR DELETE TO authenticated
  USING (created_by = auth.uid() OR public.is_privileged(auth.uid()));
CREATE TRIGGER trg_gift_campaigns_updated BEFORE UPDATE ON public.gift_campaigns
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.gift_campaign_recipients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid NOT NULL REFERENCES public.gift_campaigns(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  excluded_reason text,
  approved boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (campaign_id, contact_id)
);
CREATE INDEX gift_campaign_recipients_campaign_idx ON public.gift_campaign_recipients(campaign_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gift_campaign_recipients TO authenticated;
GRANT ALL ON public.gift_campaign_recipients TO service_role;
ALTER TABLE public.gift_campaign_recipients ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gcr_select" ON public.gift_campaign_recipients FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.gift_campaigns c WHERE c.id = campaign_id
    AND (c.created_by = auth.uid() OR c.location_id IS NULL OR public.can_view_location(auth.uid(), c.location_id))));
CREATE POLICY "gcr_write" ON public.gift_campaign_recipients FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.gift_campaigns c WHERE c.id = campaign_id
    AND (c.created_by = auth.uid() OR public.is_privileged(auth.uid()))))
  WITH CHECK (EXISTS (SELECT 1 FROM public.gift_campaigns c WHERE c.id = campaign_id
    AND (c.created_by = auth.uid() OR public.is_privileged(auth.uid()))));

CREATE TABLE public.gift_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id uuid REFERENCES public.gift_campaigns(id) ON DELETE SET NULL,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES public.gift_catalog(id) ON DELETE SET NULL,
  sent_at timestamptz NOT NULL DEFAULT now(),
  cost_cents integer NOT NULL DEFAULT 0,
  delivery_status public.gift_delivery_status NOT NULL DEFAULT 'queued',
  tracking_ref text,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX gift_sends_account_idx ON public.gift_sends(account_id, sent_at DESC);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.gift_sends TO authenticated;
GRANT ALL ON public.gift_sends TO service_role;
ALTER TABLE public.gift_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gift_sends_select" ON public.gift_sends FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
    AND (a.created_by = auth.uid() OR a.assigned_rep = auth.uid() OR public.can_view_location(auth.uid(), a.location_id))));
CREATE POLICY "gift_sends_insert" ON public.gift_sends FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a WHERE a.id = account_id
    AND (a.assigned_rep = auth.uid() OR public.can_manage_location(auth.uid(), a.location_id))));
CREATE POLICY "gift_sends_update" ON public.gift_sends FOR UPDATE TO authenticated
  USING (created_by = auth.uid() OR public.is_privileged(auth.uid()));
CREATE POLICY "gift_sends_delete" ON public.gift_sends FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));

CREATE OR REPLACE FUNCTION public.tg_gift_send_touchpoint()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  INSERT INTO public.touchpoints(account_id, contact_id, type, occurred_at, notes, created_by)
  VALUES (NEW.account_id, NEW.contact_id, 'gift', NEW.sent_at,
          COALESCE(NEW.notes, 'Gift sent'), COALESCE(NEW.created_by, auth.uid()));
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_gift_send_touchpoint AFTER INSERT ON public.gift_sends
  FOR EACH ROW EXECUTE FUNCTION public.tg_gift_send_touchpoint();

CREATE TABLE public.seasonal_sends (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  occasion public.gift_occasion NOT NULL DEFAULT 'seasonal',
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  sent_at timestamptz,
  recipient_count integer NOT NULL DEFAULT 0,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.seasonal_sends TO authenticated;
GRANT ALL ON public.seasonal_sends TO service_role;
ALTER TABLE public.seasonal_sends ENABLE ROW LEVEL SECURITY;
CREATE POLICY "seasonal_sends_select" ON public.seasonal_sends FOR SELECT TO authenticated
  USING (location_id IS NULL OR public.can_view_location(auth.uid(), location_id) OR created_by = auth.uid());
CREATE POLICY "seasonal_sends_write" ON public.seasonal_sends FOR ALL TO authenticated
  USING (created_by = auth.uid() OR public.is_privileged(auth.uid()))
  WITH CHECK (created_by = auth.uid() OR public.is_privileged(auth.uid()));

-- ============================================================
-- PART B: EQUIPMENT
-- ============================================================

CREATE TYPE public.equipment_type AS ENUM
  ('air_mover','dehumidifier','air_scrubber','hepa','heater','generator','moisture_meter','other');
CREATE TYPE public.equipment_status AS ENUM
  ('available','on_job','in_transit','maintenance','lost','retired');
CREATE TYPE public.equipment_condition AS ENUM ('good','damaged','needs_service','missing');

CREATE TABLE public.equipment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  asset_tag text NOT NULL UNIQUE,
  equipment_type public.equipment_type NOT NULL,
  make text,
  model text,
  serial_number text,
  purchase_date date,
  purchase_cost_cents integer,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  status public.equipment_status NOT NULL DEFAULT 'available',
  external_tracker_id text UNIQUE,
  notes text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_location_idx ON public.equipment(location_id, status);
CREATE INDEX equipment_type_idx ON public.equipment(equipment_type);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.equipment TO authenticated;
GRANT ALL ON public.equipment TO service_role;
ALTER TABLE public.equipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY "equipment_select" ON public.equipment FOR SELECT TO authenticated
  USING (created_by = auth.uid() OR public.can_view_location(auth.uid(), location_id));
CREATE POLICY "equipment_insert" ON public.equipment FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_location(auth.uid(), location_id));
CREATE POLICY "equipment_update" ON public.equipment FOR UPDATE TO authenticated
  USING (public.can_manage_location(auth.uid(), location_id));
CREATE POLICY "equipment_delete" ON public.equipment FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));
CREATE TRIGGER trg_equipment_updated BEFORE UPDATE ON public.equipment
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE public.equipment_placements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  equipment_id uuid NOT NULL REFERENCES public.equipment(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.jobs(id) ON DELETE CASCADE,
  placed_by uuid,
  placed_at timestamptz NOT NULL DEFAULT now(),
  placed_lat double precision,
  placed_lon double precision,
  expected_retrieval_date date,
  retrieved_at timestamptz,
  retrieved_by uuid,
  return_condition public.equipment_condition,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX equipment_placements_job_idx ON public.equipment_placements(job_id);
CREATE INDEX equipment_placements_equipment_idx ON public.equipment_placements(equipment_id, placed_at DESC);
CREATE UNIQUE INDEX equipment_placements_one_open_idx
  ON public.equipment_placements(equipment_id) WHERE retrieved_at IS NULL;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.equipment_placements TO authenticated;
GRANT ALL ON public.equipment_placements TO service_role;
ALTER TABLE public.equipment_placements ENABLE ROW LEVEL SECURITY;
CREATE POLICY "equipment_placements_select" ON public.equipment_placements FOR SELECT TO authenticated
  USING (placed_by = auth.uid() OR public.can_view_job(auth.uid(), job_id)
    OR EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = equipment_id AND public.can_view_location(auth.uid(), e.location_id)));
CREATE POLICY "equipment_placements_insert" ON public.equipment_placements FOR INSERT TO authenticated
  WITH CHECK (placed_by = auth.uid() AND public.can_view_job(auth.uid(), job_id));
CREATE POLICY "equipment_placements_update" ON public.equipment_placements FOR UPDATE TO authenticated
  USING (placed_by = auth.uid() OR public.can_view_job(auth.uid(), job_id));
CREATE POLICY "equipment_placements_delete" ON public.equipment_placements FOR DELETE TO authenticated
  USING (public.is_privileged(auth.uid()));
CREATE TRIGGER trg_equipment_placements_updated BEFORE UPDATE ON public.equipment_placements
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- keep equipment.status in step with placements
CREATE OR REPLACE FUNCTION public.tg_equipment_placement_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.retrieved_at IS NULL THEN
    UPDATE public.equipment SET status = 'on_job' WHERE id = NEW.equipment_id AND status IN ('available','in_transit');
  ELSE
    UPDATE public.equipment
      SET status = CASE WHEN NEW.return_condition = 'missing' THEN 'lost'
                        WHEN NEW.return_condition IN ('damaged','needs_service') THEN 'maintenance'
                        ELSE 'available' END
      WHERE id = NEW.equipment_id AND status = 'on_job';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_equipment_placement_status AFTER INSERT OR UPDATE ON public.equipment_placements
  FOR EACH ROW EXECUTE FUNCTION public.tg_equipment_placement_status();

CREATE TABLE public.equipment_tracker_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL DEFAULT 'kai',
  tracker_id text NOT NULL,
  equipment_id uuid REFERENCES public.equipment(id) ON DELETE SET NULL,
  occurred_at timestamptz NOT NULL,
  lat double precision,
  lon double precision,
  battery_pct smallint,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, tracker_id, occurred_at)
);
CREATE INDEX equipment_tracker_events_eq_idx ON public.equipment_tracker_events(equipment_id, occurred_at DESC);
GRANT SELECT ON public.equipment_tracker_events TO authenticated;
GRANT ALL ON public.equipment_tracker_events TO service_role;
ALTER TABLE public.equipment_tracker_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "tracker_events_select" ON public.equipment_tracker_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.equipment e WHERE e.id = equipment_id
    AND public.can_view_location(auth.uid(), e.location_id)));

-- ============================================================
-- PART C: TIME TRACKING
-- ============================================================

CREATE TYPE public.shift_status AS ENUM ('open','closed','approved','rejected');

CREATE TABLE public.shifts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  clock_in_at timestamptz NOT NULL DEFAULT now(),
  clock_in_lat double precision,
  clock_in_lon double precision,
  clock_out_at timestamptz,
  clock_out_lat double precision,
  clock_out_lon double precision,
  total_minutes integer,
  status public.shift_status NOT NULL DEFAULT 'open',
  approved_by uuid,
  approved_at timestamptz,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shifts_user_idx ON public.shifts(user_id, clock_in_at DESC);
CREATE INDEX shifts_location_idx ON public.shifts(location_id, clock_in_at DESC);
CREATE UNIQUE INDEX shifts_one_open_idx ON public.shifts(user_id) WHERE clock_out_at IS NULL;
GRANT SELECT, INSERT, UPDATE ON public.shifts TO authenticated;
GRANT ALL ON public.shifts TO service_role;
ALTER TABLE public.shifts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shifts_select" ON public.shifts FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.can_view_location(auth.uid(), location_id));
CREATE POLICY "shifts_insert" ON public.shifts FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "shifts_update" ON public.shifts FOR UPDATE TO authenticated
  USING (user_id = auth.uid() OR public.can_manage_location(auth.uid(), location_id));

CREATE OR REPLACE FUNCTION public.tg_shift_totals()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.clock_out_at IS NOT NULL THEN
    IF NEW.clock_out_at < NEW.clock_in_at THEN
      RAISE EXCEPTION 'Clock-out cannot be before clock-in';
    END IF;
    NEW.total_minutes := GREATEST(0, (EXTRACT(EPOCH FROM (NEW.clock_out_at - NEW.clock_in_at)) / 60)::int);
    IF NEW.status = 'open' THEN NEW.status := 'closed'; END IF;
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_shift_totals BEFORE INSERT OR UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.tg_shift_totals();

CREATE TABLE public.shift_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  actor_id uuid,
  field text NOT NULL,
  old_value text,
  new_value text,
  reason text,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX shift_corrections_shift_idx ON public.shift_corrections(shift_id, occurred_at DESC);
GRANT SELECT ON public.shift_corrections TO authenticated;
GRANT ALL ON public.shift_corrections TO service_role;
ALTER TABLE public.shift_corrections ENABLE ROW LEVEL SECURITY;
CREATE POLICY "shift_corrections_select" ON public.shift_corrections FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = shift_id
    AND (s.user_id = auth.uid() OR public.can_view_location(auth.uid(), s.location_id))));

CREATE OR REPLACE FUNCTION public.tg_shift_audit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.clock_in_at IS DISTINCT FROM OLD.clock_in_at THEN
    INSERT INTO public.shift_corrections(shift_id, actor_id, field, old_value, new_value, reason)
    VALUES (NEW.id, auth.uid(), 'clock_in_at', OLD.clock_in_at::text, NEW.clock_in_at::text, NEW.notes);
  END IF;
  IF NEW.clock_out_at IS DISTINCT FROM OLD.clock_out_at AND OLD.clock_out_at IS NOT NULL THEN
    INSERT INTO public.shift_corrections(shift_id, actor_id, field, old_value, new_value, reason)
    VALUES (NEW.id, auth.uid(), 'clock_out_at', OLD.clock_out_at::text, NEW.clock_out_at::text, NEW.notes);
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.shift_corrections(shift_id, actor_id, field, old_value, new_value, reason)
    VALUES (NEW.id, auth.uid(), 'status', OLD.status::text, NEW.status::text, NEW.notes);
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_shift_audit AFTER UPDATE ON public.shifts
  FOR EACH ROW EXECUTE FUNCTION public.tg_shift_audit();

CREATE TABLE public.time_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shift_id uuid REFERENCES public.shifts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  minutes integer,
  arrived_lat double precision,
  arrived_lon double precision,
  departed_lat double precision,
  departed_lon double precision,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX time_entries_user_idx ON public.time_entries(user_id, started_at DESC);
CREATE INDEX time_entries_job_idx ON public.time_entries(job_id);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_entries TO authenticated;
GRANT ALL ON public.time_entries TO service_role;
ALTER TABLE public.time_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY "time_entries_select" ON public.time_entries FOR SELECT TO authenticated
  USING (user_id = auth.uid()
    OR (job_id IS NOT NULL AND public.can_view_job(auth.uid(), job_id))
    OR EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = shift_id AND public.can_view_location(auth.uid(), s.location_id)));
CREATE POLICY "time_entries_insert" ON public.time_entries FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "time_entries_update" ON public.time_entries FOR UPDATE TO authenticated
  USING (user_id = auth.uid()
    OR EXISTS (SELECT 1 FROM public.shifts s WHERE s.id = shift_id AND public.can_manage_location(auth.uid(), s.location_id)));
CREATE POLICY "time_entries_delete" ON public.time_entries FOR DELETE TO authenticated
  USING (user_id = auth.uid() OR public.is_privileged(auth.uid()));

CREATE OR REPLACE FUNCTION public.tg_time_entry_minutes()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.ended_at IS NOT NULL THEN
    NEW.minutes := GREATEST(0, (EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at)) / 60)::int);
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END; $$;
CREATE TRIGGER trg_time_entry_minutes BEFORE INSERT OR UPDATE ON public.time_entries
  FOR EACH ROW EXECUTE FUNCTION public.tg_time_entry_minutes();