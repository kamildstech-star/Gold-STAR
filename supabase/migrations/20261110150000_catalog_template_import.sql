-- ============================================================================
-- David's invoice catalog: the Template tab of "Scope Line Items List w
-- eamples_Updated (002).xlsx" (6 Nov call, [04:16]-[07:45]).
--
-- "These items in here is just what Mark and Moshe put in as a sample ...
-- we use your file and override it." The sheet lists the invoice line items
-- per job type - Water, Fire, Mold, BIO, Equipment - with a description, a
-- unit and the Standard unit price. Athar and David settled on tabs per job
-- type, so each job type is an estimate header and an item that appears
-- under several types is one catalog row per type (codes are unique).
--
-- What this does, re-runnably:
--   1. Makes sure a header exists for each job type on the sheet (matched by
--      name to the headers already there: Water, Fire & Smoke, Mold, Bio,
--      Equipment).
--   2. Adds each row to catalog_items (the single home for items, Billing &
--      Costs > Catalogs); its mirror trigger creates the estimate row the
--      invoice and estimate pickers read. Then files that row under its
--      header with the sheet's description, unit and Standard price (a dated
--      money_values row, as standard_save writes it).
--   3. Archives the ITEM-xx "New item" placeholders so the picker no longer
--      offers them. Anything already on an invoice keeps its line.
--
-- Rows the sheet leaves unpriced (Injectidry system, Debris removal, Truck
-- fee, Discount, the three BIO box sizes) come in at $0.00 for the office to
-- price in General Rates. Mold's "Discount" row reads $500 on the sheet; it
-- is loaded at $0 like every other discount line (a $500 discount by
-- default would be a costly mistake), noted here for David. The sheet's
-- after-hours labor is a separate item at its own price, since the catalog
-- has no after-hours switch.
-- ============================================================================

DO $$
DECLARE
  r record;
  hdr uuid;
  cat text;
  v_unit text;
  v_uom text;
  est uuid;
  added integer := 0;
  updated integer := 0;
  archived integer := 0;
  next_sort integer;
BEGIN
  PERFORM set_config('gsr.money_note', 'David''s Template tab loaded (20261110150000)', true);

  -- 1. One header per job type on the sheet.
  FOR r IN SELECT * FROM (VALUES
      ('Water',     'WATER', 'Water'),
      ('Fire',      'FIRE',  'Fire'),
      ('Mold',      'MOLD',  'Mold'),
      ('BIO',       'BIO',   'Bio'),
      ('Equipment', 'EQUIP', 'Equipment')
    ) AS t(job_type, code, name)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM public.estimate_headers h
                    WHERE lower(h.name) = lower(r.name)
                       OR lower(h.name) LIKE lower(r.name) || ' %'
                       OR lower(h.name) LIKE lower(r.name) || ' &%') THEN
      SELECT coalesce(max(sort_order), 0) + 10 INTO next_sort FROM public.estimate_headers;
      INSERT INTO public.estimate_headers (code, name, sort_order, is_active)
      VALUES (r.code, r.name, next_sort, true)
      ON CONFLICT (code) DO UPDATE SET is_active = true;
    END IF;
  END LOOP;

  SELECT coalesce(max(sort_order), 0) INTO next_sort FROM public.estimate_catalog_items;

  -- 2. The Template rows. (job type, code, name, description, sheet unit, price, category)
  FOR r IN SELECT * FROM (VALUES
    -- Water
    ('Water', 'WTR-EMG-CALL',      'Emergency service call',            'Initial mobilization charge.', NULL, 200.00, 'service'),
    ('Water', 'WTR-EMG-CALL-AH',   'Emergency service call - after hours', 'Mobilization charge for an after-hours service call. Extreme circumstances will require a premium charge above the standard after-hours rate, noted accordingly.', NULL, 200.00, 'service'),
    ('Water', 'WTR-LABOR-AH',      'General labor - after hours',       'General labor after normal business hours. Holidays and extreme circumstances will require a premium over the standard after-hours rate, notated accordingly.', 'Hr', 95.00, 'labor'),
    ('Water', 'WTR-LABOR',         'General labor - per hour',          'General labor during normal business hours.', 'Hr', 65.00, 'labor'),
    ('Water', 'WTR-LABOR-CAT3',    'General labor - per hour - Cat 3',  NULL, 'Hr', 95.00, 'labor'),
    ('Water', 'WTR-MATERIALS',     'General materials charge',          'Includes all consumables.', NULL, 300.00, 'service'),
    ('Water', 'WTR-AIR-MOVER',     'Air mover',                         NULL, 'Each', 45.00, 'equipment'),
    ('Water', 'WTR-DEHU',          'Dehumidifier',                      NULL, 'Each', 225.00, 'equipment'),
    ('Water', 'WTR-AIR-SCRUBBER',  'Air scrubber',                      'To filter the air and/or to create a negative air environment. Monitoring charge not included.', 'Each', 200.00, 'equipment'),
    ('Water', 'WTR-INJECT-DRYER',  'Inject-dryers',                     NULL, 'Each', 100.00, 'equipment'),
    ('Water', 'WTR-INJECTIDRY',    'Injectidry system',                 'Drying hardwood floors with Injectidry system.', 'Each', 0, 'equipment'),
    ('Water', 'WTR-DEBRIS',        'Debris removal',                    NULL, NULL, 0, 'service'),
    ('Water', 'WTR-ENCAPSULATE',   'Encapsulate',                       NULL, NULL, 500.00, 'service'),
    ('Water', 'WTR-DISCOUNT',      'Discount',                          'Discount amounts are ONLY applied if and only if the bill is paid by the due date.', NULL, 0, 'service'),
    ('Water', 'WTR-TRUCK-FEE',     'Truck fee - per truck / per day',   NULL, NULL, 0, 'service'),
    -- Fire
    ('Fire', 'FIRE-EMG-CALL',      'Emergency service call',            'Initial mobilization charge.', NULL, 200.00, 'service'),
    ('Fire', 'FIRE-EMG-CALL-AH',   'Emergency service call - after hours', 'Mobilization charge for an after-hours service call. Extreme circumstances will require a premium charge above the standard after-hours rate, noted accordingly.', NULL, 200.00, 'service'),
    ('Fire', 'FIRE-LABOR-AH',      'General labor - after hours',       'General labor after normal business hours. Holidays and extreme circumstances will require a premium over the standard after-hours rate, notated accordingly.', 'Hr', 95.00, 'labor'),
    ('Fire', 'FIRE-LABOR',         'General labor - per hour',          'General labor during normal business hours.', 'Hr', 65.00, 'labor'),
    ('Fire', 'FIRE-BOARD-UP',      'Board up',                          'Board up to secure property.', 'Each', 75.00, 'service'),
    ('Fire', 'FIRE-MATERIALS',     'General materials charge',          'Includes all consumables.', NULL, 300.00, 'service'),
    ('Fire', 'FIRE-AIR-MOVER',     'Air mover',                         NULL, 'Each', 45.00, 'equipment'),
    ('Fire', 'FIRE-DEHU',          'Dehumidifier',                      NULL, 'Each', 225.00, 'equipment'),
    ('Fire', 'FIRE-AIR-SCRUBBER',  'Air scrubber',                      'To filter the air and/or to create a negative air environment. Monitoring charge not included.', 'Each', 200.00, 'equipment'),
    ('Fire', 'FIRE-DEBRIS',        'Debris removal',                    NULL, NULL, 0, 'service'),
    ('Fire', 'FIRE-ENCAPSULATE',   'Encapsulate',                       NULL, NULL, 500.00, 'service'),
    ('Fire', 'FIRE-DISCOUNT',      'Discount',                          'Discount amounts are ONLY applied if and only if the bill is paid by the due date.', NULL, 0, 'service'),
    ('Fire', 'FIRE-TRUCK-FEE',     'Truck fee - per truck / per day',   NULL, NULL, 0, 'service'),
    -- Mold
    ('Mold', 'MOLD-LABOR-AH',      'General labor - after hours',       'General labor after normal business hours. Holidays and extreme circumstances will require a premium over the standard after-hours rate, notated accordingly.', 'Hr', 95.00, 'labor'),
    ('Mold', 'MOLD-LABOR',         'General labor - per hour',          'General labor during normal business hours.', 'Hr', 65.00, 'labor'),
    ('Mold', 'MOLD-LABOR-CAT3',    'General labor - per hour - Cat 3',  NULL, 'Hr', 95.00, 'labor'),
    ('Mold', 'MOLD-MATERIALS',     'General materials charge',          'Includes all consumables.', NULL, 300.00, 'service'),
    ('Mold', 'MOLD-DEHU',          'Dehumidifier',                      NULL, 'Each', 225.00, 'equipment'),
    ('Mold', 'MOLD-AIR-SCRUBBER',  'Air scrubber',                      'To filter the air and/or to create a negative air environment. Monitoring charge not included.', 'Each', 200.00, 'equipment'),
    ('Mold', 'MOLD-FOGGER',        'Fogger',                            'Intended to be used when disinfecting / sanitizing an area that may also have contents in the rooms.', 'Each', 150.00, 'equipment'),
    ('Mold', 'MOLD-DEBRIS',        'Debris removal',                    NULL, NULL, 0, 'service'),
    ('Mold', 'MOLD-ENCAPSULATE',   'Encapsulate',                       NULL, NULL, 500.00, 'service'),
    ('Mold', 'MOLD-AIR-SAMPLE',    'Air sample',                        'Includes up to 4 samples.', NULL, 600.00, 'service'),
    ('Mold', 'MOLD-DISCOUNT',      'Discount',                          'Discount amounts are ONLY applied if and only if the bill is paid by the due date. (The sheet reads $500 here; loaded at $0 like the other discount lines - set it in General Rates if $500 is right.)', NULL, 0, 'service'),
    ('Mold', 'MOLD-TRUCK-FEE',     'Truck fee - per truck / per day',   NULL, NULL, 0, 'service'),
    -- BIO
    ('BIO', 'BIO-REMED-LABOR',     'Bio hazard remediation labor',      'Labor for bio hazard remediation. Due to liability constraints, any activities taking place in the area of an active biohazard area MUST be billed at this rate. Billed per hour during normal business hours; after-hours and holidays at time-and-a-half / double time.', 'Hr', 95.00, 'labor'),
    ('BIO', 'BIO-LABOR',           'Bio labor charge',                  NULL, 'Hr', 95.00, 'labor'),
    ('BIO', 'BIO-GEN-LABOR',       'General labor - per hour',          'General labor during normal business hours.', 'Hr', 65.00, 'labor'),
    ('BIO', 'BIO-MATERIALS',       'General materials charge',          'Includes all consumables.', NULL, 0, 'service'),
    ('BIO', 'BIO-WASTE-BOX',       'Bio waste expense',                 'Cost including pickup charge - per box.', 'Each', 110.00, 'service'),
    ('BIO', 'BIO-BOX-LRG',         'Bio-hazard box & liner - large',    NULL, 'Each', 0, 'service'),
    ('BIO', 'BIO-BOX-MED',         'Bio-hazard box & liner - medium',   NULL, 'Each', 0, 'service'),
    ('BIO', 'BIO-BOX-SM',          'Bio-hazard box & liner - small',    NULL, 'Each', 0, 'service'),
    ('BIO', 'BIO-AIR-MOVER',       'Air mover',                         NULL, 'Each', 45.00, 'equipment'),
    ('BIO', 'BIO-AIR-SCRUBBER',    'Air scrubber',                      'To filter the air and/or to create a negative air environment. Monitoring charge not included.', 'Each', 200.00, 'equipment'),
    ('BIO', 'BIO-HYDROXYL',        'Hydroxyl generator',                'Odor counteractant.', 'Each', 250.00, 'equipment'),
    ('BIO', 'BIO-OZONE',           'Ozone treatment',                   NULL, 'Each', 250.00, 'equipment'),
    ('BIO', 'BIO-FOGGER',          'Fogger',                            'Intended to be used when disinfecting / sanitizing an area that may also have contents in the rooms.', 'Each', 150.00, 'equipment'),
    ('BIO', 'BIO-BIOCIDE',         'Biocide treatment',                 'To control the spread of harmful microorganisms like bacteria and viruses.', 'Each', 150.00, 'service'),
    ('BIO', 'BIO-DEBRIS',          'Debris removal',                    NULL, NULL, 0, 'service'),
    ('BIO', 'BIO-DISCOUNT',        'Discount',                          'Discount amounts are ONLY applied if and only if the bill is paid by the due date.', NULL, 0, 'service'),
    ('BIO', 'BIO-TRUCK-FEE',       'Truck fee - per truck / per day',   NULL, NULL, 0, 'service'),
    -- Equipment
    ('Equipment', 'EQP-AIR-MOVER',    'Air mover',                      NULL, 'Each', 45.00, 'equipment'),
    ('Equipment', 'EQP-DEHU',         'Dehumidifier',                   NULL, 'Each', 225.00, 'equipment'),
    ('Equipment', 'EQP-AIR-SCRUBBER', 'Air scrubber',                   'To filter the air and/or to create a negative air environment. Monitoring charge not included.', 'Each', 200.00, 'equipment'),
    ('Equipment', 'EQP-INJECT-DRYER', 'Inject-dryers',                  NULL, 'Each', 100.00, 'equipment'),
    ('Equipment', 'EQP-INJECTIDRY',   'Injectidry system',              'Drying hardwood floors with Injectidry system.', 'Each', 0, 'equipment'),
    ('Equipment', 'EQP-HYDROXYL',     'Hydroxyl generator',             'Odor counteractant.', 'Each', 250.00, 'equipment'),
    ('Equipment', 'EQP-OZONE',        'Ozone treatment',                NULL, 'Each', 250.00, 'equipment'),
    ('Equipment', 'EQP-FOGGER',       'Fogger',                         'Intended to be used when disinfecting / sanitizing an area that may also have contents in the rooms.', 'Each', 150.00, 'equipment'),
    ('Equipment', 'EQP-EXTRACTOR',    'Extractor',                      'Price is per hour for the machine ONLY. Does not include labor.', 'Hr', 90.00, 'equipment'),
    ('Equipment', 'EQP-EXTRACTOR-CAT3', 'Extractor - Cat 3',            'Price is per hour for the machine ONLY. Does not include labor.', 'Hr', 145.00, 'equipment'),
    ('Equipment', 'EQP-TRUCK-FEE',    'Truck fee - per truck / per day', NULL, NULL, 0, 'service')
  ) AS t(job_type, code, name, description, sheet_unit, price, category)
  LOOP
    -- The header for the row's job type.
    SELECT h.id INTO hdr FROM public.estimate_headers h
     WHERE lower(h.name) = lower(CASE r.job_type WHEN 'BIO' THEN 'Bio' ELSE r.job_type END)
        OR lower(h.name) LIKE lower(CASE r.job_type WHEN 'BIO' THEN 'Bio' ELSE r.job_type END) || ' %'
        OR lower(h.name) LIKE lower(CASE r.job_type WHEN 'BIO' THEN 'Bio' ELSE r.job_type END) || ' &%'
     ORDER BY h.is_active DESC, h.sort_order LIMIT 1;

    cat := r.category;
    v_unit := CASE upper(coalesce(r.sheet_unit, ''))
              WHEN 'HR' THEN 'hr' WHEN 'EACH' THEN 'piece' WHEN 'EA' THEN 'piece' WHEN 'DAY' THEN 'day'
              ELSE CASE WHEN cat = 'labor' THEN 'hr' ELSE 'piece' END END;
    v_uom := CASE upper(coalesce(r.sheet_unit, ''))
             WHEN 'HR' THEN 'HR' WHEN 'DAY' THEN 'DAY' ELSE 'EA' END;
    next_sort := next_sort + 1;

    BEGIN
      IF EXISTS (SELECT 1 FROM public.catalog_items ci WHERE ci.code = r.code) THEN
        UPDATE public.catalog_items
           SET name = r.name, note = r.description, active = true, archived_at = NULL, archived_by = NULL,
               in_regular = true, updated_at = now()
         WHERE code = r.code;
        updated := updated + 1;
      ELSE
        INSERT INTO public.catalog_items (code, name, category, unit, note, active, sort_order,
                                          source_book, source_key, in_tm, in_regular)
        VALUES (r.code, r.name, cat, v_unit, r.description, true, next_sort,
                'david_template_2026_11', r.job_type || ' / ' || r.name, false, true);
        added := added + 1;
      END IF;

      -- The estimate row the pickers read: the mirror trigger made or found it
      -- by code; file it under its header with the sheet's words and unit.
      SELECT id INTO est FROM public.estimate_catalog_items WHERE code = r.code;
      IF est IS NULL THEN
        INSERT INTO public.estimate_catalog_items (code, name, uom, default_unit_price, is_active, sort_order)
        VALUES (r.code, r.name, v_uom, 0, true, next_sort)
        RETURNING id INTO est;
      END IF;
      UPDATE public.estimate_catalog_items
         SET header_id = coalesce(hdr, header_id), name = r.name, description = r.description,
             uom = v_uom, is_active = true, sort_order = next_sort, default_unit_price = r.price
       WHERE id = est;

      -- The Standard price, dated today, exactly as standard_save writes it.
      DELETE FROM public.money_values mv
       WHERE mv.book = 'client_agreements' AND mv.item_key = r.code AND mv.measure = 'unit_price'
         AND mv.office_id IS NULL AND mv.effective_from = current_date;
      INSERT INTO public.money_values (book, item_key, measure, office_id, effective_from, value, note)
      VALUES ('client_agreements', r.code, 'unit_price', NULL, current_date, r.price,
              'David''s Template tab (6 Nov 2026)');
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'Template row % (%) not loaded: %', r.code, r.name, SQLERRM;
    END;
  END LOOP;

  -- 3. The placeholders Mark and Moshe left: archived, never deleted.
  UPDATE public.catalog_items
     SET active = false, archived_at = coalesce(archived_at, now()), updated_at = now()
   WHERE code ~ '^ITEM-[0-9]+$' AND lower(btrim(name)) = 'new item' AND archived_at IS NULL;
  GET DIAGNOSTICS archived = ROW_COUNT;
  UPDATE public.estimate_catalog_items
     SET is_active = false
   WHERE code ~ '^ITEM-[0-9]+$' AND lower(btrim(name)) = 'new item' AND is_active;

  RAISE NOTICE 'David''s Template tab: % items added, % refreshed, % placeholder items archived.', added, updated, archived;
  PERFORM set_config('gsr.money_note', '', true);
END;
$$;
