-- 1. Email category
ALTER TYPE public.email_category ADD VALUE IF NOT EXISTS 'payment_receipt';

-- 2. Simple column additions
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS primary_location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL;

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS author_kind text NOT NULL DEFAULT 'user';
DO $$ BEGIN
  ALTER TABLE public.messages ADD CONSTRAINT messages_author_kind_check
    CHECK (author_kind IN ('user','assistant'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE public.accounts
  ADD COLUMN IF NOT EXISTS is_multi_location boolean NOT NULL DEFAULT false;

ALTER TABLE public.job_drying_readings
  ADD COLUMN IF NOT EXISTS is_baseline boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS photo_path text,
  ADD COLUMN IF NOT EXISTS photo_thumb_path text,
  ADD COLUMN IF NOT EXISTS photo_mime text,
  ADD COLUMN IF NOT EXISTS values_source text NOT NULL DEFAULT 'typed';

ALTER TABLE public.share_links
  ADD COLUMN IF NOT EXISTS document_ids text[];

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS photo_ids text[],
  ADD COLUMN IF NOT EXISTS photo_share_link_id uuid REFERENCES public.share_links(id) ON DELETE SET NULL;

ALTER TABLE public.job_reports
  ADD COLUMN IF NOT EXISTS photo_ids text[];

ALTER TABLE public.intake_submissions
  ADD COLUMN IF NOT EXISTS account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL;

ALTER TABLE public.intake_requests
  ADD COLUMN IF NOT EXISTS multi_use boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS tradeshow_id uuid REFERENCES public.tradeshows(id) ON DELETE SET NULL;

ALTER TABLE public.intake_questions
  ADD COLUMN IF NOT EXISTS ask_on_public_form boolean NOT NULL DEFAULT false;

ALTER TABLE public.labour_rates
  ADD COLUMN IF NOT EXISTS crew_class text;
DO $$ BEGIN
  ALTER TABLE public.labour_rates ADD CONSTRAINT labour_rates_crew_class_check
    CHECK (crew_class IS NULL OR crew_class IN ('gsr','temp'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 3. Buildings
CREATE TABLE IF NOT EXISTS public.account_properties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  name text,
  address text NOT NULL,
  address_key text NOT NULL,
  notes text,
  active boolean NOT NULL DEFAULT true,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, address_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_properties TO authenticated;
GRANT ALL ON public.account_properties TO service_role;
ALTER TABLE public.account_properties ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members of the owning office manage buildings"
  ON public.account_properties FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.accounts a
                 WHERE a.id = account_id AND public.can_view_location(auth.uid(), a.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.accounts a
                 WHERE a.id = account_id AND public.can_view_location(auth.uid(), a.location_id)));

CREATE TABLE IF NOT EXISTS public.account_property_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES public.account_properties(id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  position_key text,
  sort_order integer NOT NULL DEFAULT 0,
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (property_id, contact_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_property_contacts TO authenticated;
GRANT ALL ON public.account_property_contacts TO service_role;
ALTER TABLE public.account_property_contacts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members of the owning office manage building contacts"
  ON public.account_property_contacts FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.account_properties p
                 JOIN public.accounts a ON a.id = p.account_id
                 WHERE p.id = property_id AND public.can_view_location(auth.uid(), a.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.account_properties p
                 JOIN public.accounts a ON a.id = p.account_id
                 WHERE p.id = property_id AND public.can_view_location(auth.uid(), a.location_id)));

-- 4. Trade show booth captures
CREATE TABLE IF NOT EXISTS public.tradeshow_lead_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tradeshow_id uuid NOT NULL REFERENCES public.tradeshows(id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('photo','audio')),
  storage_path text NOT NULL,
  thumb_path text,
  mime text,
  size_bytes integer,
  width integer,
  height integer,
  duration_seconds numeric,
  waveform_peaks numeric[],
  captured_at timestamptz NOT NULL DEFAULT now(),
  is_demo boolean NOT NULL DEFAULT false,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.tradeshow_lead_media TO authenticated;
GRANT ALL ON public.tradeshow_lead_media TO service_role;
ALTER TABLE public.tradeshow_lead_media ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members of the show's office manage booth captures"
  ON public.tradeshow_lead_media FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.tradeshows t
                 WHERE t.id = tradeshow_id AND public.can_view_location(auth.uid(), t.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.tradeshows t
                 WHERE t.id = tradeshow_id AND public.can_view_location(auth.uid(), t.location_id)));

-- 5. Office review of crew hours implied by a field ticket
CREATE TABLE IF NOT EXISTS public.field_ticket_crew_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id uuid NOT NULL REFERENCES public.field_work_tickets(id) ON DELETE CASCADE,
  crew_class text NOT NULL CHECK (crew_class IN ('gsr','temp')),
  review_state text NOT NULL DEFAULT 'proposed' CHECK (review_state IN ('proposed','accepted','dismissed')),
  headcount_override integer,
  minutes_each_override integer,
  note text,
  reviewed_by uuid,
  reviewed_at timestamptz,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ticket_id, crew_class)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.field_ticket_crew_reviews TO authenticated;
GRANT ALL ON public.field_ticket_crew_reviews TO service_role;
ALTER TABLE public.field_ticket_crew_reviews ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Members of the ticket's office manage crew reviews"
  ON public.field_ticket_crew_reviews FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.field_work_tickets t
                 WHERE t.id = ticket_id AND public.can_view_location(auth.uid(), t.location_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.field_work_tickets t
                 WHERE t.id = ticket_id AND public.can_view_location(auth.uid(), t.location_id)));

-- 6. updated_at triggers
DROP TRIGGER IF EXISTS update_account_properties_updated_at ON public.account_properties;
CREATE TRIGGER update_account_properties_updated_at BEFORE UPDATE ON public.account_properties
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS update_account_property_contacts_updated_at ON public.account_property_contacts;
CREATE TRIGGER update_account_property_contacts_updated_at BEFORE UPDATE ON public.account_property_contacts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS update_tradeshow_lead_media_updated_at ON public.tradeshow_lead_media;
CREATE TRIGGER update_tradeshow_lead_media_updated_at BEFORE UPDATE ON public.tradeshow_lead_media
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS update_field_ticket_crew_reviews_updated_at ON public.field_ticket_crew_reviews;
CREATE TRIGGER update_field_ticket_crew_reviews_updated_at BEFORE UPDATE ON public.field_ticket_crew_reviews
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- 7. Crew minutes, mirroring ticketCrewMinutes() in the app
CREATE OR REPLACE FUNCTION public.field_ticket_crew_minutes(_start text, _end text)
RETURNS integer
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE s integer; e integer;
BEGIN
  IF _start IS NULL OR _end IS NULL THEN RETURN NULL; END IF;
  IF _start !~ '^\d{1,2}:\d{2}(:\d{2})?$' OR _end !~ '^\d{1,2}:\d{2}(:\d{2})?$' THEN RETURN NULL; END IF;
  s := split_part(_start, ':', 1)::int * 60 + split_part(_start, ':', 2)::int;
  e := split_part(_end, ':', 1)::int * 60 + split_part(_end, ':', 2)::int;
  IF s > 1439 OR e > 1439 OR e <= s THEN RETURN NULL; END IF;
  RETURN e - s;
END;
$$;

-- 8. Crew hours for one job, costed only for roles allowed to see money
CREATE OR REPLACE FUNCTION public.job_ticket_crew_hours(_job_id uuid)
RETURNS TABLE (
  ticket_id uuid,
  work_date date,
  crew_class text,
  crew_chief_name text,
  ticket_headcount integer,
  ticket_minutes_each integer,
  headcount integer,
  minutes_each integer,
  total_minutes integer,
  problem text,
  review_state text,
  reviewed_at timestamptz,
  note text,
  cost numeric,
  rate_missing boolean,
  office_minutes integer
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH allowed AS (
    SELECT EXISTS (
      SELECT 1 FROM public.jobs j
      WHERE j.id = _job_id AND public.can_view_location(auth.uid(), j.location_id)
    ) AS ok
  ),
  money AS (
    SELECT public.is_privileged(auth.uid())
        OR public.has_role(auth.uid(), 'office')
        OR public.has_role(auth.uid(), 'location_manager')
        OR public.has_role(auth.uid(), 'regional')
        OR public.has_role(auth.uid(), 'sales_head') AS ok
  ),
  lines AS (
    SELECT t.id AS ticket_id, t.location_id, t.work_date, c.crew_class,
           t.crew_chief_name,
           CASE WHEN c.crew_class = 'gsr' THEN t.gsr_crew_size ELSE t.temp_crew_size END AS size,
           public.field_ticket_crew_minutes(t.job_start_time, t.job_end_time) AS mins,
           CASE
             WHEN t.job_start_time IS NULL OR t.job_end_time IS NULL THEN 'no_times'
             WHEN public.field_ticket_crew_minutes(t.job_start_time, t.job_end_time) IS NULL THEN 'end_not_after_start'
             ELSE NULL
           END AS problem
    FROM public.field_work_tickets t
    CROSS JOIN (VALUES ('gsr'),('temp')) AS c(crew_class)
    WHERE t.job_id = _job_id
  ),
  rows AS (
    SELECT l.*,
           r.review_state, r.reviewed_at, r.note,
           COALESCE(r.headcount_override, l.size) AS eff_head,
           COALESCE(r.minutes_each_override, l.mins) AS eff_mins,
           (SELECT lr.hourly_rate FROM public.labour_rates lr
             WHERE lr.user_id IS NULL AND lr.location_id = l.location_id
               AND lr.crew_class = l.crew_class
               AND lr.effective_from <= l.work_date
               AND (lr.effective_to IS NULL OR lr.effective_to >= l.work_date)
             ORDER BY lr.effective_from DESC LIMIT 1) AS rate
    FROM lines l
    LEFT JOIN public.field_ticket_crew_reviews r
      ON r.ticket_id = l.ticket_id AND r.crew_class = l.crew_class
    WHERE l.size IS NOT NULL AND l.size > 0
  )
  SELECT rows.ticket_id,
         rows.work_date,
         rows.crew_class,
         rows.crew_chief_name,
         rows.size::integer,
         rows.mins::integer,
         rows.eff_head::integer,
         rows.eff_mins::integer,
         (COALESCE(rows.eff_mins, 0) * rows.eff_head)::integer,
         rows.problem,
         COALESCE(rows.review_state, 'proposed'),
         rows.reviewed_at,
         rows.note,
         CASE WHEN (SELECT ok FROM money) AND rows.rate IS NOT NULL
              THEN ROUND(rows.rate * (COALESCE(rows.eff_mins, 0) * rows.eff_head) / 60.0, 2)
              ELSE NULL END,
         ((SELECT ok FROM money) AND rows.rate IS NULL),
         COALESCE((SELECT SUM(te.minutes)::integer FROM public.time_entries te
                    WHERE te.job_id = _job_id AND te.work_date = rows.work_date), 0)
  FROM rows
  WHERE (SELECT ok FROM allowed)
  ORDER BY rows.work_date DESC, rows.crew_class;
$$;

GRANT EXECUTE ON FUNCTION public.job_ticket_crew_hours(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.field_ticket_crew_minutes(text, text) TO authenticated;