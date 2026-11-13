-- Who does what inside a customer company, and who is above them.
--
-- Gold Star's customers are property-management companies, and the shape the
-- client drew is two trees, not one: people (Owner/CEO -> Regional -> Building
-- Super, with Billing off to the side) and assets (the company owns buildings,
-- a Regional covers several, a Super runs one). This migration builds the
-- people tree; 20260903090500 builds the asset side on top of it.
--
-- Today `contacts` is a flat list per account, so "who runs 12 Maple Avenue,
-- and who do I call when they don't pick up at 2am" lives in a rep's head.

-- ---------------------------------------------------------------------------
-- 1. Positions -- a managed list, not an enum
--
-- The client will invent positions we have not thought of (Maintenance
-- Director, Compliance, Ownership Group). Every other classification in this
-- app went the same way in 20260805193344, so this one is an option list from
-- the start and admin extends it without a deploy.
-- ---------------------------------------------------------------------------

-- WHERE NOT EXISTS rather than ON CONFLICT (since 2026-09-03): production has
-- no unique constraint on option_list_values (list_id, key), so ON CONFLICT DO
-- NOTHING would never fire and a second run would insert nine duplicate
-- positions. The same guard is used on option_lists for symmetry.
INSERT INTO public.option_lists (key, label, description)
SELECT 'contact_position',
       'Company position',
       'Where a contact sits in their own company''s hierarchy.'
WHERE NOT EXISTS (SELECT 1 FROM public.option_lists WHERE key = 'contact_position');

INSERT INTO public.option_list_values (list_id, key, label, sort_order, active)
SELECT l.id, v.key, v.label, v.sort_order, true
FROM public.option_lists l,
  (VALUES
    ('owner_ceo', 'Owner / CEO', 10),
    ('executive', 'Executive', 20),
    ('regional', 'Regional manager', 30),
    ('asset_manager', 'Asset manager', 40),
    ('building_super', 'Building super / manager', 50),
    ('maintenance', 'Maintenance', 60),
    ('billing', 'Billing / accounts payable', 70),
    ('admin_assistant', 'Office / admin', 80),
    ('other', 'Other', 200)
  ) AS v(key, label, sort_order)
WHERE l.key = 'contact_position'
  AND NOT EXISTS (
    SELECT 1 FROM public.option_list_values x
    WHERE x.list_id = l.id AND x.key = v.key
  );

-- ---------------------------------------------------------------------------
-- 2. The two new columns on contacts
--
-- `position_key` stores the option's KEY, matching contacts.decision_role and
-- job_contacts.role on the tables next to it -- not an FK to
-- option_list_values.id the way accounts.lead_source_id does. Deleting an
-- option must not quietly blank out who somebody is: with a key the label
-- degrades to the raw key and the org chart still says "regional".
--
-- `title` is deliberately kept. It is the free text on their business card
-- ("Senior Regional Property Manager, Northeast Portfolio"), it arrives from
-- imports (contacts.external_source), and it is already printed in the contact
-- cards and the prospect record. `position_key` answers a different question:
-- which box of Gold Star's chart this person occupies. One is what they call
-- themselves, the other is what we escalate through, and collapsing them would
-- destroy imported data to gain nothing.
-- ---------------------------------------------------------------------------

ALTER TABLE public.contacts
  ADD COLUMN IF NOT EXISTS position_key text,
  -- SET NULL, never CASCADE: deleting a regional manager must not delete the
  -- supers under them. Their reports become roots of the chart, which reads on
  -- screen as "no manager on file" -- true, and visibly fixable.
  ADD COLUMN IF NOT EXISTS reports_to_contact_id uuid
    REFERENCES public.contacts(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.contacts.position_key IS
  'Key from the contact_position option list -- the structural slot inside their company. Complements title, which is their own free-text job title.';
COMMENT ON COLUMN public.contacts.reports_to_contact_id IS
  'Manager within the SAME account. Null is normal and means top of the chart. Cycles are refused by guard_contact_reports_to().';

CREATE INDEX IF NOT EXISTS contacts_account_position_idx
  ON public.contacts (account_id, position_key) WHERE position_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS contacts_reports_to_idx
  ON public.contacts (reports_to_contact_id) WHERE reports_to_contact_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 3. Cycles are refused by the database, not by the form
--
-- A UI check only covers the picker in front of you. Two people editing at
-- once, an import, the assistant's write tools and a hand-run UPDATE all reach
-- this column, and a cycle here is not a cosmetic bug: every consumer of the
-- chart walks the chain upward, so A->B->A is an infinite loop in the escalation
-- path at the exact moment somebody needs it.
--
-- SECURITY DEFINER because the walk crosses rows the caller may not be able to
-- SELECT (a manager scoped to another office); refusing to see them would let
-- a cycle through. EXECUTE is revoked -- only the trigger calls it.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_contact_reports_to()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  walker uuid;
  hops integer := 0;
  manager_account uuid;
  manager_exists boolean;
BEGIN
  IF NEW.reports_to_contact_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.reports_to_contact_id = NEW.id THEN
    RAISE EXCEPTION 'A contact cannot report to themselves.'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT true, c.account_id INTO manager_exists, manager_account
  FROM public.contacts c WHERE c.id = NEW.reports_to_contact_id;

  IF manager_exists IS NOT TRUE THEN
    RAISE EXCEPTION 'That manager contact does not exist.'
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- A reporting line that leaves the company is not a reporting line. It would
  -- also put a stranger at the top of the escalation path for a building.
  IF NEW.account_id IS NULL OR manager_account IS DISTINCT FROM NEW.account_id THEN
    RAISE EXCEPTION 'A contact can only report to someone at the same company.'
      USING ERRCODE = 'check_violation';
  END IF;

  walker := NEW.reports_to_contact_id;
  WHILE walker IS NOT NULL LOOP
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'That reporting line loops back on itself.'
        USING ERRCODE = 'check_violation';
    END IF;
    hops := hops + 1;
    -- Belt and braces. If a cycle ever gets in by some path this trigger does
    -- not sit on, the next write is refused rather than hanging the connection.
    IF hops > 64 THEN
      RAISE EXCEPTION 'That reporting line is too deep, or already contains a loop.'
        USING ERRCODE = 'check_violation';
    END IF;
    SELECT c.reports_to_contact_id INTO walker
    FROM public.contacts c WHERE c.id = walker;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.guard_contact_reports_to() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS guard_contact_reports_to ON public.contacts;
CREATE TRIGGER guard_contact_reports_to
BEFORE INSERT OR UPDATE ON public.contacts
FOR EACH ROW WHEN (NEW.reports_to_contact_id IS NOT NULL)
EXECUTE FUNCTION public.guard_contact_reports_to();

-- Moving a contact to a different company leaves everyone who reported to them
-- pointing across a company boundary -- the one thing the BEFORE trigger cannot
-- fix, because it only sees the row being written. Cut those lines instead of
-- leaving the chart claiming a stranger is somebody's boss.
CREATE OR REPLACE FUNCTION public.detach_contact_reports_on_move()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.contacts
  SET reports_to_contact_id = NULL
  WHERE reports_to_contact_id = NEW.id
    AND account_id IS DISTINCT FROM NEW.account_id;
  RETURN NULL;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.detach_contact_reports_on_move() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS detach_contact_reports_on_move ON public.contacts;
CREATE TRIGGER detach_contact_reports_on_move
AFTER UPDATE OF account_id ON public.contacts
FOR EACH ROW WHEN (OLD.account_id IS DISTINCT FROM NEW.account_id)
EXECUTE FUNCTION public.detach_contact_reports_on_move();

-- ---------------------------------------------------------------------------
-- 4. Best-effort backfill from the free-text title
--
-- Only unambiguous matches, most specific first, and never overwriting a value
-- somebody set. A wrong position is worse than a blank one: blank prompts an
-- edit, wrong sends the 2am call to the wrong person. Anything unmatched stays
-- null and shows as "position not set".
-- ---------------------------------------------------------------------------

UPDATE public.contacts SET position_key = 'billing'
WHERE position_key IS NULL
  AND title ~* '(billing|accounts payable|\ma/?p\M|bookkeep|accounting|controller)';

UPDATE public.contacts SET position_key = 'building_super'
WHERE position_key IS NULL
  AND title ~* '(superintendent|\msuper\M|building manager|site manager|resident manager)';

UPDATE public.contacts SET position_key = 'asset_manager'
WHERE position_key IS NULL
  AND title ~* 'asset';

UPDATE public.contacts SET position_key = 'regional'
WHERE position_key IS NULL
  AND (title ~* '(regional|district|portfolio manager)' OR decision_role = 'regional_manager');

UPDATE public.contacts SET position_key = 'owner_ceo'
WHERE position_key IS NULL
  AND title ~* '(\mowner\M|\mceo\M|chief executive|\mpresident\M|\mprincipal\M|managing (member|partner))';

UPDATE public.contacts SET position_key = 'maintenance'
WHERE position_key IS NULL
  AND title ~* '(maintenance|facilit)';

-- No RLS change. `contacts` is protected by row-level policies only
-- (contacts_select / contacts_write from 20260810174328, plus
-- contacts_select_reference as rewritten in 20260823090000) over a table-wide
-- GRANT SELECT, INSERT, UPDATE, DELETE ... TO authenticated -- there are no
-- column privileges on this table, so these two columns are readable and
-- writable by exactly the people who can already read and write the row.
