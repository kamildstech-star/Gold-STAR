-- 1. Fix profile lookup (profiles PK is user_id)
CREATE OR REPLACE FUNCTION public.search_customers_minimal(_query text)
 RETURNS TABLE(kind text, id uuid, name text, title text, account_id uuid, account_name text, account_type text, status text, owning_location_id uuid, owning_location_code text, owning_location_name text, owner_contact_name text, phone text, email text, viewer_has_full_access boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  SELECT
    'contact'::text,
    c.id,
    c.full_name,
    c.title,
    c.account_id,
    a.name,
    a.account_type::text,
    a.status::text,
    coalesce(l.id, cl.id),
    coalesce(l.code, cl.code),
    coalesce(l.name, cl.name),
    (SELECT p.full_name FROM public.profiles p WHERE p.user_id = a.assigned_rep),
    c.phone,
    c.email,
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'owner'::app_role)
     OR public.is_member_of(auth.uid(), coalesce(a.location_id, c.location_id))
     OR public.is_regional_for(auth.uid(), coalesce(a.location_id, c.location_id))
     OR a.assigned_rep = auth.uid())
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
    (SELECT p.full_name FROM public.profiles p WHERE p.user_id = a.assigned_rep),
    a.phone,
    a.email,
    (public.has_role(auth.uid(), 'admin'::app_role)
     OR public.has_role(auth.uid(), 'owner'::app_role)
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
  LIMIT 40;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.search_customers_minimal(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_customers_minimal(text) TO authenticated;

-- 2. Contact-scoped child tables must work for contacts with no account
DROP POLICY IF EXISTS contact_methods_select ON public.contact_methods;
DROP POLICY IF EXISTS contact_methods_write ON public.contact_methods;

CREATE POLICY contact_methods_select ON public.contact_methods
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_methods.contact_id
    AND (public.can_view_location(auth.uid(), coalesce(a.location_id, c.location_id))
         OR a.assigned_rep = auth.uid())
));

CREATE POLICY contact_methods_write ON public.contact_methods
FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_methods.contact_id
    AND (public.can_manage_location(auth.uid(), coalesce(a.location_id, c.location_id))
         OR a.assigned_rep = auth.uid())
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_methods.contact_id
    AND (public.can_manage_location(auth.uid(), coalesce(a.location_id, c.location_id))
         OR a.assigned_rep = auth.uid())
));

DROP POLICY IF EXISTS contact_tags_select ON public.contact_tags;
DROP POLICY IF EXISTS contact_tags_write ON public.contact_tags;

CREATE POLICY contact_tags_select ON public.contact_tags
FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_tags.contact_id
    AND (public.can_view_location(auth.uid(), coalesce(a.location_id, c.location_id))
         OR a.assigned_rep = auth.uid())
));

CREATE POLICY contact_tags_write ON public.contact_tags
FOR ALL TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_tags.contact_id
    AND (public.can_manage_location(auth.uid(), coalesce(a.location_id, c.location_id))
         OR a.assigned_rep = auth.uid())
))
WITH CHECK (EXISTS (
  SELECT 1 FROM public.contacts c
  LEFT JOIN public.accounts a ON a.id = c.account_id
  WHERE c.id = contact_tags.contact_id
    AND (public.can_manage_location(auth.uid(), coalesce(a.location_id, c.location_id))
         OR a.assigned_rep = auth.uid())
));