-- Stop handing out a contact's email and phone across offices.
--
-- Found while checking whether contacts are office-scoped. The RLS policy on
-- public.contacts is narrow -- you see a contact only if you are privileged, a
-- member of its office, regional over it, or the assigned rep. Two
-- SECURITY DEFINER functions walked straight around it:
--
--   find_customer_duplicates(name, phone, email, account_id)
--   search_customers_minimal(query)
--
-- Both are granted to `authenticated`, both check only that somebody is signed
-- in, and both return full_name, title, EMAIL and PHONE for contacts in every
-- office. Each already computes a `viewer_has_full_access` boolean saying the
-- caller cannot see this record -- and then returns the details anyway, leaving
-- the UI to hide them. That is not a boundary. It is a suggestion, sent over
-- the wire to a browser.
--
-- Concretely: knowing one contact's phone number returned their name, job
-- title, company, our owning office AND their email address, for a person the
-- caller has no right to see. Search by email and you got the phone instead.
--
-- These functions exist for a real reason: duplicate detection has to see
-- across offices, or two reps create the same contact twice and neither knows.
-- That purpose needs to know a match EXISTS and roughly where. It does not need
-- the contact details. So the row still comes back -- the duplicate warning
-- still works, and still names the company and office so a rep can go and ask
-- -- but email and phone are null unless the caller could already read them.
--
-- No signature change: same columns, same order, same types, so nothing
-- calling these needs to be redeployed in step.

-- Parameter defaults preserved exactly; CREATE OR REPLACE refuses to drop them,
-- and every caller relies on being able to omit arguments.
CREATE OR REPLACE FUNCTION public.find_customer_duplicates(
  _name text DEFAULT NULL::text,
  _phone text DEFAULT NULL::text,
  _email text DEFAULT NULL::text,
  _account_id uuid DEFAULT NULL::uuid
)
RETURNS TABLE(
  contact_id uuid, full_name text, title text, email text, phone text,
  account_id uuid, account_name text,
  owning_location_code text, owning_location_name text,
  match_reason text, viewer_has_full_access boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  nm text := nullif(btrim(coalesce(_name, '')), '');
  em text := nullif(btrim(lower(coalesce(_email, ''))), '');
  ph text := nullif(regexp_replace(coalesce(_phone, ''), '[^0-9]', '', 'g'), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF ph IS NOT NULL AND length(ph) < 7 THEN
    ph := NULL;
  END IF;
  IF nm IS NULL AND em IS NULL AND ph IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  WITH hit AS (
    SELECT
      c.id AS contact_id, c.full_name, c.title, c.email, c.phone,
      c.account_id, a.name AS account_name,
      l.code AS owning_location_code, l.name AS owning_location_name,
      CASE
        WHEN ph IS NOT NULL AND (
          regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = ph
          OR EXISTS (SELECT 1 FROM public.contact_methods cm
                     WHERE cm.contact_id = c.id
                       AND regexp_replace(coalesce(cm.value, ''), '[^0-9]', '', 'g') = ph)
        ) THEN 'phone'
        WHEN em IS NOT NULL AND lower(coalesce(c.email, '')) = em THEN 'email'
        ELSE 'name'
      END AS match_reason,
      (a.id IS NULL
       OR public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'owner'::public.app_role)
       OR public.is_member_of(auth.uid(), a.location_id)
       OR public.is_regional_for(auth.uid(), a.location_id)
       OR a.assigned_rep = auth.uid()) AS full_access
    FROM public.contacts c
    LEFT JOIN public.accounts a ON a.id = c.account_id
    LEFT JOIN public.locations l ON l.id = a.location_id
    WHERE c.archived_at IS NULL
      AND (
        (ph IS NOT NULL AND (
           regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = ph
           OR EXISTS (SELECT 1 FROM public.contact_methods cm2
                      WHERE cm2.contact_id = c.id
                        AND regexp_replace(coalesce(cm2.value, ''), '[^0-9]', '', 'g') = ph)))
        OR (em IS NOT NULL AND lower(coalesce(c.email, '')) = em)
        OR (nm IS NOT NULL AND _account_id IS NOT NULL
            AND c.account_id = _account_id
            AND lower(c.full_name) = lower(nm))
      )
    LIMIT 10
  )
  SELECT
    hit.contact_id, hit.full_name, hit.title,
    -- The whole point. Name, company and office are enough to say "this person
    -- already exists, go and ask that office"; the details are not.
    CASE WHEN hit.full_access THEN hit.email ELSE NULL END,
    CASE WHEN hit.full_access THEN hit.phone ELSE NULL END,
    hit.account_id, hit.account_name,
    hit.owning_location_code, hit.owning_location_name,
    hit.match_reason, hit.full_access
  FROM hit;
END;
$$;

REVOKE ALL ON FUNCTION public.find_customer_duplicates(text, text, text, uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.find_customer_duplicates(text, text, text, uuid) TO authenticated, service_role;

-- The same leak, wider. search_customers_minimal does a SUBSTRING match on
-- name, email and phone, so it is not "you must already know the number" --
-- a two character query enumerates contacts and accounts across every office,
-- and returned each one's phone and email. That is the one that matters.
--
-- Same treatment, same reasoning: the row still comes back so the search is
-- still useful and still names the office, but the details are withheld from
-- somebody who could not have read that record directly.

CREATE OR REPLACE FUNCTION public.search_customers_minimal(_query text)
RETURNS TABLE(
  kind text, id uuid, name text, title text, account_id uuid, account_name text,
  account_type text, status text, owning_location_id uuid,
  owning_location_code text, owning_location_name text, owner_contact_name text,
  phone text, email text, viewer_has_full_access boolean
)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  q text := btrim(coalesce(_query, ''));
  digits text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF length(q) < 2 THEN
    RETURN;
  END IF;
  digits := nullif(regexp_replace(q, '[^0-9]', '', 'g'), '');
  IF digits IS NOT NULL AND length(digits) < 4 THEN
    digits := NULL;
  END IF;

  RETURN QUERY
  WITH hits AS (
    SELECT
      'contact'::text AS kind, c.id, c.full_name AS name, c.title,
      c.account_id, a.name AS account_name, a.account_type::text AS account_type,
      a.status::text AS status,
      coalesce(l.id, cl.id) AS owning_location_id,
      coalesce(l.code, cl.code) AS owning_location_code,
      coalesce(l.name, cl.name) AS owning_location_name,
      (SELECT p.full_name FROM public.profiles p WHERE p.user_id = a.assigned_rep)
        AS owner_contact_name,
      c.phone, c.email,
      (public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'owner'::public.app_role)
       OR public.is_member_of(auth.uid(), coalesce(a.location_id, c.location_id))
       OR public.is_regional_for(auth.uid(), coalesce(a.location_id, c.location_id))
       OR a.assigned_rep = auth.uid()) AS full_access
    FROM public.contacts c
    LEFT JOIN public.accounts a ON a.id = c.account_id
    LEFT JOIN public.locations l ON l.id = a.location_id
    LEFT JOIN public.locations cl ON cl.id = c.location_id
    WHERE c.archived_at IS NULL
      AND (
        c.full_name ILIKE '%' || q || '%'
        OR c.email ILIKE '%' || q || '%'
        OR (digits IS NOT NULL AND regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') LIKE '%' || digits || '%')
        OR (digits IS NOT NULL AND EXISTS (
              SELECT 1 FROM public.contact_methods cm
              WHERE cm.contact_id = c.id
                AND regexp_replace(coalesce(cm.value, ''), '[^0-9]', '', 'g') LIKE '%' || digits || '%'))
        OR EXISTS (
              SELECT 1 FROM public.contact_methods cm2
              WHERE cm2.contact_id = c.id AND cm2.value ILIKE '%' || q || '%')
      )

    UNION ALL

    SELECT
      'account'::text, a.id, a.name, NULL::text,
      a.id, a.name, a.account_type::text, a.status::text,
      l.id, l.code, l.name,
      (SELECT p.full_name FROM public.profiles p WHERE p.user_id = a.assigned_rep),
      a.phone, a.email,
      (public.has_role(auth.uid(), 'admin'::public.app_role)
       OR public.has_role(auth.uid(), 'owner'::public.app_role)
       OR public.is_member_of(auth.uid(), a.location_id)
       OR public.is_regional_for(auth.uid(), a.location_id)
       OR a.assigned_rep = auth.uid())
    FROM public.accounts a
    LEFT JOIN public.locations l ON l.id = a.location_id
    WHERE a.archived_at IS NULL
      AND (
        a.name ILIKE '%' || q || '%'
        OR a.email ILIKE '%' || q || '%'
        OR (digits IS NOT NULL AND regexp_replace(coalesce(a.phone, ''), '[^0-9]', '', 'g') LIKE '%' || digits || '%')
      )
    LIMIT 40
  )
  SELECT
    hits.kind, hits.id, hits.name, hits.title, hits.account_id, hits.account_name,
    hits.account_type, hits.status, hits.owning_location_id,
    hits.owning_location_code, hits.owning_location_name, hits.owner_contact_name,
    CASE WHEN hits.full_access THEN hits.phone ELSE NULL END,
    CASE WHEN hits.full_access THEN hits.email ELSE NULL END,
    hits.full_access
  FROM hits;
END;
$$;

REVOKE ALL ON FUNCTION public.search_customers_minimal(text) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.search_customers_minimal(text) TO authenticated, service_role;
