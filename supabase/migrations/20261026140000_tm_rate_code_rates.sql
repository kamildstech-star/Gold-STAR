-- What each T&M rate code BILLS at, for the T&M bill (David, 26 Oct).
--
-- Until now the codes deliberately had no prices: the office billed T&M jobs in
-- T&M Pro, which held the rates. The weekly T&M invoice package is now made
-- here from the daily forms (src/lib/tm-bill.ts), so each code carries its
-- rate — edited where the codes are, Settings › Operations › T&M rate codes,
-- by the same people (is_privileged, the existing update policy):
--   labor codes   per hour;
--   supplies      per unit (consumables, PPE, equipment, vehicles);
--   GEN-PERDIEM   per person-day;
--   GEN-SMALLTOOLS a PERCENT of each person-day's billed labor.
-- NULL = not set: the bill prices that code at $0 and names it, never a guess.
--
-- A charge rate, like the estimate catalogue's prices, which every signed-in
-- user can already read — not a cost rate (labour_rates stays manager-only).
--
-- Seeded from David's sample ("Lallypak Week 1"): the seven title codes it
-- bills, and the 3% small-tools fee. Only where no rate is set yet, so a rate
-- typed in Settings is never overwritten by a re-run.

ALTER TABLE public.tm_rate_codes
  ADD COLUMN IF NOT EXISTS rate numeric(10,2);

DO $$ BEGIN
  ALTER TABLE public.tm_rate_codes
    ADD CONSTRAINT tm_rate_codes_rate_nonnegative CHECK (rate IS NULL OR rate >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN public.tm_rate_codes.rate IS
  'What the code bills at on the T&M bill: per hour (labor), per unit (supplies), per person-day (GEN-PERDIEM), percent of labor (GEN-SMALLTOOLS). NULL = not set, billed at $0 and named.';

UPDATE public.tm_rate_codes AS t
   SET rate = s.rate
  FROM (VALUES
    ('GL', 70.00), ('SCL', 88.00), ('CCF', 100.00), ('PS', 110.00),
    ('PE', 125.00), ('SPM', 130.00), ('PCT', 165.00),
    ('GEN-SMALLTOOLS', 3.00)
  ) AS s(code, rate)
 WHERE t.code = s.code
   AND t.rate IS NULL;
