-- 1. Address normalisation ---------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_address_key(_addr text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT nullif(
    btrim(regexp_replace(
      regexp_replace(
        ' ' || lower(regexp_replace(coalesce(_addr, ''), '[^a-zA-Z0-9]+', ' ', 'g')) || ' ',
        '\s(street|str)\s',  ' st ', 'g'
      ),
      '\s+', ' ', 'g'
    )),
    ''
  )
$$;

CREATE OR REPLACE FUNCTION public.normalize_address(_addr text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT nullif(btrim(regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(
                regexp_replace(
                  regexp_replace(
                    regexp_replace(
                      regexp_replace(
                        regexp_replace(
                          regexp_replace(
                            regexp_replace(
                              regexp_replace(
                                ' ' || lower(regexp_replace(coalesce(_addr, ''), '[^a-zA-Z0-9]+', ' ', 'g')) || ' ',
                                '\s(street|str)\s', ' st ', 'g'),
                              '\s(drive)\s', ' dr ', 'g'),
                            '\s(road)\s', ' rd ', 'g'),
                          '\s(avenue|av)\s', ' ave ', 'g'),
                        '\s(boulevard|boul)\s', ' blvd ', 'g'),
                      '\s(lane)\s', ' ln ', 'g'),
                    '\s(court)\s', ' ct ', 'g'),
                  '\s(place)\s', ' pl ', 'g'),
                '\s(terrace)\s', ' ter ', 'g'),
              '\s(parkway)\s', ' pkwy ', 'g'),
            '\s(highway)\s', ' hwy ', 'g'),
          '\s(circle)\s', ' cir ', 'g'),
        '\s(north)\s', ' n ', 'g'),
      '\s(south)\s', ' s ', 'g'),
    '\s+', ' ', 'g')), '')
$$;

DROP FUNCTION IF EXISTS public.normalize_address_key(text);

REVOKE ALL ON FUNCTION public.normalize_address(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.normalize_address(text) TO authenticated, service_role;

-- 2. Unified customer search (people + companies), cross-office minimal ------
CREATE OR REPLACE FUNCTION public.search_customers_minimal(_query text)
RETURNS TABLE(
  kind text,
  id uuid,
  name text,
  title text,
  account_id uuid,
  account_name text,
  account_type text,
  status text,
  owning_location_id uuid,
  owning_location_code text,
  owning_location_name text,
  owner_contact_name text,
  phone text,
  email text,
  viewer_has_full_access boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
  -- People
  SELECT
    'contact'::text,
    c.id,
    c.full_name,
    c.title,
    c.account_id,
    a.name,
    a.account_type::text,
    a.status::text,
    l.id,
    l.code,
    l.name,
    (SELECT p.full_name FROM public.profiles p WHERE p.id = a.assigned_rep),
    c.phone,
    c.email,
    (a.id IS NULL
     OR public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'owner'::app_role)
     OR public.is_member_of(auth.uid(), a.location_id)
     OR public.is_regional_for(auth.uid(), a.location_id)
     OR a.assigned_rep = auth.uid())
  FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  LEFT JOIN public.locations l ON l.id = a.location_id
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

  -- Companies
  SELECT
    'account'::text,
    a.id,
    a.name,
    NULL::text,
    a.id,
    a.name,
    a.account_type::text,
    a.status::text,
    l.id,
    l.code,
    l.name,
    (SELECT p.full_name FROM public.profiles p WHERE p.id = a.assigned_rep),
    a.phone,
    a.email,
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'owner'::app_role)
     OR public.is_member_of(auth.uid(), a.location_id)
     OR public.is_regional_for(auth.uid(), a.location_id)
     OR a.assigned_rep = auth.uid())
  FROM public.accounts a
  JOIN public.locations l ON l.id = a.location_id
  WHERE a.archived_at IS NULL
    AND (
      a.name ILIKE '%' || q || '%'
      OR a.email ILIKE '%' || q || '%'
      OR (digits IS NOT NULL AND regexp_replace(coalesce(a.phone, ''), '[^0-9]', '', 'g') LIKE '%' || digits || '%')
    )
  ORDER BY 3
  LIMIT 40;
END;
$$;

REVOKE ALL ON FUNCTION public.search_customers_minimal(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.search_customers_minimal(text) TO authenticated;

-- 3. Prior jobs at the same property -----------------------------------------
CREATE OR REPLACE FUNCTION public.prior_jobs_at_address(
  _address text,
  _lat double precision DEFAULT NULL,
  _lon double precision DEFAULT NULL,
  _exclude_job uuid DEFAULT NULL
)
RETURNS TABLE(
  job_id uuid,
  job_number text,
  address text,
  loss_type text,
  job_date date,
  customer_kind text,
  customer_name text,
  account_id uuid,
  account_name text,
  primary_contact_id uuid,
  primary_contact_name text,
  owning_location_id uuid,
  owning_location_code text,
  owning_location_name text,
  matched_by text,
  viewer_has_full_access boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  key text := public.normalize_address(_address);
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authentication required';
  END IF;
  IF key IS NULL AND (_lat IS NULL OR _lon IS NULL) THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    j.id,
    j.job_number,
    j.address,
    j.loss_type::text,
    coalesce(j.call_date, j.created_at::date),
    j.customer_kind,
    j.customer_name,
    j.account_id,
    a.name,
    j.primary_contact_id,
    c.full_name,
    l.id,
    l.code,
    l.name,
    CASE WHEN key IS NOT NULL AND public.normalize_address(j.address) = key
         THEN 'address' ELSE 'proximity' END,
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'owner'::app_role)
     OR public.can_view_job(auth.uid(), j.id))
  FROM public.jobs j
  LEFT JOIN public.accounts a ON a.id = j.account_id
  LEFT JOIN public.contacts c ON c.id = j.primary_contact_id
  JOIN public.locations l ON l.id = j.location_id
  WHERE (_exclude_job IS NULL OR j.id <> _exclude_job)
    AND (
      (key IS NOT NULL AND public.normalize_address(j.address) = key)
      OR (
        _lat IS NOT NULL AND _lon IS NOT NULL
        AND j.lat IS NOT NULL AND j.lon IS NOT NULL
        AND ST_DWithin(
              ST_SetSRID(ST_MakePoint(j.lon, j.lat), 4326)::geography,
              ST_SetSRID(ST_MakePoint(_lon, _lat), 4326)::geography,
              75)
      )
    )
  ORDER BY coalesce(j.call_date, j.created_at::date) DESC
  LIMIT 10;
END;
$$;

REVOKE ALL ON FUNCTION public.prior_jobs_at_address(text, double precision, double precision, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.prior_jobs_at_address(text, double precision, double precision, uuid) TO authenticated;

-- 4. Duplicate check before creating a person ---------------------------------
CREATE OR REPLACE FUNCTION public.find_customer_duplicates(
  _name text DEFAULT NULL,
  _phone text DEFAULT NULL,
  _email text DEFAULT NULL,
  _account_id uuid DEFAULT NULL
)
RETURNS TABLE(
  contact_id uuid,
  full_name text,
  title text,
  email text,
  phone text,
  account_id uuid,
  account_name text,
  owning_location_code text,
  owning_location_name text,
  match_reason text,
  viewer_has_full_access boolean
)
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO 'public'
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
  SELECT
    c.id,
    c.full_name,
    c.title,
    c.email,
    c.phone,
    c.account_id,
    a.name,
    l.code,
    l.name,
    CASE
      WHEN ph IS NOT NULL AND (
        regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') = ph
        OR EXISTS (SELECT 1 FROM public.contact_methods cm
                   WHERE cm.contact_id = c.id
                     AND regexp_replace(coalesce(cm.value, ''), '[^0-9]', '', 'g') = ph)
      ) THEN 'phone'
      WHEN em IS NOT NULL AND lower(coalesce(c.email, '')) = em THEN 'email'
      ELSE 'name'
    END,
    (a.id IS NULL
     OR public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'owner'::app_role)
     OR public.is_member_of(auth.uid(), a.location_id)
     OR public.is_regional_for(auth.uid(), a.location_id)
     OR a.assigned_rep = auth.uid())
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
  LIMIT 10;
END;
$$;

REVOKE ALL ON FUNCTION public.find_customer_duplicates(text, text, text, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.find_customer_duplicates(text, text, text, uuid) TO authenticated;