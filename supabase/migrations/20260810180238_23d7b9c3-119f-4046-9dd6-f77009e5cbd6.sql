-- ============================================================
-- 1. The old "job_type" list holds service categories -> becomes loss_type
-- ============================================================
UPDATE public.option_lists
SET key = 'loss_type',
    label = 'Loss type',
    description = 'Service category — what work the job is.'
WHERE key = 'job_type';

-- snake_case keys + colour metadata
WITH m(old_key, new_key, colour, ord) AS (
  VALUES
    ('Emergency Services','emergency_services','emergency',10),
    ('Water Mitigation','water_mitigation','water',20),
    ('Fire & Smoke Cleaning','fire_smoke_cleaning','fire',30),
    ('Sewer / Category 3','sewer_cat3','sewer',40),
    ('Mold Remediation','mold_remediation','mold',50),
    ('Biohazard / Trauma','biohazard_trauma','biohazard',60),
    ('Contents / Pack-Out','contents_packout','contents',70),
    ('Board-Up / Tarp','board_up_tarp','boardup',80),
    ('Reconstruction','reconstruction','reconstruction',90),
    ('General Cleaning','general_cleaning','cleaning',100),
    ('Asbestos / Lead','asbestos_lead','asbestos',110)
)
UPDATE public.option_list_values v
SET key = m.new_key,
    sort_order = m.ord,
    metadata = coalesce(v.metadata, '{}'::jsonb) || jsonb_build_object('color', m.colour)
FROM m, public.option_lists ol
WHERE ol.id = v.list_id AND ol.key = 'loss_type' AND v.key = m.old_key;

-- ============================================================
-- 2. New job_type list = payment type
-- ============================================================
INSERT INTO public.option_lists (key, label, description, allow_location_scope)
VALUES ('job_type', 'Job type', 'How the work is paid for — cash, insurance, and anything added later.', false)
ON CONFLICT (key) DO NOTHING;

INSERT INTO public.option_list_values (list_id, key, label, sort_order, active, is_default, metadata)
SELECT ol.id, x.k, x.l, x.o, true, x.d, jsonb_build_object('color', x.c)
FROM public.option_lists ol,
     (VALUES ('insurance','Insurance',10,true,'info'),
             ('cash','Cash',20,false,'success')) AS x(k,l,o,d,c)
WHERE ol.key = 'job_type'
ON CONFLICT DO NOTHING;

-- ============================================================
-- 3. Data-driven loss type on jobs and projects
-- ============================================================
ALTER TABLE public.jobs
  ADD COLUMN IF NOT EXISTS loss_type_id uuid REFERENCES public.option_list_values(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cash_payer_name text,
  ADD COLUMN IF NOT EXISTS agreed_price numeric(12,2),
  ADD COLUMN IF NOT EXISTS deposit_amount numeric(12,2),
  ADD COLUMN IF NOT EXISTS payment_terms text;

ALTER TABLE public.projects
  ADD COLUMN IF NOT EXISTS loss_type_id uuid REFERENCES public.option_list_values(id) ON DELETE SET NULL;

ALTER TABLE public.jobs ALTER COLUMN loss_type DROP NOT NULL;
ALTER TABLE public.projects ALTER COLUMN loss_type DROP NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_loss_type_id_idx ON public.jobs(loss_type_id);
CREATE INDEX IF NOT EXISTS jobs_job_type_idx ON public.jobs(job_type);
CREATE INDEX IF NOT EXISTS projects_loss_type_id_idx ON public.projects(loss_type_id);

-- legacy enum value -> new category key
CREATE OR REPLACE FUNCTION public.loss_type_key_for_enum(_v public.job_loss_type)
RETURNS text LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _v
    WHEN 'water' THEN 'water_mitigation'
    WHEN 'fire' THEN 'fire_smoke_cleaning'
    WHEN 'smoke' THEN 'fire_smoke_cleaning'
    WHEN 'sewer' THEN 'sewer_cat3'
    WHEN 'mold' THEN 'mold_remediation'
    WHEN 'biohazard' THEN 'biohazard_trauma'
    WHEN 'storm' THEN 'emergency_services'
    WHEN 'cleaning' THEN 'general_cleaning'
  END
$$;

-- new category key -> nearest legacy enum (kept in sync for older read paths)
CREATE OR REPLACE FUNCTION public.enum_for_loss_type_key(_k text)
RETURNS public.job_loss_type LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE _k
    WHEN 'water_mitigation' THEN 'water'
    WHEN 'fire_smoke_cleaning' THEN 'fire'
    WHEN 'sewer_cat3' THEN 'sewer'
    WHEN 'mold_remediation' THEN 'mold'
    WHEN 'biohazard_trauma' THEN 'biohazard'
    WHEN 'emergency_services' THEN 'storm'
    WHEN 'board_up_tarp' THEN 'storm'
    WHEN 'general_cleaning' THEN 'cleaning'
    WHEN 'contents_packout' THEN 'cleaning'
    WHEN 'reconstruction' THEN 'cleaning'
    WHEN 'asbestos_lead' THEN 'cleaning'
    ELSE NULL
  END::public.job_loss_type
$$;

-- backfill
UPDATE public.jobs j
SET loss_type_id = v.id
FROM public.option_list_values v
JOIN public.option_lists ol ON ol.id = v.list_id AND ol.key = 'loss_type'
WHERE j.loss_type_id IS NULL
  AND v.key = public.loss_type_key_for_enum(j.loss_type);

UPDATE public.projects p
SET loss_type_id = v.id
FROM public.option_list_values v
JOIN public.option_lists ol ON ol.id = v.list_id AND ol.key = 'loss_type'
WHERE p.loss_type_id IS NULL
  AND v.key = public.loss_type_key_for_enum(p.loss_type);

-- existing work is insurance work
UPDATE public.jobs SET job_type = 'insurance' WHERE job_type IS NULL OR btrim(job_type) = '';

-- accounts.loss_types array -> new keys
UPDATE public.accounts a
SET loss_types = sub.arr
FROM (
  SELECT id,
         ARRAY(
           SELECT DISTINCT coalesce(public.loss_type_key_for_enum(t::public.job_loss_type), t)
           FROM unnest(loss_types) AS t
           WHERE t IS NOT NULL
             AND t IN ('water','fire','smoke','sewer','mold','biohazard','storm','cleaning')
         ) AS arr
  FROM public.accounts
  WHERE array_length(loss_types, 1) > 0
) sub
WHERE a.id = sub.id AND array_length(sub.arr, 1) > 0;

-- ============================================================
-- 4. Keep the legacy enum column in step with the managed value
-- ============================================================
CREATE OR REPLACE FUNCTION public.trg_sync_loss_type()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
DECLARE k text;
BEGIN
  IF NEW.loss_type_id IS NOT NULL THEN
    SELECT v.key INTO k FROM public.option_list_values v WHERE v.id = NEW.loss_type_id;
    NEW.loss_type := coalesce(public.enum_for_loss_type_key(k), NEW.loss_type);
  ELSIF NEW.loss_type IS NOT NULL THEN
    SELECT v.id INTO NEW.loss_type_id
    FROM public.option_list_values v
    JOIN public.option_lists ol ON ol.id = v.list_id AND ol.key = 'loss_type'
    WHERE v.key = public.loss_type_key_for_enum(NEW.loss_type);
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_sync_loss_type ON public.jobs;
CREATE TRIGGER trg_jobs_sync_loss_type
BEFORE INSERT OR UPDATE OF loss_type_id, loss_type ON public.jobs
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_loss_type();

DROP TRIGGER IF EXISTS trg_projects_sync_loss_type ON public.projects;
CREATE TRIGGER trg_projects_sync_loss_type
BEFORE INSERT OR UPDATE OF loss_type_id, loss_type ON public.projects
FOR EACH ROW EXECUTE FUNCTION public.trg_sync_loss_type();

-- ============================================================
-- 5. Payment type as a commission dimension
-- ============================================================
ALTER TABLE public.commission_plans ADD COLUMN IF NOT EXISTS payment_type text;
ALTER TABLE public.commission_tiers ADD COLUMN IF NOT EXISTS payment_type text;

REVOKE EXECUTE ON FUNCTION public.loss_type_key_for_enum(public.job_loss_type) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.enum_for_loss_type_key(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.loss_type_key_for_enum(public.job_loss_type) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.enum_for_loss_type_key(text) TO authenticated, service_role;