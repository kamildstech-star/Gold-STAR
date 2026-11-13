-- Photographing a receipt, and telling somebody it arrived.
--
-- David, 17 Sep: "if somebody goes into Home Depot and just buys an item off
-- the shelf, they should be able to take a picture of the receipt and upload
-- it to the system. Now, if the system can read the receipt, that'll be great
-- — what supplies were purchased and how many and the date and all that. But
-- if not, at the very minimum it should send an alert to somebody — to be
-- determined — that a receipt was uploaded by so-and-so. That's gonna help us
-- keep track of spending down the line."
--
-- The order of those two sentences is the design. THE ALERT IS THE PRODUCT;
-- the parse is the bonus. So a receipt row exists the moment the picture is
-- stored, whether or not a model could read a word of it, and the alert fires
-- off the row rather than off a successful read.

CREATE TABLE IF NOT EXISTS public.supply_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
  -- Optional: David said "optionally tied to a job". A receipt from the shelf
  -- at Home Depot often belongs to nothing yet.
  job_id uuid REFERENCES public.jobs(id) ON DELETE SET NULL,
  uploaded_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,

  -- The picture. Kept and viewable from the spending entry, always.
  storage_bucket text NOT NULL,
  storage_path text NOT NULL,

  /*
   * What the model made of it, verbatim and untrusted.
   *
   * jsonb rather than columns, because this is a DRAFT for a person to
   * correct, not a record. The moment somebody confirms it, the figures go
   * into supply_purchases, which is the table the Spending report already
   * reads — there is no second place money lives.
   */
  parsed jsonb,
  /** 'uploaded' | 'reviewed' | 'unreadable'. Text, so a state can be added. */
  status text NOT NULL DEFAULT 'uploaded',
  note text,

  reviewed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  reviewed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS supply_receipts_location_idx
  ON public.supply_receipts (location_id, created_at DESC);
CREATE INDEX IF NOT EXISTS supply_receipts_pending_idx
  ON public.supply_receipts (created_at DESC) WHERE status = 'uploaded';

GRANT SELECT, INSERT, UPDATE, DELETE ON public.supply_receipts TO authenticated;
GRANT ALL ON public.supply_receipts TO service_role;
ALTER TABLE public.supply_receipts ENABLE ROW LEVEL SECURITY;

/*
 * ANY staff member can upload one — that is the whole point, a tech standing
 * at a till. So insert is open to an authenticated user for a location they
 * belong to, and they can see their own afterwards.
 *
 * Reading everyone's is the money question, so it follows the same gate the
 * rest of supplies money uses: finance, or a manager of that office.
 */
DROP POLICY IF EXISTS "supply_receipts_insert" ON public.supply_receipts;
CREATE POLICY "supply_receipts_insert" ON public.supply_receipts FOR INSERT TO authenticated
  WITH CHECK (uploaded_by = auth.uid());

DROP POLICY IF EXISTS "supply_receipts_select" ON public.supply_receipts;
CREATE POLICY "supply_receipts_select" ON public.supply_receipts FOR SELECT TO authenticated
  USING (
    uploaded_by = auth.uid()
    OR public.can_view_finance(auth.uid())
    OR public.can_manage_location(auth.uid(), location_id)
  );

DROP POLICY IF EXISTS "supply_receipts_update" ON public.supply_receipts;
CREATE POLICY "supply_receipts_update" ON public.supply_receipts FOR ALL TO authenticated
  USING (public.can_view_finance(auth.uid()) OR public.can_manage_location(auth.uid(), location_id))
  WITH CHECK (
    public.can_view_finance(auth.uid()) OR public.can_manage_location(auth.uid(), location_id)
  );

-- Who gets told -------------------------------------------------------------
-- David: "an alert to somebody — to be determined". So it is a setting, not a
-- hardcoded role: an admin names the person, and until they do the alert goes
-- to the office's managers, which is a sensible answer rather than nobody.
INSERT INTO public.app_settings (key, value)
VALUES ('supply_receipt_reviewer', jsonb_build_object('user_id', NULL))
ON CONFLICT (key) DO NOTHING;
