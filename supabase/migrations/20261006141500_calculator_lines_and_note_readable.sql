-- Reopening a calculator estimate wiped its typed-in lines and its note.
--
-- 20260909110000 took table-level SELECT on job_calculations away from
-- `authenticated` and granted it back column by column, withholding the three
-- cost snapshots (internal_cost, equipment_profit, overall_profit) so a rep
-- never reads Gold Star's margin. `custom_lines` (20260917120500) and `note`
-- (20260918160000) arrived after that and were never added to the grant: the
-- editor could write them but not read them back. A reopened estimate loaded
-- both as empty, and the next Save wrote [] and NULL over what was there.
--
-- Neither is a cost: a custom line is {label, amount} where amount is the
-- customer price printed on the customer PDF, and the note is the estimate's
-- note. The cost columns stay withheld.
--
-- APPLIED to production 2026-10-06 before the code that selects them, so no
-- reader ever asked for a column it could not see.

GRANT SELECT (custom_lines, note) ON public.job_calculations TO authenticated;
