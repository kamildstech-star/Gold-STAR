-- Gold Star's real cost rates, so running costs stop reading $0.
--
-- Meeting point 7 carried a standing note against it: "crew rate + equipment
-- day rates must be set in the app or costs show $0". The engine has always
-- been correct and has always had nothing to multiply — labour_rates was empty
-- of a corporate default and equipment.daily_rate_cents was unset, so every
-- honest calculation came out at zero. David's own numbers arrived on 18 Sep
-- from the Item Cost sheet of his Excel calculator, corroborated by his
-- Equipment Tracking sheet.
--
-- THESE ARE COSTS — what GSR pays per day — NOT charge rates. His crew charge
-- rate is $65/hour and it is not touched here or anywhere else: charge lives in
-- the estimate catalogue and mixing the two is how a margin report starts lying.
--
-- Nothing is restructured. Three existing places take the numbers:
--   · public.labour_rates        — the crew hourly cost job_running_cost() falls
--                                  back to for an unrated user, and the same row
--                                  fetchTicketRates() prices a field ticket with
--   · public.equipment           — daily_rate_cents per asset, which the running
--                                  cost multiplies by the days of a placement
--   · public.app_settings        — a small day-rate card for the machine classes
--                                  Gold Star does not asset-tag at all

-- 1. Crew labour cost: $45/hour ---------------------------------------------
-- A row with user_id, location_id, role and crew_class all NULL is the
-- corporate default — the last thing job_running_cost() reaches for when a
-- person has no pay structure and no rate of their own.
--
-- FIRST, the constraint has to admit that such a row exists. Applying this
-- migration failed and rolled back with:
--
--   new row for relation "labour_rates" violates check constraint
--   "labour_rate_subject" (23514)
--
-- labour_rate_subject has always demanded that a rate name its subject. It
-- started as (user_id IS NOT NULL OR role IS NOT NULL) in 20260804185343, and
-- 20260902200000 added crew_class to the list rather than loosening it, saying
-- so explicitly: a crew-class rate "is still a real subject, so it joins the
-- list rather than loosening the rule to 'anything goes'".
--
-- The corporate default joins that list for the same reason. It names nobody
-- BECAUSE it applies to everybody, which is a subject — the widest one there
-- is — and it is the row two separate costing paths already fall back to:
-- job_running_cost() for an unrated user, and fetchTicketRates() for every
-- field ticket. The concept won; the constraint predates it.
--
-- The rule is still bounded, and that is the point of spelling the shape out
-- rather than dropping the constraint. A rate with NO subject AND an office
-- attached stays illegal: "$45/hour at the Paterson office, for whom?" is
-- exactly the ambiguity the original constraint exists to prevent. Only the
-- single global fallback — no person, no role, no crew class, no office — is
-- added.
--
-- Strictly more permissive than what it replaces, so re-validating the
-- existing rows cannot fail, and the app cannot produce the new shape by
-- accident: supersedeRate() is the only insert in the codebase and the admin
-- screen always supplies a role.
ALTER TABLE public.labour_rates DROP CONSTRAINT IF EXISTS labour_rate_subject;
DO $$ BEGIN
  ALTER TABLE public.labour_rates
    ADD CONSTRAINT labour_rate_subject
    CHECK (
      user_id IS NOT NULL
      OR role IS NOT NULL
      OR crew_class IS NOT NULL
      -- The company-wide default, spelled out in full so the shape is the
      -- documentation: nobody named, and no office either.
      OR (
        user_id IS NULL
        AND role IS NULL
        AND crew_class IS NULL
        AND location_id IS NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

--
-- Any open-ended corporate default carrying a different number is closed off
-- rather than deleted, because a rate is effective-dated and a job costed last
-- month should still cost what it cost last month.
UPDATE public.labour_rates
   SET effective_to = DATE '2026-09-17'
 WHERE user_id IS NULL
   AND location_id IS NULL
   AND role IS NULL
   AND crew_class IS NULL
   AND effective_to IS NULL
   AND hourly_rate <> 45;

INSERT INTO public.labour_rates
  (user_id, location_id, role, crew_class, hourly_rate, effective_from, note, is_demo)
SELECT NULL, NULL, NULL, NULL, 45, DATE '2026-09-18',
       'Crew labor cost from David''s Item Cost sheet, 18 Sep. Cost, not the $65/hr charge rate.',
       false
 WHERE NOT EXISTS (
   SELECT 1 FROM public.labour_rates
    WHERE user_id IS NULL AND location_id IS NULL AND role IS NULL AND crew_class IS NULL
      AND hourly_rate = 45 AND effective_to IS NULL
 );

-- 2. Equipment day rates on the asset register -------------------------------
-- One rate per TYPE, applied to every unit of it — which is how the catalog is
-- priced in practice; public.setTypeRate() in the app does exactly this.
--
-- Only rows with nothing set are touched. The complaint was $0, and a rate an
-- admin has already typed at /admin/equipment-rates is a decision, not a gap.
--
-- Mapping from David's names to the register's eight enum values:
--   Air Mover            $5  -> air_mover
--   Dehumidifier         $20 -> dehumidifier
--   Scrubber XL          $10 -> air_scrubber
--   Scrubber XXL         $15 -> hepa
--   Generator            $10 -> generator
-- His "w/filter" variants are not separate rows: a filter is a consumable off
-- the supply catalogue, not a different machine, and he prices XL and XL
-- w/filter identically anyway.
UPDATE public.equipment SET daily_rate_cents = 500
 WHERE equipment_type = 'air_mover'    AND coalesce(daily_rate_cents, 0) = 0;
UPDATE public.equipment SET daily_rate_cents = 2000
 WHERE equipment_type = 'dehumidifier' AND coalesce(daily_rate_cents, 0) = 0;
UPDATE public.equipment SET daily_rate_cents = 1000
 WHERE equipment_type = 'air_scrubber' AND coalesce(daily_rate_cents, 0) = 0;
UPDATE public.equipment SET daily_rate_cents = 1500
 WHERE equipment_type = 'hepa'         AND coalesce(daily_rate_cents, 0) = 0;
UPDATE public.equipment SET daily_rate_cents = 1000
 WHERE equipment_type = 'generator'    AND coalesce(daily_rate_cents, 0) = 0;

-- 3. The classes the register cannot hold ------------------------------------
-- A field ticket counts injectors, ozone machines and hydroxyl generators, and
-- equipment_type is an enum of eight values that has none of them. Gold Star
-- does not asset-tag those units, so the ticket's number is the only record
-- there will ever be of them — and until now they priced at nothing, silently.
--
-- One app_settings row, keyed by the ticket's own vocabulary, read by
-- fetchTicketRates() ONLY where the asset register has no rate for that key.
-- The register stays authoritative and /admin/equipment-rates still wins; this
-- fills the holes it cannot reach. Dollars per machine per day.
--
-- `other_rates` is the rest of David's sheet: real numbers with nothing in the
-- app that counts them yet. They are recorded here rather than dropped, so the
-- day a bucket of encapsulant or a set of air samples becomes a countable line
-- the figure is already his and not a guess.
INSERT INTO public.app_settings (key, value)
VALUES (
  'equipment_day_rates',
  jsonb_build_object(
    'source',      'David Stern, Item Cost sheet, 18 Sep 2026. Costs, not charge rates.',
    'day_rates',   jsonb_build_object(
      'air_mover',    5,
      'dehumidifier', 20,
      -- Scrubber XL. His XXL is $15 and sits on the `hepa` assets above; the
      -- field ticket has one generic Scrubber box, so this is the common unit.
      'scrubber',     10,
      'injector',     10,
      'ozone',        10,
      'hydroxyl',     20,
      'generator',    10
    ),
    'other_rates', jsonb_build_object(
      'submersible_pump',     jsonb_build_object('amount', 5,   'per', 'day'),
      'encapsulation',        jsonb_build_object('amount', 200, 'per', 'bucket'),
      'air_samples',          jsonb_build_object('amount', 175, 'per', 'batch of up to 4 samples')
    )
  )
)
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
