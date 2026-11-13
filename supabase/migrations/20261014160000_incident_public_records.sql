-- Free public-record property basics for an incident, cached.
--
-- WRITTEN, NOT APPLIED. One new table. Until it is applied the chase card
-- still shows the basics: lookupIncidentPublicRecord treats a missing table
-- as "no cache" and goes to the public source each time (rate limited).
--
-- Mark, 14 Oct: "yes show the free public record basics before claim". The
-- chase card's Homeowner / contact status box shows the owner of record,
-- property class, units, year built, last sale and assessed value from free
-- government sources (NYC PLUTO + ACRIS, NJ MOD-IV parcels, NYS tax parcels)
-- to anyone who can see the incident. Phone and email stay behind the claim,
-- on the paid quick-skip path and its incident_property_lookups table.
--
-- WHY A SEPARATE TABLE: incident_property_lookups holds the paid skip-trace
-- result, phone and email included, and its SELECT policy is "the claimer"
-- (20260813231013). Widening that table to everyone who can see the incident
-- would have widened phone/email with it. This table has no phone, email or
-- mailing-address column at all, so it cannot hold them.
--
-- Access:
--   SELECT   anyone who can SELECT the incident. The policy is an EXISTS on
--            public.incidents, which runs under the caller's own incidents
--            policies, so visibility follows incidents_select exactly and
--            keeps following it when that policy changes.
--   writes   service role only (the server function, after it has read the
--            incident through the caller's RLS client). No INSERT / UPDATE /
--            DELETE grant to authenticated, nothing at all to anon.
--   guards   the restrictive active-profile / anon / portal policies every
--            RLS table carries (20260929121000), restated here.
--
-- status 'found' rows carry the record; 'not_found' rows remember that every
-- free source answered and none has the parcel, so a card in an uncovered
-- area does not re-ask on every view. The server treats found rows as fresh
-- for 30 days and not_found rows for 7.

CREATE TABLE IF NOT EXISTS public.incident_public_records (
  incident_id uuid PRIMARY KEY REFERENCES public.incidents(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('found', 'not_found')),
  source text CHECK (source IS NULL OR source IN ('nyc_pluto', 'nj_modiv', 'nys_parcels')),
  source_label text,
  source_vintage text,
  parcel_id text,
  parcel_address text,
  owner_name text,
  owner_withheld boolean NOT NULL DEFAULT false,
  property_class text,
  property_class_label text,
  unit_count integer CHECK (unit_count IS NULL OR unit_count BETWEEN 1 AND 100000),
  year_built smallint CHECK (year_built IS NULL OR year_built BETWEEN 1600 AND 2200),
  last_sale_date date,
  last_sale_amount numeric(14, 0) CHECK (last_sale_amount IS NULL OR last_sale_amount > 0),
  assessed_value numeric(14, 0) CHECK (assessed_value IS NULL OR assessed_value > 0),
  note text,
  fetched_by uuid,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT incident_public_records_found_has_source
    CHECK (status = 'not_found' OR source IS NOT NULL),
  CONSTRAINT incident_public_records_text_check CHECK (
    coalesce(length(source_label), 0) <= 120
    AND coalesce(length(source_vintage), 0) <= 40
    AND coalesce(length(parcel_id), 0) <= 60
    AND coalesce(length(parcel_address), 0) <= 300
    AND coalesce(length(owner_name), 0) <= 300
    AND coalesce(length(property_class), 0) <= 10
    AND coalesce(length(property_class_label), 0) <= 80
    AND coalesce(length(note), 0) <= 300
  )
);

REVOKE ALL ON public.incident_public_records FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.incident_public_records TO authenticated;
GRANT ALL ON public.incident_public_records TO service_role;

ALTER TABLE public.incident_public_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS incident_public_records_select ON public.incident_public_records;
CREATE POLICY incident_public_records_select ON public.incident_public_records
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.incidents i WHERE i.id = incident_public_records.incident_id
  ));

DROP POLICY IF EXISTS active_profile_required ON public.incident_public_records;
CREATE POLICY active_profile_required ON public.incident_public_records
  AS RESTRICTIVE FOR ALL TO authenticated
  USING ((SELECT goldstar_private.profile_is_active(auth.uid())))
  WITH CHECK ((SELECT goldstar_private.profile_is_active(auth.uid())));
DROP POLICY IF EXISTS anonymous_business_access_denied ON public.incident_public_records;
CREATE POLICY anonymous_business_access_denied ON public.incident_public_records
  AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'portal_customer') THEN
    DROP POLICY IF EXISTS portal_customer_denied ON public.incident_public_records;
    CREATE POLICY portal_customer_denied ON public.incident_public_records
      AS RESTRICTIVE FOR ALL TO portal_customer USING (false) WITH CHECK (false);
  END IF;
END $$;

DROP TRIGGER IF EXISTS trg_incident_public_records_updated_at ON public.incident_public_records;
CREATE TRIGGER trg_incident_public_records_updated_at
  BEFORE UPDATE ON public.incident_public_records
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
