-- The company's full pre-printed equipment tag register: 5,640 plates.
--
-- The plates are GENERATED, not listed: GSR-<TYPE><NNNNN>-<LOC>, the number
-- zero-padded to 5 digits and running 1..count for each type at each location
-- sheet. AM = air mover, DU = dehumidifier, AS = air scrubber — the register's
-- own type keys (air_mover, dehumidifier, air_scrubber), never "other".
--
-- Same rules as the register import (src/lib/equipment-import.ts, 24 Sep):
--   * one row per tag; a tag already on the register is UPDATED, never added
--     a second time;
--   * "already on the register" is the scanner's matching rule (assetTagKey,
--     22 Oct): case and every separator ignored, so GSR-AM00034-NJ, GSRAM00034NJ
--     and "gsr am00034 nj" are one tag. Exact spelling wins; two different
--     units that only tie once dashes are dropped are NOT guessed between —
--     that tag is skipped and counted;
--   * an existing unit gets only what the plate says — its type and its home
--     office — plus the tag respelt exactly as printed. Status, make, model,
--     serial, notes, rates and placements are never touched, so a unit out on
--     a job stays on that job.
-- New units are 'available' (the register's idle state) and on no job.
--
-- Offices: the eleven from the 22 Oct staff import, found through its
-- staff_roster_offices map, then by code, then by city + state. A sheet whose
-- office cannot be found is skipped and counted — no office is invented for it.
--
-- CAT1 / CAT2 are the catastrophe-response pools, not one of the eleven
-- offices. Their home is the CAT location: one whose code is CAT1 / CAT2 if
-- that exists, else the existing "CAT" location (Gold Star Restoration CAT
-- LLC, set up under Admin → Offices), else one is created here as
-- "CAT Team (catastrophe response)", with a placeholder address and position
-- to complete under Admin → Offices. The pool a unit
-- belongs to stays in its tag (…-CAT1 / …-CAT2) and in the note a NEW unit
-- gets. They are never put into a real office.
--
-- Idempotent: a second run finds every tag exact and unchanged. Each run's
-- counts per location are kept in equipment_tag_register_imports and raised as
-- NOTICEs for the migration log.

CREATE TABLE IF NOT EXISTS public.equipment_tag_register_imports (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_at      timestamptz NOT NULL DEFAULT now(),
  sheet       text NOT NULL,
  location_id uuid REFERENCES public.locations(id) ON DELETE SET NULL,
  tags        integer NOT NULL,
  created     integer NOT NULL,
  updated     integer NOT NULL,
  unchanged   integer NOT NULL,
  skipped     integer NOT NULL,
  detail      text
);
ALTER TABLE public.equipment_tag_register_imports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.equipment_tag_register_imports FROM PUBLIC, anon;
DROP POLICY IF EXISTS equipment_tag_register_imports_read ON public.equipment_tag_register_imports;
CREATE POLICY equipment_tag_register_imports_read ON public.equipment_tag_register_imports
  FOR SELECT TO authenticated
  USING (public.is_privileged((SELECT auth.uid())));
GRANT SELECT ON public.equipment_tag_register_imports TO authenticated;

DO $register$
DECLARE
  s record;
  v_loc uuid;
  v_created int;
  v_updated int;
  v_unchanged int;
  v_skipped int;
  v_total int;
  v_detail text;
BEGIN
  -- The sheets: tag suffix, roster office key, fallback codes, city, state, counts.
  CREATE TEMP TABLE _sheets ON COMMIT DROP AS
  SELECT * FROM (VALUES
    ('NY',   'brooklyn',    ARRAY['NY'],           'Brooklyn',    'NY', 400, 100, 50, 1),
    ('NYU',  'monsey',      ARRAY['NY-UP','NYU'],  'Monsey',      'NY', 350, 100, 50, 2),
    ('NJ',   'lakewood',    ARRAY['NJ'],           'Lakewood',    'NJ', 400, 100, 50, 3),
    ('MD',   'baltimore',   ARRAY['MD'],           'Baltimore',   'MD', 200,  50, 35, 4),
    ('MI',   'southfield',  ARRAY['MI'],           'Southfield',  'MI', 250, 100, 50, 5),
    ('GA',   'atlanta',     ARRAY['GA'],           'Atlanta',     'GA', 350, 100, 50, 6),
    ('HTX',  'houston',     ARRAY['TX','HTX'],     'Houston',     'TX', 300,  50, 35, 7),
    ('NC',   'garner',      ARRAY['NC'],           'Garner',      'NC', 400, 100, 50, 8),
    ('IL',   'skokie',      ARRAY['IL'],           'Skokie',      'IL', 300, 200, 50, 9),
    ('IN',   'columbus',    ARRAY['IN'],           'Columbus',    'IN', 200,  50, 35, 10),
    ('CA',   'los_angeles', ARRAY['CA'],           'Los Angeles', 'CA', 100,  50, 35, 11),
    ('CAT1', NULL,          ARRAY['CAT1','CAT'],   NULL,          NULL, 300, 100, 50, 12),
    ('CAT2', NULL,          ARRAY['CAT2','CAT'],   NULL,          NULL, 300, 100, 50, 13)
  ) AS t(sheet, roster_key, codes, city, state, am, du, sc, ord);

  -- The CAT pools' home, made only when no CAT location exists at all.
  IF NOT EXISTS (
    SELECT 1 FROM public.locations WHERE upper(code) IN ('CAT', 'CAT1', 'CAT2')
  ) THEN
    INSERT INTO public.locations (code, name, address, locality, region, lat, lon)
    VALUES ('CAT', 'CAT Team (catastrophe response)', 'Catastrophe response — no fixed office',
            'Brooklyn', 'NY', 40.62440, -73.95640);
    RAISE NOTICE 'equipment tags: created location CAT (catastrophe response) for the CAT1/CAT2 pools';
  END IF;

  CREATE TEMP TABLE _plates (
    sheet text, tag text, tag_key text, equipment_type text, location_id uuid, note text
  ) ON COMMIT DROP;

  FOR s IN SELECT * FROM _sheets ORDER BY ord LOOP
    v_loc := NULL;
    IF s.roster_key IS NOT NULL AND to_regclass('public.staff_roster_offices') IS NOT NULL THEN
      EXECUTE 'SELECT location_id FROM public.staff_roster_offices WHERE key = $1'
        INTO v_loc USING s.roster_key;
    END IF;
    IF v_loc IS NULL THEN
      SELECT l.id INTO v_loc
        FROM public.locations l
        JOIN unnest(s.codes) WITH ORDINALITY AS c(code, n) ON upper(l.code) = upper(c.code)
       ORDER BY c.n, l.active DESC, l.created_at
       LIMIT 1;
    END IF;
    IF v_loc IS NULL AND s.city IS NOT NULL THEN
      SELECT id INTO v_loc FROM public.locations
       WHERE lower(btrim(locality)) = lower(s.city) AND upper(region) = s.state
       ORDER BY active DESC, created_at LIMIT 1;
    END IF;

    v_total := s.am + s.du + s.sc;
    IF v_loc IS NULL THEN
      INSERT INTO public.equipment_tag_register_imports
        (sheet, location_id, tags, created, updated, unchanged, skipped, detail)
      VALUES (s.sheet, NULL, v_total, 0, 0, 0, v_total, 'office not found — nothing imported');
      RAISE NOTICE 'equipment tags %: office not found, % skipped', s.sheet, v_total;
      CONTINUE;
    END IF;

    INSERT INTO _plates (sheet, tag, tag_key, equipment_type, location_id, note)
    SELECT s.sheet,
           'GSR-' || t.code || lpad(n::text, 5, '0') || '-' || s.sheet,
           'GSR' || t.code || lpad(n::text, 5, '0') || s.sheet,
           t.equipment_type,
           v_loc,
           CASE s.sheet
             WHEN 'CAT1' THEN 'CAT Team 1 pool (catastrophe response)'
             WHEN 'CAT2' THEN 'CAT Team 2 pool (catastrophe response)'
           END
      FROM (VALUES ('AM', 'air_mover', s.am),
                   ('DU', 'dehumidifier', s.du),
                   ('AS', 'air_scrubber', s.sc)) AS t(code, equipment_type, how_many)
      CROSS JOIN LATERAL generate_series(1, t.how_many) AS n;
  END LOOP;

  -- Which register unit each plate is: exact spelling first, else the one unit
  -- with the same key; two or more with the key and none exact is ambiguous.
  CREATE TEMP TABLE _match ON COMMIT DROP AS
  SELECT p.*,
         m.exact_id,
         m.key_ids
    FROM _plates p
    LEFT JOIN LATERAL (
      SELECT (array_agg(e.id) FILTER (WHERE e.asset_tag = p.tag))[1] AS exact_id,
             array_agg(e.id) AS key_ids
        FROM public.equipment e
       WHERE upper(regexp_replace(e.asset_tag, '[^A-Za-z0-9]', '', 'g')) = p.tag_key
    ) m ON true;

  CREATE TEMP TABLE _plan ON COMMIT DROP AS
  SELECT mt.*,
         CASE
           WHEN mt.key_ids IS NULL THEN NULL
           WHEN mt.exact_id IS NOT NULL THEN mt.exact_id
           WHEN cardinality(mt.key_ids) = 1 THEN mt.key_ids[1]
         END AS unit_id,
         (mt.key_ids IS NOT NULL AND mt.exact_id IS NULL AND cardinality(mt.key_ids) > 1)
           AS ambiguous
    FROM _match mt;

  -- Existing units: the plate's type, home office and printed spelling.
  CREATE TEMP TABLE _changed (sheet text, tag text) ON COMMIT DROP;
  WITH upd AS (
    UPDATE public.equipment e
       SET asset_tag = p.tag,
           equipment_type = p.equipment_type,
           location_id = p.location_id
      FROM _plan p
     WHERE e.id = p.unit_id
       AND (e.asset_tag IS DISTINCT FROM p.tag
            OR e.equipment_type IS DISTINCT FROM p.equipment_type
            OR e.location_id IS DISTINCT FROM p.location_id)
    RETURNING p.sheet, p.tag
  )
  INSERT INTO _changed SELECT * FROM upd;

  -- New units: idle, on no job.
  CREATE TEMP TABLE _inserted (asset_tag text) ON COMMIT DROP;
  WITH ins AS (
    INSERT INTO public.equipment (asset_tag, equipment_type, location_id, status, notes)
    SELECT p.tag, p.equipment_type, p.location_id, 'available', p.note
      FROM _plan p
     WHERE p.key_ids IS NULL
    ON CONFLICT (asset_tag) DO NOTHING
    RETURNING asset_tag
  )
  INSERT INTO _inserted SELECT * FROM ins;

  FOR s IN
    SELECT p.sheet,
           min(p.location_id::text)::uuid AS location_id,
           count(*)::int AS tags,
           count(*) FILTER (WHERE i.asset_tag IS NOT NULL)::int AS created,
           count(*) FILTER (WHERE c.tag IS NOT NULL)::int AS updated,
           count(*) FILTER (WHERE p.unit_id IS NOT NULL AND c.tag IS NULL)::int AS unchanged,
           count(*) FILTER (WHERE p.ambiguous)::int AS ambiguous,
           count(*) FILTER (WHERE p.key_ids IS NULL AND i.asset_tag IS NULL)::int AS lost
      FROM _plan p
      JOIN _sheets sh ON sh.sheet = p.sheet
      LEFT JOIN _inserted i ON i.asset_tag = p.tag
      LEFT JOIN _changed c ON c.tag = p.tag
     GROUP BY p.sheet, sh.ord
     ORDER BY sh.ord
  LOOP
    v_skipped := s.ambiguous + s.lost;
    v_detail := CASE WHEN s.ambiguous > 0
      THEN s.ambiguous || ' tag(s) match more than one unit once dashes are ignored — not guessed'
    END;
    INSERT INTO public.equipment_tag_register_imports
      (sheet, location_id, tags, created, updated, unchanged, skipped, detail)
    VALUES (s.sheet, s.location_id, s.tags, s.created, s.updated, s.unchanged, v_skipped, v_detail);
    RAISE NOTICE 'equipment tags %: % tags — % created, % updated, % unchanged, % skipped',
      s.sheet, s.tags, s.created, s.updated, s.unchanged, v_skipped;
  END LOOP;
END
$register$;
