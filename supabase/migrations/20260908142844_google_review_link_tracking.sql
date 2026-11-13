-- Track opens of Google review links without exposing CRM data to anonymous
-- callers. The opaque redirect is resolved by a server route using the service
-- role; anon receives no table or function privilege.

CREATE TABLE public.google_review_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id uuid REFERENCES public.contacts(id) ON DELETE SET NULL,
  location_id uuid NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
  destination_url text NOT NULL CHECK (
    destination_url ~* '^https://(g\.page|google\.com|www\.google\.com|maps\.google\.com|maps\.app\.goo\.gl|search\.google\.com)([:/?#]|$)'
    AND length(destination_url) <= 2048
  ),
  created_by uuid NOT NULL REFERENCES public.profiles(user_id) ON DELETE CASCADE,
  is_active boolean NOT NULL DEFAULT true,
  click_count integer NOT NULL DEFAULT 0 CHECK (click_count >= 0),
  first_clicked_at timestamptz,
  last_clicked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX google_review_links_account_idx
  ON public.google_review_links (account_id, created_at DESC);

GRANT SELECT, INSERT ON public.google_review_links TO authenticated;
GRANT ALL ON public.google_review_links TO service_role;
ALTER TABLE public.google_review_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY google_review_links_select ON public.google_review_links
  FOR SELECT TO authenticated
  USING (
    created_by = (SELECT auth.uid())
    OR public.can_view_location((SELECT auth.uid()), location_id)
  );

CREATE POLICY google_review_links_insert ON public.google_review_links
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = (SELECT auth.uid())
    AND public.can_view_location((SELECT auth.uid()), location_id)
    AND EXISTS (
      SELECT 1 FROM public.accounts a
      WHERE a.id = account_id AND a.location_id = location_id
    )
    AND (
      contact_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.contacts c
        WHERE c.id = contact_id AND c.account_id = account_id
      )
    )
  );

CREATE OR REPLACE FUNCTION public.record_google_review_click(_token uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  destination text;
BEGIN
  UPDATE public.google_review_links
  SET click_count = click_count + 1,
      first_clicked_at = COALESCE(first_clicked_at, now()),
      last_clicked_at = now()
  WHERE token = _token AND is_active
  RETURNING destination_url INTO destination;
  RETURN destination;
END;
$$;

REVOKE ALL ON FUNCTION public.record_google_review_click(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_google_review_click(uuid) TO service_role;
