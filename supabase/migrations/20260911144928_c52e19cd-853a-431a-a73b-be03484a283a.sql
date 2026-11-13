-- Price lists: the state rate, which 20260910233000 left as a branch rate.
--
-- APPLIED to production on 2026-09-11 through Lovable ("Applied 3 migrations &
-- backed up") and ledgered as 20260911144928. Verified afterwards: price_list_assignments.state_code, its index and the one-scope CHECK are all live.
-- The paragraph below was written before it ran and is kept as the record of
-- what was weighed.
--
-- Originally: WRITTEN, NOT APPLIED. Additive: one nullable column, one widened CHECK, one
-- index. No data is written, nothing is dropped, no existing row changes
-- meaning, and every statement is guarded so re-running is a no-op.
--
-- WHAT DAVID ASKED FOR, on the call, in the same breath as the customer
-- agreement:
--   "Different states, you know, if one state, let's say New York and
--    California, I charge for labor $70 versus Jersey. I can charge $65."
--
-- WHAT WAS BUILT INSTEAD. 20260910233000 gave `price_list_assignments` two
-- scopes, account and location, and its own comment called the second one
-- "a state/branch rate". Those are not the same rule. A location is one
-- office; a state holds several of them, and Gold Star runs eleven offices
-- across a handful of states. Under the old shape, charging $65 across New
-- Jersey meant assigning the same list to every New Jersey branch by hand and
-- remembering to do it again when a branch opens — which is the copy-per-row
-- failure the original header rejected when it argued assignments into their
-- own table. So the branch scope stays (it is a real rule: one office that has
-- negotiated its own sheet) and the state becomes a scope of its own.
--
-- PRECEDENCE, and why it is not literally "customer > state > default".
-- Resolution is customer -> branch -> state -> catalog default, narrowest
-- first, in `buildPriceBook` (src/lib/price-lists.ts). The branch sits between
-- because it is inside the state: an office with its own negotiated sheet must
-- keep it, and every other office in that state follows the state rate. No
-- branch list is assigned today, so the effective order right now is exactly
-- the one David stated. Fall-through stays PER ITEM at every level, unchanged.
--
-- WHY A COLUMN AND NOT A `scope_type` ENUM. The table already says which rule
-- a row expresses by which foreign key is non-null, and a CHECK already
-- enforces exactly one. A `scope_type` column would state the same fact twice
-- and could disagree with the keys; widening the existing CHECK to three
-- columns keeps one source of truth and leaves every existing row valid
-- without a backfill. `state_code` is plain text rather than a foreign key
-- because there is no `states` table and inventing one to hold 50 constant
-- rows would be a join for nothing — the format CHECK does the work a lookup
-- table would.
--
-- WHERE THE STATE COMES FROM AT PRICING TIME. The two-letter code on the JOB
-- PROPERTY ADDRESS:
--
--   * `jobs.region` for a job. The column is named `region` (not `state`)
--     because it is one of the four address parts the app carries everywhere
--     — address / locality / region / postal_code — and it already holds the
--     SHORT form: `address-search.server.ts` reads Google's
--     `administrative_area_level_1` with short = true and strips Mapbox's
--     `US-` prefix, so an autocompleted address gives "NJ", not "New Jersey".
--   * the Job Calculator's own `region` input, which is the same property
--     address typed on the estimate before any job exists.
--   * failing both, `accounts.state` on the picked customer — a free-typed box
--     that may hold "New Jersey", so the client narrows every value through
--     `normalizeStateCode` (src/lib/us-states.ts) on both sides of the match.
--   * failing all three, the state layer is skipped and pricing falls through
--     to the catalog default, which is what happens today.
--
-- THE ASSUMPTION, stated because it is a judgement and not a fact: the state
-- that prices the work is the state the PROPERTY is in, never the office that
-- sold it. A New York branch drying out a New Jersey building charges the New
-- Jersey rate. That is how a sell rate behaves for a restoration job (the work
-- happens at the loss), but if Gold Star means it the other way the change is
-- one line in the client resolver, not here.
--
-- STILL NO COST IN THESE TABLES. Unchanged from 20260910233000: a price list
-- carries a sell price only, so there is nothing here behind a column grant
-- and nothing for `job.view_costs` to gate.
--
-- SEEDS NOTHING. No list, no assignment, no state row. Whether New Jersey has
-- a rate, and what it is, is an office decision made in Admin -> Price lists.

-- ------------------------------------------------------------- the column

ALTER TABLE public.price_list_assignments
  ADD COLUMN IF NOT EXISTS state_code text;

-- Two uppercase letters or nothing. Stored normalized so the resolver can
-- compare codes directly; the client normalizes before it writes, and this is
-- the backstop for anything that reaches the table another way.
ALTER TABLE public.price_list_assignments
  DROP CONSTRAINT IF EXISTS price_list_assignments_state_format;
ALTER TABLE public.price_list_assignments
  ADD CONSTRAINT price_list_assignments_state_format CHECK (
    state_code IS NULL OR state_code ~ '^[A-Z]{2}$'
  );

-- ------------------------------------------------- exactly one scope, of three
--
-- Replaces the two-column version. Dropped by name first so applying this file
-- twice, or applying it after a hand-edit, both land on the same constraint.
-- Every existing row satisfies it: `state_code` defaults to NULL, so a row
-- that named an account or a location still names exactly one thing.

ALTER TABLE public.price_list_assignments
  DROP CONSTRAINT IF EXISTS price_list_assignments_one_scope;
ALTER TABLE public.price_list_assignments
  ADD CONSTRAINT price_list_assignments_one_scope CHECK (
    (account_id IS NOT NULL)::int
    + (location_id IS NOT NULL)::int
    + (state_code IS NOT NULL)::int = 1
  );

CREATE INDEX IF NOT EXISTS price_list_assignments_state_idx
  ON public.price_list_assignments (state_code) WHERE state_code IS NOT NULL;

COMMENT ON COLUMN public.price_list_assignments.state_code IS
  'Two-letter US state this list is the standing rate for, matched against the job property address (jobs.region). Null on customer and branch assignments.';

COMMENT ON TABLE public.price_list_assignments IS
  'Applies a price list to one customer (account), one branch (location) or one US state (state_code), between two dates. Exactly one scope per row. Resolution is customer > branch > state > catalog default, per item; see src/lib/price-lists.ts.';

-- --------------------------------------------------------------------- RLS
--
-- Deliberately nothing to add. RLS is per TABLE, and `price_list_assignments`
-- already carries `price_list_assignments_select` (every authenticated user
-- reads) and `price_list_assignments_write` (is_privileged writes) from
-- 20260910233000. A new column is covered by both the moment it exists, and
-- the grants are table-level for the same reason given there: these tables
-- hold sell prices, and sell prices are not withheld from our own staff.
--
-- Restating the policies here would mean two migrations owning one rule, and
-- whichever ran last would quietly win. If the policies ever need to change,
-- they change in one place.

-- ========================================================================
-- Verification
-- ========================================================================
--
--   -- the CHECK now admits a state row and still refuses two scopes
--   INSERT INTO public.price_list_assignments (price_list_id, state_code)
--   VALUES ('<list>', 'NJ');                                    -- accepted
--   INSERT INTO public.price_list_assignments (price_list_id, state_code, account_id)
--   VALUES ('<list>', 'NJ', '<account>');                       -- rejected
--   INSERT INTO public.price_list_assignments (price_list_id, state_code)
--   VALUES ('<list>', 'New Jersey');                            -- rejected
--
--   -- every pre-existing row still satisfies the widened constraint
--   SELECT count(*) FROM public.price_list_assignments
--    WHERE (account_id IS NOT NULL)::int
--        + (location_id IS NOT NULL)::int
--        + (state_code IS NOT NULL)::int <> 1;
--   -- expected: 0
--
-- Rollback:
--   ALTER TABLE public.price_list_assignments
--     DROP CONSTRAINT IF EXISTS price_list_assignments_one_scope;
--   ALTER TABLE public.price_list_assignments
--     ADD CONSTRAINT price_list_assignments_one_scope CHECK (
--       (account_id IS NOT NULL AND location_id IS NULL)
--       OR (account_id IS NULL AND location_id IS NOT NULL));
--   ALTER TABLE public.price_list_assignments
--     DROP CONSTRAINT IF EXISTS price_list_assignments_state_format;
--   DROP INDEX IF EXISTS public.price_list_assignments_state_idx;
--   ALTER TABLE public.price_list_assignments DROP COLUMN IF EXISTS state_code;
--   -- Drop the column only after confirming no state assignment is in use:
--   --   SELECT count(*) FROM public.price_list_assignments WHERE state_code IS NOT NULL;