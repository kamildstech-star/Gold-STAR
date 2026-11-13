-- Qualify outer-row columns inside the correlated subqueries. Without the
-- table qualification PostgreSQL binds location_id/account_id to the inner
-- aliases, reducing those predicates to self-comparisons.

DROP POLICY google_review_links_insert ON public.google_review_links;

CREATE POLICY google_review_links_insert ON public.google_review_links
  FOR INSERT TO authenticated
  WITH CHECK (
    google_review_links.created_by = (SELECT auth.uid())
    AND public.can_view_location((SELECT auth.uid()), google_review_links.location_id)
    AND EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = google_review_links.account_id
        AND a.location_id = google_review_links.location_id
    )
    AND (
      google_review_links.contact_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = google_review_links.contact_id
          AND c.account_id = google_review_links.account_id
      )
    )
  );
