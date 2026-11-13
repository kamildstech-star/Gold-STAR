ALTER TABLE public.supply_receipts
  ADD COLUMN IF NOT EXISTS request_id uuid
    REFERENCES public.supply_requests(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS supply_receipts_request_idx
  ON public.supply_receipts (request_id, created_at DESC) WHERE request_id IS NOT NULL;
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