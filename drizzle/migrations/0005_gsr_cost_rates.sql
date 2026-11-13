ALTER TABLE public.labour_rates DROP CONSTRAINT IF EXISTS labour_rate_subject;
DO $$ BEGIN
  ALTER TABLE public.labour_rates
    ADD CONSTRAINT labour_rate_subject
    CHECK (
      user_id IS NOT NULL
      OR role IS NOT NULL
      OR crew_class IS NOT NULL
      OR (
        user_id IS NULL
        AND role IS NULL
        AND crew_class IS NULL
        AND location_id IS NULL
      )
    );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

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

INSERT INTO public.app_settings (key, value)
VALUES (
  'equipment_day_rates',
  jsonb_build_object(
    'source',      'David Stern, Item Cost sheet, 18 Sep 2026. Costs, not charge rates.',
    'day_rates',   jsonb_build_object(
      'air_mover',    5,
      'dehumidifier', 20,
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