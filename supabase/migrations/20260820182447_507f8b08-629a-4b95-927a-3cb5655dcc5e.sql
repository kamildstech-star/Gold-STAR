DROP INDEX IF EXISTS public.equipment_alerts_open_uniq;
DELETE FROM public.equipment_alerts a USING public.equipment_alerts b
  WHERE a.equipment_id = b.equipment_id AND a.kind = b.kind AND a.ctid > b.ctid;
ALTER TABLE public.equipment_alerts
  ADD CONSTRAINT equipment_alerts_equipment_kind_key UNIQUE (equipment_id, kind);