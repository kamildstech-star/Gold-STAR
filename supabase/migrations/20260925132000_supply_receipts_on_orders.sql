-- A receipt can belong to the supply order it paid for.
--
-- David, 22 Sep: "when I place an order... can we have like a thingy here to
-- upload a copy of the receipt? I know we have it under spending, but I want
-- to just connect my receipts for all the items straight to that item. And
-- then also obviously it's going to be tied to spending."
--
-- One receipt system, a second doorway. The row is the same supply_receipts
-- row (20260918180000): the same picture in storage, the same model draft,
-- the same reviewer alert, the same "Confirm" into supply_purchases. The only
-- new fact is which order it is for — and a purchase confirmed from it carries
-- the same order through supply_purchases.request_id, which already exists.

ALTER TABLE public.supply_receipts
  ADD COLUMN IF NOT EXISTS request_id uuid
    REFERENCES public.supply_requests(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS supply_receipts_request_idx
  ON public.supply_receipts (request_id, created_at DESC) WHERE request_id IS NOT NULL;

-- Insert stays open to any staff member uploading their own receipt. What is
-- added is that a receipt may only be pinned to an order the uploader could
-- act on — their own request, or one in an office they manage — and only in
-- that order's office, so a receipt cannot be filed against somebody else's
-- order or carry money into another branch's spending.
DROP POLICY IF EXISTS "supply_receipts_insert" ON public.supply_receipts;
CREATE POLICY "supply_receipts_insert" ON public.supply_receipts FOR INSERT TO authenticated
  WITH CHECK (
    uploaded_by = (SELECT auth.uid())
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
  );

-- SELECT and UPDATE are unchanged: the uploader, finance, or a manager of the
-- office — the same people who could see the receipt under Spending.
