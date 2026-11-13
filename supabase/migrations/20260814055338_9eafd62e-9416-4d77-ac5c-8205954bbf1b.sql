UPDATE public.incidents i
SET lat = l.lat + (random() - 0.5) * 0.12,
    lon = l.lon + (random() - 0.5) * 0.12
FROM public.locations l
WHERE i.location_id = l.id AND i.lat IS NULL AND l.lat IS NOT NULL;

UPDATE public.jobs j
SET lat = l.lat + (random() - 0.5) * 0.12,
    lon = l.lon + (random() - 0.5) * 0.12
FROM public.locations l
WHERE j.location_id = l.id AND j.lat IS NULL AND l.lat IS NOT NULL AND j.is_demo IS TRUE;