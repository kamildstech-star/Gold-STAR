-- Fire feed: the free government sources the 11 Oct research pass found,
-- added SWITCHED OFF, plus one data correction to a seeded watch area.
--
-- Mark: "I don't want to pay API fees." Each source below is a public feed
-- or page an agency publishes for anyone to read. Every row is inserted with
-- enabled = false; an admin turns each one on at Settings › Sales › Fire feed
-- after looking at what a dry run says it would produce. Re-runnable: rows
-- conflict on the URL (fire_feed_sources_url_uniq) and are left alone.
--
-- DATA ONLY: no table, column, policy, grant or function changes. Needs
-- 20261011140000 (the fire feed's tables) applied first.
--
--   1. Rockland County 44-Control Firewatch: http://firewatch.44-control.net/status.json
--      Rockland County Sheriff's Communications' fire CAD feed, refreshed about
--      every 30 s: house-number address, town, lat/lon, type, units, status.
--      Served over plain HTTP only (no HTTPS on that host) and not a .gov name,
--      so the row carries government_ack = true (the confirmation an admin
--      gives on the panel), and the screen marks it "not encrypted". Times are
--      Eastern with no zone. Completed calls stay in the file; they are NOT
--      filtered out (exclude_statuses unset), because a fire put out an hour
--      ago is still a restoration lead and the ledger reads each call once.
--      Every 2 min, pinned to Haverstraw, NY.
--   2. Notify NYC (NYC Emergency Management) CAP RSS. Each alert is repeated
--      in about twelve languages, marked only in <author>, so author_filter
--      keeps "NYCEM [English]". About 23 items at a time. Every 5 min, pinned
--      to Brooklyn, NY.
--   3. LAFD Alerts RSS. Titles carry HTML; dates read "Sunday, October 11,
--      2026 - 07:40" in Pacific time (timezone set). Every 10 min, pinned to
--      Los Angeles, CA.
--   4. Houston Fire Department active incidents (City of Houston), the HTML
--      table #GridView2: street + cross street (no house numbers), opened time
--      in Central time, type, alarm level, units. Mostly EMS, so only fire
--      rows are kept. Every 5 min, pinned to Houston, TX.
--   5. The Lakewood Scoop RSS: added DISABLED with a note. The site posts no
--      terms of use, so Mark is asking the publisher before it is used.
--
--   6. Correction: the Lakewood, NJ watch area was seeded from the CAT
--      office, whose locations row carries placeholder coordinates
--      (40.68, -73.94 — that is Brooklyn). Its 15-mile circle therefore sat
--      over Brooklyn and a Lakewood fire would read "outside every watch
--      area". It is moved to the NJ office at 1309 Ridge Ave, Lakewood — the
--      same street address as CAT — but only while it still holds the
--      placeholder, so an admin's own edit is never overwritten.

INSERT INTO public.fire_feed_sources (kind, label, url, poll_minutes, enabled, area_id, config)
SELECT v.kind,
       v.label,
       v.url,
       v.poll_minutes,
       false,
       (SELECT a.id
          FROM public.fire_feed_areas a
         WHERE lower(a.locality) = lower(v.area_locality) AND a.state = v.area_state
         ORDER BY a.created_at
         LIMIT 1),
       v.config
  FROM (VALUES
    ('public_page', 'Rockland County 44-Control Firewatch',
     'http://firewatch.44-control.net/status.json', 2, 'Haverstraw', 'NY',
     $cfg${"preset": "json", "government_ack": true, "timezone": "America/New_York", "fire_rows_only": true, "json": {"items_path": "Fire", "fields": {"id": "ID", "type": "Incident Type", "address": "Address", "town": "Address2", "time": "Time Reported", "units": "Units", "status": "Call Status", "cross": "Nearest Intersection", "lat": "Latitude", "lon": "Longitude"}}, "note": "Rockland County Sheriff's Communications (44-Control) fire CAD feed. Plain http only (not encrypted); confirmed as a public government page. Completed calls are kept on purpose: a fire put out an hour ago is still a lead."}$cfg$::jsonb),
    ('rss', 'Notify NYC (NYC Emergency Management)',
     'https://feeds.everbridge.net/feeds/453003085617722/rss/rss.xml', 5, 'Brooklyn', 'NY',
     $cfg${"publisher": "Notify NYC", "author_filter": "NYCEM [English]", "timezone": "America/New_York", "note": "Official NYCEM alerts. Fires appear only when NYCEM issues a message (usually multi-alarm). Only the English copy of each alert is read."}$cfg$::jsonb),
    ('rss', 'LAFD Alerts',
     'https://lafd.org/alerts-rss.xml', 10, 'Los Angeles', 'CA',
     $cfg${"publisher": "LAFD", "timezone": "America/Los_Angeles", "note": "LAFD public information alerts: notable structure fires with full addresses."}$cfg$::jsonb),
    ('public_page', 'Houston Fire Department active incidents',
     'https://cohweb.houstontx.gov/ActiveIncidents/Combined.aspx?agency=F', 5, 'Houston', 'TX',
     $cfg${"preset": "html_table", "timezone": "America/Chicago", "fire_rows_only": true, "table": {"id": "GridView2", "columns": {"address": "Address", "cross": "Cross Street", "time": "Call Time(Opened)", "type": "Incident Type", "alarm": "Alarm Level", "units": "Units"}}, "note": "City of Houston active HFD incidents. Street and cross street only (no house numbers), so leads are marked for review."}$cfg$::jsonb),
    ('rss', 'The Lakewood Scoop',
     'https://thelakewoodscoop.com/feed/', 10, 'Lakewood', 'NJ',
     $cfg${"publisher": "The Lakewood Scoop", "note": "Do not enable yet: the site posts no terms of use, so Mark is asking the publisher first (11 Oct 2026)."}$cfg$::jsonb)
  ) AS v(kind, label, url, poll_minutes, area_locality, area_state, config)
ON CONFLICT ((lower(url))) WHERE url IS NOT NULL DO NOTHING;

-- 6. Lakewood, NJ: from the CAT office's placeholder point to the NJ office.
UPDATE public.fire_feed_areas a
   SET center_lat = l.lat,
       center_lon = l.lon
  FROM public.locations l
 WHERE l.code = 'NJ'
   AND l.lat IS NOT NULL AND l.lon IS NOT NULL
   AND lower(a.locality) = 'lakewood' AND a.state = 'NJ'
   AND a.center_lat = 40.68 AND a.center_lon = -73.94;
