DROP VIEW IF EXISTS public.account_fire_rollup;

CREATE VIEW public.account_fire_rollup AS
 SELECT a.id AS account_id,
    a.name,
    a.status,
    a.stage,
    a.stage_id,
    a.pipeline_id,
    a.priority,
    a.estimated_annual_value,
    a.account_type,
    a.location_id,
    a.assigned_rep,
    a.notes,
    a.updated_at,
    COALESCE(l.lead_count, 0::bigint) AS lead_count,
    COALESCE(l.open_count, 0::bigint) AS open_count,
    l.last_loss_date,
    COALESCE(l.units_vacated, 0::bigint) AS units_vacated,
    l.mailing_address,
    c.primary_contact_id,
    c.primary_contact_name,
    c.primary_contact_email,
    c.primary_contact_phone,
    t.last_touch_at,
    t.last_in_person_at,
    COALESCE(t.touch_count, 0::bigint) AS touch_count,
    a.approval_state,
    a.approval_due_on
   FROM accounts a
     LEFT JOIN LATERAL ( SELECT count(*) AS lead_count,
            count(*) FILTER (WHERE fl.status = 'open'::lead_status AND fl.rescind_date IS NULL) AS open_count,
            max(fl.incident_date) AS last_loss_date,
            COALESCE(sum(fl.units_vacated), 0::bigint) AS units_vacated,
            (array_remove(array_agg(fl.owner_mailing_address ORDER BY fl.incident_date DESC NULLS LAST), NULL::text))[1] AS mailing_address
           FROM fire_leads fl
          WHERE fl.account_id = a.id) l ON true
     LEFT JOIN LATERAL ( SELECT ct.id AS primary_contact_id,
            ct.full_name AS primary_contact_name,
            ct.email AS primary_contact_email,
            ct.phone AS primary_contact_phone
           FROM contacts ct
          WHERE ct.account_id = a.id
          ORDER BY ct.is_primary DESC, ct.created_at
         LIMIT 1) c ON true
     LEFT JOIN LATERAL ( SELECT max(tp.occurred_at) AS last_touch_at,
            max(tp.occurred_at) FILTER (
              WHERE tp.type = 'meeting_in_person'::touchpoint_type
                AND tp.counts_toward_cadence
            ) AS last_in_person_at,
            count(*) AS touch_count
           FROM touchpoints tp
          WHERE tp.account_id = a.id) t ON true;

ALTER VIEW public.account_fire_rollup SET (security_invoker = true);
GRANT SELECT ON public.account_fire_rollup TO authenticated;
GRANT ALL ON public.account_fire_rollup TO service_role;

COMMENT ON VIEW public.account_fire_rollup IS
  'Per-account fire-lead rollup with contact and touch provenance. last_in_person_at counts only meetings that count toward cadence, so a cancelled calendar meeting does not satisfy the annual visit (20260914140000); last_touch_at is deliberately unfiltered and answers "did anyone contact this account at all".';