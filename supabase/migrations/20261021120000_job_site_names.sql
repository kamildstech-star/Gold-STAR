-- Building and facility names on a job (client meeting, 21 Oct — David).
--
-- `community` already holds the development or complex. A job also needs the
-- BUILDING within it and the FACILITY (a nursing home, a school) — the name
-- the customer and the crew actually use for the place. Both optional, plain
-- text, shown on the New Job page and the job page's Property card, and
-- matched by the jobs search (job-site-names.ts).
--
-- Edits are already audited: log_job_field_changes() walks every column of
-- `jobs` from information_schema, so the new columns are logged with no
-- change to it. They are added to the Revert allow-list below, which is
-- otherwise exactly 20261006152000's (job-field-revert.test.ts pins the two
-- lists together).
--
-- The app writes these columns in a separate update after a job is saved and
-- falls back when they are missing, so it runs before this is applied.
--
-- Re-runnable.

ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS building_name text,
  ADD COLUMN IF NOT EXISTS facility_name text;

COMMENT ON COLUMN public.jobs.building_name IS
  'The building within the community/complex, e.g. "Building C". Optional.';
COMMENT ON COLUMN public.jobs.facility_name IS
  'The facility the job is at, e.g. a nursing home. Optional.';

-- The Revert allow-list, plus the two new columns.
CREATE OR REPLACE FUNCTION public.job_revertable_fields()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT ARRAY[
    'account_id', 'additional_work_pending', 'address', 'address_line2',
    'adjuster_email', 'adjuster_name', 'adjuster_phone', 'bill_to_account_id',
    'bill_to_attention', 'billing_location_id', 'building_name', 'call_date', 'call_time',
    'cash_payer_name', 'claim_number', 'community', 'completion_date', 'county',
    'crew_chief', 'customer_kind', 'customer_name', 'desk_adjuster_contact_id',
    'desk_adjuster_email', 'desk_adjuster_name', 'desk_adjuster_phone', 'facility_name',
    'field_adjuster_contact_id', 'field_adjuster_email', 'field_adjuster_name',
    'field_adjuster_phone', 'field_next_step', 'hoa', 'important_instructions',
    'independent_reviewer_account_id', 'independent_reviewer_contact_id',
    'independent_reviewer_email', 'independent_reviewer_firm',
    'independent_reviewer_name', 'independent_reviewer_phone',
    'initial_loss_description', 'insurance_agency', 'insurance_agency_account_id',
    'insurance_agent_email', 'insurance_agent_name', 'insurance_agent_phone',
    'insurance_carrier', 'insurance_carrier_account_id', 'insurance_kind',
    'insurance_kind_detail', 'job_name', 'job_number', 'job_type',
    'job_type_detail', 'lat', 'locality', 'location_id', 'lon', 'loss_date',
    'loss_description', 'loss_description_detail', 'loss_type',
    'loss_type_detail', 'loss_type_id', 'office_next_step', 'payment_terms',
    'policy_number', 'postal_code', 'primary_contact_id', 'priority',
    'public_adjuster_account_id', 'public_adjuster_contact_id',
    'public_adjuster_email', 'public_adjuster_name', 'public_adjuster_phone',
    'referral_source_type', 'referral_source_type_detail',
    'referred_by_account_id', 'referred_by_contact_id', 'referred_by_name',
    'region', 'rehabbed_after_1978', 'reported_source_detail',
    'reported_source_id', 'scope', 'stage_id', 'start_date', 'status',
    'third_party_company', 'water_category', 'water_class'
  ]::text[];
$$;

REVOKE ALL ON FUNCTION public.job_revertable_fields() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.job_revertable_fields() TO authenticated, service_role;
