-- 1. Demo flag on every table the seeder can write to.
DO $$
DECLARE t text;
  targets text[] := ARRAY[
    'account_tags','contact_tags','lead_tags','job_tags','photo_tags',
    'photo_annotations','photo_comments','photo_variants',
    'messages','conversations','conversation_members','message_attachments',
    'message_reactions','message_receipts',
    'document_signatures','document_events','document_templates','document_template_versions',
    'email_logs','email_templates',
    'deal_reassignments','reassignment_batches',
    'chaser_shifts','shift_corrections','time_entry_corrections',
    'lead_events','lead_stage_history',
    'project_checklists','project_checklist_items','project_documents','project_stars','project_labels',
    'job_contact_methods','job_saved_filters',
    'seasonal_sends','offboarding_checklists','offboarding_steps',
    'automation_runs','automation_stage_windows',
    'expense_thresholds','labour_rates','sales_type_assignments','scorecard_weights',
    'notification_preferences'
  ];
BEGIN
  FOREACH t IN ARRAY targets LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_schema='public' AND table_name=t) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false', t);
    END IF;
  END LOOP;
END $$;

-- 2. Derive the demo table list from the presence of the column, ordered
--    children-first so deletes never trip a foreign key.
CREATE OR REPLACE FUNCTION public.demo_tables()
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  depths jsonb := '{}'::jsonb;
  changed boolean;
  pass int := 0;
  r record;
  out_arr text[];
BEGIN
  FOR r IN
    SELECT c.relname AS t
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'is_demo' AND NOT a.attisdropped
    WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    depths := depths || jsonb_build_object(r.t, 0);
  END LOOP;

  LOOP
    pass := pass + 1;
    changed := false;
    FOR r IN
      SELECT DISTINCT ch.relname AS child, pa.relname AS parent
      FROM pg_constraint con
      JOIN pg_class ch ON ch.oid = con.conrelid
      JOIN pg_class pa ON pa.oid = con.confrelid
      JOIN pg_namespace n1 ON n1.oid = ch.relnamespace AND n1.nspname = 'public'
      JOIN pg_namespace n2 ON n2.oid = pa.relnamespace AND n2.nspname = 'public'
      WHERE con.contype = 'f' AND ch.relname <> pa.relname
    LOOP
      IF depths ? r.child AND depths ? r.parent
         AND (depths->>r.child)::int <= (depths->>r.parent)::int THEN
        depths := jsonb_set(depths, ARRAY[r.child],
                            to_jsonb(((depths->>r.parent)::int) + 1));
        changed := true;
      END IF;
    END LOOP;
    EXIT WHEN NOT changed OR pass > 25;
  END LOOP;

  SELECT array_agg(k ORDER BY (depths->>k)::int DESC, k)
  INTO out_arr
  FROM jsonb_object_keys(depths) AS k;

  -- profiles last: purge_demo_data handles it specially.
  RETURN (SELECT array_agg(x ORDER BY ord)
          FROM (
            SELECT x, row_number() OVER () AS ord
            FROM unnest(out_arr) AS x
          ) s
          WHERE true);
END $$;

REVOKE EXECUTE ON FUNCTION public.demo_tables() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.demo_tables() TO authenticated, service_role;