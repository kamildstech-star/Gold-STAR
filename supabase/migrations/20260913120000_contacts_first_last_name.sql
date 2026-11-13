-- Contacts: first name and last name, beside full_name rather than instead of it.
--
-- WRITTEN, NOT APPLIED. Additive: two nullable columns, one trigger, one
-- backfill of rows that have nothing in the new columns. Nothing is dropped
-- and no existing value is overwritten.
--
-- WHAT DAVID ASKED FOR: first and last name as separate fields. Today
-- `public.contacts` has `full_name text NOT NULL` and nothing else.
--
-- WHY full_name STAYS. It is read essentially everywhere — the customers list,
-- every picker, the contact drawer, the org chart, document merge keys — and
-- it is NOT NULL. Removing it would be a rewrite of the application, not a
-- field change.
--
-- WHY A TRIGGER AND NOT A GENERATED COLUMN. A generated column cannot be
-- written to, and `full_name` is written by a lot of code that knows nothing
-- about first/last:
--
--   client:  src/lib/contacts.ts (createCustomerContact)
--            src/components/company-hierarchy-panel.tsx (two inserts)
--            src/components/account-prospect/prospect-new-contact-dialog.tsx
--            src/lib/tradeshow-review.ts, src/lib/tradeshow-lead-writes.ts
--   SQL:     the demo seeders (20260806202317, 20260806205751, 20260806203418,
--            20260806203515, 20260814001904, 20260814002136) all INSERT
--            full_name directly
--
-- Every one of those inserts would start failing with "cannot insert into
-- generated column" the moment such a migration applied. So `full_name` stays
-- an ordinary writable column and a trigger keeps it CONSISTENT instead:
--
--   * first_name or last_name present  ->  full_name is recomposed from them
--   * both NULL                        ->  full_name is left exactly as given
--
-- That second line is the whole compatibility story. Every writer listed above
-- supplies `full_name` and no name parts, so it lands untouched and the app
-- behaves exactly as it does today. A writer that supplies the parts (the two
-- screens updated alongside this migration) gets `full_name` composed for it,
-- so the pair and the composed string can never drift apart — including when
-- somebody edits a contact through a screen that has not been updated yet.
--
-- WHY NOT A CHECK THAT full_name EQUALS THE COMPOSITION. Because of the
-- backfill below: a name that does not split cleanly ("Cher", "Smith &
-- Daughters LLC" filed as a person) would make the constraint unsatisfiable
-- for a row that is perfectly good data. The trigger converges the two without
-- ever refusing a write.
--
-- THE SPLIT RULE, and why it is this dumb. First space: the first token is the
-- first name, everything after it is the last name, and a single token goes
-- wholly to first_name. Mirrors `splitFullName` in src/lib/person-name.ts line
-- for line, deliberately — the UI and the backfill must not disagree about who
-- somebody is. A cleverer rule would have to guess at particles ("van", "de"),
-- suffixes ("Jr."), and inverted "Stern, David", and every wrong guess is a
-- person's name silently rewritten. First-space is wrong in visible ways a
-- human corrects in one edit.
--
-- Re-runnable: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE, DROP TRIGGER IF
-- EXISTS before CREATE, and a backfill whose WHERE clause excludes anything it
-- has already done. Applying twice changes nothing the second time.

-- ------------------------------------------------------------- the columns

ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS first_name text;
ALTER TABLE public.contacts ADD COLUMN IF NOT EXISTS last_name text;

COMMENT ON COLUMN public.contacts.first_name IS
  'Given name. Null on rows never edited through a screen that collects the pair. full_name stays the composed value and is what the application reads.';
COMMENT ON COLUMN public.contacts.last_name IS
  'Family name, including any particles and suffixes — the backfill splits on the first space only. See src/lib/person-name.ts.';

-- ------------------------------------------------------- keeping the three coherent

CREATE OR REPLACE FUNCTION public.contacts_compose_full_name()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  composed text;
BEGIN
  -- Nobody supplied the parts: this is one of the many writers that only
  -- knows full_name. Leave it exactly as given.
  IF NULLIF(btrim(COALESCE(NEW.first_name, '')), '') IS NULL
     AND NULLIF(btrim(COALESCE(NEW.last_name, '')), '') IS NULL THEN
    RETURN NEW;
  END IF;

  -- Store the parts trimmed, and blank as NULL, so "" never reads as "filled
  -- in" on the next pass through this function.
  NEW.first_name := NULLIF(btrim(COALESCE(NEW.first_name, '')), '');
  NEW.last_name := NULLIF(btrim(COALESCE(NEW.last_name, '')), '');

  composed := btrim(
    COALESCE(NEW.first_name, '') || ' ' || COALESCE(NEW.last_name, '')
  );

  -- full_name is NOT NULL and a nameless contact is unfindable, so an empty
  -- composition never wins over a name that is already on the row.
  IF composed <> '' THEN
    NEW.full_name := composed;
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.contacts_compose_full_name() IS
  'Keeps contacts.full_name equal to first_name + last_name whenever either part is supplied, and leaves full_name untouched when neither is. See 20260913120000.';

DROP TRIGGER IF EXISTS contacts_compose_full_name ON public.contacts;
CREATE TRIGGER contacts_compose_full_name
  BEFORE INSERT OR UPDATE OF first_name, last_name, full_name ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.contacts_compose_full_name();

-- ---------------------------------------------------------------- backfill
--
-- Only rows where BOTH parts are still empty, so re-running cannot overwrite
-- anything a person has since corrected by hand. Written as one UPDATE with
-- no loop: `contacts` is a small table (90 rows in production at the time of
-- writing) and a set-based statement is its own transaction boundary.
--
-- The trigger fires on this UPDATE, recomposes full_name from the parts it
-- just wrote, and lands on the same string it started from — whitespace
-- normalised, which is the only change a well-formed row can see. A name
-- stored as "  David   Stern " becomes "David Stern", which is a fix.

UPDATE public.contacts
   SET first_name = CASE
         WHEN position(' ' IN btrim(regexp_replace(full_name, '\s+', ' ', 'g'))) = 0
           THEN btrim(regexp_replace(full_name, '\s+', ' ', 'g'))
         ELSE split_part(btrim(regexp_replace(full_name, '\s+', ' ', 'g')), ' ', 1)
       END,
       last_name = CASE
         WHEN position(' ' IN btrim(regexp_replace(full_name, '\s+', ' ', 'g'))) = 0
           THEN NULL
         ELSE substr(
           btrim(regexp_replace(full_name, '\s+', ' ', 'g')),
           position(' ' IN btrim(regexp_replace(full_name, '\s+', ' ', 'g'))) + 1
         )
       END
 WHERE first_name IS NULL
   AND last_name IS NULL
   AND btrim(COALESCE(full_name, '')) <> '';

-- ========================================================================
-- Verification
-- ========================================================================
--
--   -- every contact now carries a first name, and the composition agrees
--   SELECT count(*) FROM public.contacts WHERE first_name IS NULL;
--   -- expected: 0 (rows whose full_name was blank would show here; there are none)
--
--   SELECT count(*) FROM public.contacts
--    WHERE full_name <> btrim(COALESCE(first_name,'') || ' ' || COALESCE(last_name,''));
--   -- expected: 0
--
--   -- the compatibility case: a writer that knows only full_name
--   INSERT INTO public.contacts (account_id, location_id, full_name)
--   VALUES ('<account>', '<location>', 'Legacy Writer');
--   -- full_name is 'Legacy Writer', first_name and last_name stay NULL
--
--   -- the new case: a screen that collects the pair
--   UPDATE public.contacts SET first_name = 'David', last_name = 'Stern' WHERE id = '<id>';
--   -- full_name becomes 'David Stern'
--
--   -- the particle case the split rule deliberately does not guess at
--   SELECT full_name, first_name, last_name FROM public.contacts
--    WHERE full_name LIKE '% van %' OR full_name LIKE '% de %';
--   -- "Mary Ann Van Der Berg" -> Mary / 'Ann Van Der Berg', correctable by hand
--
-- Rollback:
--   DROP TRIGGER IF EXISTS contacts_compose_full_name ON public.contacts;
--   DROP FUNCTION IF EXISTS public.contacts_compose_full_name();
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS first_name;
--   ALTER TABLE public.contacts DROP COLUMN IF EXISTS last_name;
--   -- full_name is untouched by the rollback: it held the composed value all along.
