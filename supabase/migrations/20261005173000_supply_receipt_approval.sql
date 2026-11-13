-- A receipt reaches purchase tracking only when somebody else approves it.
--
-- Mark, 5 Oct: "Need area for crews to upload purchase receipts. It should
-- probably be tied to purchasing, AI to read the items and need to get
-- approved just to add to purchase tracking."
--
-- The upload, the AI read and the link to purchasing all existed
-- (20260918180000, 20260925132000). The approval did not. The receipt card's
-- "Confirm" button wrote supply_purchases straight from the browser, with no
-- check of its own, so a manager could photograph their own receipt and
-- confirm their own spend into the books in two taps. Nothing was approved by
-- anybody; it was a save button with a reassuring name.
--
-- And for a crew member it was worse in the other direction: the only update
-- policy on supply_receipts was the finance/manager one, so saving the AI's
-- draft onto a crew member's receipt matched no row and silently did nothing.
-- The receipt sat there with no lines and no Confirm button, forever.
--
-- ============================================================================
-- THE STATES
-- ============================================================================
--
--   uploaded    Stored, the reviewer alerted (David's minimum — "the alert is
--               the product"). The AI's draft, if it read anything, is on the
--               row. Waiting for an approver. Uploading IS submitting: a tech
--               at a till is not going to come back later to press "submit".
--   unreadable  Same as uploaded, except the AI read nothing. Still waiting
--               for an approver, who types the lines from the photograph.
--   approved    An approver who is NOT the uploader confirmed the lines. Those
--               lines — the approver's, not the model's — are in
--               supply_purchases with receipt_id pointing here.
--   rejected    An approver said no, and said why. The uploader sees the
--               reason on their own receipt.
--
-- 'reviewed' is retired rather than kept as a synonym. Every 'reviewed' row
-- was confirmed into supply_purchases, which is exactly what 'approved' means
-- now; two words for one state is how a report ends up counting half of them.
--
-- ============================================================================
-- WHERE THE GATE IS, AND WHY IT IS HERE AND NOT IN THE BROWSER
-- ============================================================================
--
-- 1. supply_receipts loses its direct UPDATE. Every state change goes through
--    one of three SECURITY DEFINER functions below, each of which checks the
--    caller itself. The UPDATE privilege is revoked as well as the policy
--    dropped, so an attempt fails loudly instead of matching zero rows.
--
-- 2. approve_supply_receipt is the ONLY path from a receipt into
--    supply_purchases. A purchase row that names a receipt (receipt_id) cannot
--    be inserted or edited directly by anyone signed in — a RESTRICTIVE policy,
--    so no permissive policy added later can reopen it. Hand-typed purchases
--    (receipt_id NULL) are untouched: the purchaser's own entries are the
--    purchaser's business, as they were.
--
-- 3. Crew still cannot write supply_purchases at all. That was already true
--    (20260918090000: finance or a manager of the office) and is proved again
--    in supabase/tests/supply-receipt-approval.pglite.mjs.
--
-- WHO MAY APPROVE. No new role. The people who may approve a receipt into
-- purchase tracking are exactly the people who may already write purchase
-- tracking: public.can_view_finance (owner, admin, sales_head, dev) or
-- public.can_manage_location for the receipt's office (office,
-- location_manager, sales_manager, a regional covering it, privileged). Those
-- two predicates are the supply_purchases write policy word for word.
--
-- SEPARATION OF DUTIES. The uploader can never approve or reject their own
-- receipt, whatever their role. An office manager who buys tape at Home Depot
-- needs a colleague, finance, or a regional to sign it off — which is the
-- point of an approval.
--
-- NOT APPLIED. Written for review; applied by hand after merge. Until then the
-- app's approve button explains that approval needs this update, rather than
-- falling back to the old ungated write.

-- ---------------------------------------------------------------------------
-- 1. The receipt row
-- ---------------------------------------------------------------------------

ALTER TABLE public.supply_receipts
  -- What the uploader is told when an approver says no. Shown on their receipt.
  ADD COLUMN IF NOT EXISTS rejection_reason text,
  -- What the approver confirmed — supplier, date and the corrected lines — kept
  -- beside the model's own `parsed` so the two can always be compared.
  ADD COLUMN IF NOT EXISTS approved_lines jsonb;

-- reviewed_by / reviewed_at (20260918180000) are reused as "decided by" and
-- "decided at" for both outcomes, rather than adding a second pair.

UPDATE public.supply_receipts SET status = 'approved' WHERE status = 'reviewed';

ALTER TABLE public.supply_receipts DROP CONSTRAINT IF EXISTS supply_receipts_status_known;
ALTER TABLE public.supply_receipts ADD CONSTRAINT supply_receipts_status_known
  CHECK (status IN ('uploaded', 'unreadable', 'approved', 'rejected'));

ALTER TABLE public.supply_receipts DROP CONSTRAINT IF EXISTS supply_receipts_rejection_has_reason;
ALTER TABLE public.supply_receipts ADD CONSTRAINT supply_receipts_rejection_has_reason
  CHECK (status <> 'rejected' OR nullif(btrim(coalesce(rejection_reason, '')), '') IS NOT NULL);

-- The approval queue is "everything not yet decided", which is two statuses now.
DROP INDEX IF EXISTS public.supply_receipts_pending_idx;
CREATE INDEX IF NOT EXISTS supply_receipts_pending_idx
  ON public.supply_receipts (location_id, created_at DESC)
  WHERE status IN ('uploaded', 'unreadable');
CREATE INDEX IF NOT EXISTS supply_receipts_uploader_idx
  ON public.supply_receipts (uploaded_by, created_at DESC);

-- ---------------------------------------------------------------------------
-- 2. The purchase row remembers which receipt it came from
-- ---------------------------------------------------------------------------

-- RESTRICT, not SET NULL: an approved receipt cannot be deleted out from under
-- the spending it justified. The picture stays with the money.
ALTER TABLE public.supply_purchases
  ADD COLUMN IF NOT EXISTS receipt_id uuid
    REFERENCES public.supply_receipts(id) ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS supply_purchases_receipt_idx
  ON public.supply_purchases (receipt_id) WHERE receipt_id IS NOT NULL;

-- Only approve_supply_receipt (SECURITY DEFINER, so not subject to these) may
-- write a row that names a receipt. RESTRICTIVE: AND-ed with the existing
-- supply_purchases_write policy, never OR-ed, so it cannot be widened by
-- accident. Delete is left to the existing policy — removing a line inflates
-- nothing, and finance correcting a mistake is a normal thing to do.
DROP POLICY IF EXISTS "supply_purchases_receipt_lines_insert" ON public.supply_purchases;
CREATE POLICY "supply_purchases_receipt_lines_insert" ON public.supply_purchases
  AS RESTRICTIVE FOR INSERT TO authenticated
  WITH CHECK (receipt_id IS NULL);

DROP POLICY IF EXISTS "supply_purchases_receipt_lines_update" ON public.supply_purchases;
CREATE POLICY "supply_purchases_receipt_lines_update" ON public.supply_purchases
  AS RESTRICTIVE FOR UPDATE TO authenticated
  USING (receipt_id IS NULL)
  WITH CHECK (receipt_id IS NULL);

-- ---------------------------------------------------------------------------
-- 3. Who may approve
-- ---------------------------------------------------------------------------

-- The supply_purchases write predicate, named, so the function and the app ask
-- the same question. SECURITY INVOKER: both helpers it calls are already
-- definer functions granted to authenticated.
CREATE OR REPLACE FUNCTION public.can_approve_supply_receipt(_user_id uuid, _location_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT _user_id IS NOT NULL AND (
    public.can_view_finance(_user_id)
    OR public.can_manage_location(_user_id, _location_id)
  );
$$;

REVOKE ALL ON FUNCTION public.can_approve_supply_receipt(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_approve_supply_receipt(uuid, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Row policies on supply_receipts
-- ---------------------------------------------------------------------------

-- Insert: anybody uploading their own receipt, as before, and only as a fresh
-- undecided row — a receipt cannot be born approved, or with somebody else's
-- name in reviewed_by. The order clause is 20260925132000's, unchanged. The
-- job clause is new: a receipt filed against a job must be in that job's
-- office, for the same reason an order's must — it cannot carry money into
-- another branch's spending.
DROP POLICY IF EXISTS "supply_receipts_insert" ON public.supply_receipts;
CREATE POLICY "supply_receipts_insert" ON public.supply_receipts FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (SELECT auth.uid())
    AND status IN ('uploaded', 'unreadable')
    AND reviewed_by IS NULL
    AND reviewed_at IS NULL
    AND rejection_reason IS NULL
    AND approved_lines IS NULL
    AND (
      request_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.supply_requests r
        WHERE r.id = request_id
          AND r.location_id = supply_receipts.location_id
          AND (
            r.requester_id = (SELECT auth.uid())
            OR public.can_manage_location((SELECT auth.uid()), r.location_id)
          )
      )
    )
    AND (
      job_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.jobs j
        WHERE j.id = job_id AND j.location_id = supply_receipts.location_id
      )
    )
  );

-- SELECT is unchanged (20260918180000): the uploader, finance, or a manager of
-- the office.

-- The old FOR ALL policy is what let any manager set status = 'reviewed' on
-- any receipt, their own included. It goes, and nothing replaces it for
-- UPDATE: the three functions below are the only writers.
DROP POLICY IF EXISTS "supply_receipts_update" ON public.supply_receipts;
REVOKE UPDATE ON public.supply_receipts FROM authenticated;

-- Delete: a receipt that was never approved can be cleared away — by the
-- uploader while it is still waiting (the wrong photo), or by an approver of
-- that office. An approved one stays; the foreign key above enforces it too.
DROP POLICY IF EXISTS "supply_receipts_delete" ON public.supply_receipts;
CREATE POLICY "supply_receipts_delete" ON public.supply_receipts FOR DELETE TO authenticated
  USING (
    status <> 'approved'
    AND (
      (uploaded_by = (SELECT auth.uid()) AND status IN ('uploaded', 'unreadable'))
      OR public.can_approve_supply_receipt((SELECT auth.uid()), location_id)
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Saving the AI's draft
-- ---------------------------------------------------------------------------

-- The uploader's phone does the read, so the uploader has to be able to save
-- it — which, with no UPDATE policy, means a function. It writes only the
-- draft and the uploaded/unreadable flag, and only while undecided: once a
-- receipt is approved or rejected its draft is history.
CREATE OR REPLACE FUNCTION public.save_supply_receipt_draft(_receipt_id uuid, _parsed jsonb)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rec public.supply_receipts%ROWTYPE;
  v_status text;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to save a receipt' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_rec FROM public.supply_receipts WHERE id = _receipt_id FOR UPDATE;
  IF v_rec.id IS NULL THEN
    RAISE EXCEPTION 'That receipt no longer exists' USING ERRCODE = 'P0002';
  END IF;

  IF v_rec.uploaded_by IS DISTINCT FROM v_uid
     AND NOT public.can_approve_supply_receipt(v_uid, v_rec.location_id) THEN
    RAISE EXCEPTION 'Only the person who uploaded this receipt or an approver can change it'
      USING ERRCODE = '42501';
  END IF;

  IF v_rec.status NOT IN ('uploaded', 'unreadable') THEN
    RAISE EXCEPTION 'This receipt has already been %', v_rec.status USING ERRCODE = '55000';
  END IF;

  IF _parsed IS NOT NULL AND jsonb_typeof(_parsed) <> 'object' THEN
    RAISE EXCEPTION 'A receipt draft must be an object' USING ERRCODE = '22023';
  END IF;
  -- The model's reply is untrusted and the client caps it at 60 lines; this is
  -- the backstop against somebody posting a novel into the column.
  IF _parsed IS NOT NULL AND pg_column_size(_parsed) > 65536 THEN
    RAISE EXCEPTION 'That receipt draft is too large' USING ERRCODE = '22023';
  END IF;

  v_status := CASE WHEN _parsed IS NULL THEN 'unreadable' ELSE 'uploaded' END;
  UPDATE public.supply_receipts SET parsed = _parsed, status = v_status WHERE id = _receipt_id;
  RETURN v_status;
END
$$;

REVOKE ALL ON FUNCTION public.save_supply_receipt_draft(uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_supply_receipt_draft(uuid, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. Approve: the one door into purchase tracking
-- ---------------------------------------------------------------------------

-- `_lines` is what the APPROVER confirmed — corrected quantities, prices,
-- relabelled or added lines — not the model's draft. Each line:
--   {"label": text, "quantity": number > 0, "unit_price": number >= 0,
--    "total": number >= 0 | null}
-- A null total is quantity × unit price, the same default recordPurchase uses.
--
-- One transaction: every line lands, the receipt flips to approved and the
-- uploader is told, or none of it happens. FOR UPDATE on the receipt row means
-- two approvers pressing the button at once produce one set of lines, not two.
CREATE OR REPLACE FUNCTION public.approve_supply_receipt(
  _receipt_id uuid,
  _supplier text,
  _purchased_on date,
  _lines jsonb
) RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rec public.supply_receipts%ROWTYPE;
  v_supplier text := nullif(btrim(coalesce(_supplier, '')), '');
  v_line jsonb;
  v_label text;
  v_qty numeric;
  v_price numeric;
  v_total numeric;
  v_clean jsonb := '[]'::jsonb;
  v_sum numeric := 0;
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to approve a receipt' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_rec FROM public.supply_receipts WHERE id = _receipt_id FOR UPDATE;
  IF v_rec.id IS NULL THEN
    RAISE EXCEPTION 'That receipt no longer exists' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.can_approve_supply_receipt(v_uid, v_rec.location_id) THEN
    RAISE EXCEPTION 'Only finance or a manager of this office can approve receipts'
      USING ERRCODE = '42501';
  END IF;

  -- The whole point. Checked after authority so a crew member is told the
  -- general rule rather than this one.
  IF v_rec.uploaded_by = v_uid THEN
    RAISE EXCEPTION 'You uploaded this receipt, so somebody else has to approve it'
      USING ERRCODE = '42501';
  END IF;

  IF v_rec.status NOT IN ('uploaded', 'unreadable') THEN
    RAISE EXCEPTION 'This receipt has already been %', v_rec.status USING ERRCODE = '55000';
  END IF;

  IF v_supplier IS NULL THEN
    RAISE EXCEPTION 'Say which supplier this receipt is from' USING ERRCODE = '22023';
  END IF;
  IF _purchased_on IS NULL THEN
    RAISE EXCEPTION 'Say what day this was bought' USING ERRCODE = '22023';
  END IF;
  -- A typo'd year is the likely mistake on a date typed from a till slip.
  IF _purchased_on > current_date + 1 OR _purchased_on < current_date - 730 THEN
    RAISE EXCEPTION 'The purchase date % does not look right', _purchased_on USING ERRCODE = '22023';
  END IF;

  IF _lines IS NULL OR jsonb_typeof(_lines) <> 'array' OR jsonb_array_length(_lines) = 0 THEN
    RAISE EXCEPTION 'A receipt needs at least one line to approve' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(_lines) > 60 THEN
    RAISE EXCEPTION 'A receipt can carry at most 60 lines' USING ERRCODE = '22023';
  END IF;

  FOR v_line IN SELECT value FROM jsonb_array_elements(_lines) LOOP
    v_label := nullif(btrim(coalesce(v_line->>'label', '')), '');
    IF v_label IS NULL THEN
      RAISE EXCEPTION 'Every line needs a description' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_line->'quantity') IS DISTINCT FROM 'number'
       OR jsonb_typeof(v_line->'unit_price') IS DISTINCT FROM 'number' THEN
      RAISE EXCEPTION 'Line "%" needs a quantity and a unit price', v_label USING ERRCODE = '22023';
    END IF;
    v_qty := round((v_line->>'quantity')::numeric, 2);
    v_price := round((v_line->>'unit_price')::numeric, 2);
    IF v_qty <= 0 OR v_price < 0 THEN
      RAISE EXCEPTION 'Line "%" has a quantity or price that is not possible', v_label
        USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_line->'total') = 'number' THEN
      v_total := round((v_line->>'total')::numeric, 2);
      IF v_total < 0 THEN
        RAISE EXCEPTION 'Line "%" has a negative total', v_label USING ERRCODE = '22023';
      END IF;
    ELSE
      v_total := round(v_qty * v_price, 2);
    END IF;

    INSERT INTO public.supply_purchases (
      location_id, item_id, item_label, supplier_name, quantity, unit_price,
      total_cost, purchased_on, request_id, note, created_by, receipt_id
    ) VALUES (
      v_rec.location_id, NULL, left(v_label, 200), left(v_supplier, 200), v_qty, v_price,
      v_total, _purchased_on, v_rec.request_id, 'From an approved receipt', v_uid, v_rec.id
    );

    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'label', left(v_label, 200), 'quantity', v_qty, 'unit_price', v_price, 'total', v_total));
    v_sum := v_sum + v_total;
    v_count := v_count + 1;
  END LOOP;

  UPDATE public.supply_receipts
     SET status = 'approved',
         reviewed_by = v_uid,
         reviewed_at = now(),
         rejection_reason = NULL,
         approved_lines = jsonb_build_object(
           'supplier', left(v_supplier, 200),
           'purchased_on', _purchased_on,
           'total', v_sum,
           'lines', v_clean)
   WHERE id = v_rec.id;

  -- Told in the same transaction, the way approve_account_lead tells a rep.
  -- 'supply_status' rather than a new enum value: a value added in a migration
  -- cannot be used in the transaction that adds it.
  IF v_rec.uploaded_by IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href)
    VALUES (
      v_rec.uploaded_by, 'supply_status'::public.notification_type, 'Receipt approved',
      format('Your %s receipt (%s) was approved and added to purchase tracking.',
             left(v_supplier, 80), '$' || to_char(v_sum, 'FM999,999,990.00')),
      'supply_receipt', v_rec.id, '/receipts');
  END IF;

  RETURN v_count;
END
$$;

REVOKE ALL ON FUNCTION public.approve_supply_receipt(uuid, text, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.approve_supply_receipt(uuid, text, date, jsonb) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Reject, with a reason the uploader can read
-- ---------------------------------------------------------------------------

-- Same authority and the same separation as approving: a decision about a
-- receipt is never the uploader's. (An uploader who sent the wrong photo can
-- delete it while it is waiting — see supply_receipts_delete.)
CREATE OR REPLACE FUNCTION public.reject_supply_receipt(_receipt_id uuid, _reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_rec public.supply_receipts%ROWTYPE;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Sign in to reject a receipt' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_rec FROM public.supply_receipts WHERE id = _receipt_id FOR UPDATE;
  IF v_rec.id IS NULL THEN
    RAISE EXCEPTION 'That receipt no longer exists' USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.can_approve_supply_receipt(v_uid, v_rec.location_id) THEN
    RAISE EXCEPTION 'Only finance or a manager of this office can reject receipts'
      USING ERRCODE = '42501';
  END IF;
  IF v_rec.uploaded_by = v_uid THEN
    RAISE EXCEPTION 'You uploaded this receipt, so somebody else has to decide on it'
      USING ERRCODE = '42501';
  END IF;
  IF v_rec.status NOT IN ('uploaded', 'unreadable') THEN
    RAISE EXCEPTION 'This receipt has already been %', v_rec.status USING ERRCODE = '55000';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'Say why, so the person who uploaded it knows what to fix'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.supply_receipts
     SET status = 'rejected',
         reviewed_by = v_uid,
         reviewed_at = now(),
         rejection_reason = left(v_reason, 500)
   WHERE id = v_rec.id;

  IF v_rec.uploaded_by IS NOT NULL THEN
    INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href)
    VALUES (
      v_rec.uploaded_by, 'supply_status'::public.notification_type, 'Receipt not approved',
      'Your receipt was not approved: ' || left(v_reason, 500),
      'supply_receipt', v_rec.id, '/receipts');
  END IF;
END
$$;

REVOKE ALL ON FUNCTION public.reject_supply_receipt(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reject_supply_receipt(uuid, text) TO authenticated, service_role;
