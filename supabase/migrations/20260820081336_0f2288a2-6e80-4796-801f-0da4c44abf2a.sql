-- 1. Badge definitions ------------------------------------------------------

ALTER TABLE public.leaderboard_achievements
  ADD COLUMN IF NOT EXISTS rarity text NOT NULL DEFAULT 'common',
  ADD COLUMN IF NOT EXISTS window_kind text NOT NULL DEFAULT 'lifetime',
  ADD COLUMN IF NOT EXISTS rule_key text NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS is_demo boolean NOT NULL DEFAULT false;

ALTER TABLE public.leaderboard_achievements
  DROP CONSTRAINT IF EXISTS leaderboard_achievements_rarity_check;
ALTER TABLE public.leaderboard_achievements
  ADD CONSTRAINT leaderboard_achievements_rarity_check
  CHECK (rarity IN ('common', 'uncommon', 'rare', 'legendary'));

ALTER TABLE public.leaderboard_achievements
  DROP CONSTRAINT IF EXISTS leaderboard_achievements_window_check;
ALTER TABLE public.leaderboard_achievements
  ADD CONSTRAINT leaderboard_achievements_window_check
  CHECK (window_kind IN ('lifetime', 'month', 'streak', 'manual'));

-- 2. Earned badges ----------------------------------------------------------

CREATE TABLE public.user_achievements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  achievement_id uuid NOT NULL REFERENCES public.leaderboard_achievements(id) ON DELETE CASCADE,
  period_key text NOT NULL DEFAULT 'lifetime',
  earned_at timestamptz NOT NULL DEFAULT now(),
  value numeric,
  note text,
  granted_by uuid REFERENCES auth.users(id),
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, achievement_id, period_key)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_achievements TO authenticated;
GRANT ALL ON public.user_achievements TO service_role;

ALTER TABLE public.user_achievements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "user_achievements_select" ON public.user_achievements
  FOR SELECT TO authenticated USING (true);

-- Only the Director's Award (a manual badge) may be granted by hand.
CREATE POLICY "user_achievements_manual_grant" ON public.user_achievements
  FOR INSERT TO authenticated
  WITH CHECK (
    granted_by = auth.uid()
    AND (public.is_sales_lead(auth.uid())
         OR public.has_role(auth.uid(), 'admin')
         OR public.has_role(auth.uid(), 'owner'))
    AND EXISTS (
      SELECT 1 FROM public.leaderboard_achievements a
       WHERE a.id = user_achievements.achievement_id AND a.rule_key = 'manual'
    )
  );

CREATE POLICY "user_achievements_manual_revoke" ON public.user_achievements
  FOR DELETE TO authenticated
  USING (
    (public.is_sales_lead(auth.uid())
     OR public.has_role(auth.uid(), 'admin')
     OR public.has_role(auth.uid(), 'owner'))
    AND EXISTS (
      SELECT 1 FROM public.leaderboard_achievements a
       WHERE a.id = user_achievements.achievement_id AND a.rule_key = 'manual'
    )
  );

CREATE TRIGGER trg_user_achievements_updated_at
  BEFORE UPDATE ON public.user_achievements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_user_achievements_user ON public.user_achievements(user_id);
CREATE INDEX idx_user_achievements_badge ON public.user_achievements(achievement_id);

-- 3. Kudos ------------------------------------------------------------------

CREATE TABLE public.leaderboard_kudos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  from_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL,
  user_achievement_id uuid REFERENCES public.user_achievements(id) ON DELETE CASCADE,
  job_id uuid REFERENCES public.jobs(id) ON DELETE CASCADE,
  is_demo boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.leaderboard_kudos TO authenticated;
GRANT ALL ON public.leaderboard_kudos TO service_role;

ALTER TABLE public.leaderboard_kudos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "leaderboard_kudos_select" ON public.leaderboard_kudos
  FOR SELECT TO authenticated USING (true);

CREATE POLICY "leaderboard_kudos_insert" ON public.leaderboard_kudos
  FOR INSERT TO authenticated
  WITH CHECK (
    from_user_id = auth.uid()
    AND (public.is_sales_lead(auth.uid())
         OR public.has_role(auth.uid(), 'admin')
         OR public.has_role(auth.uid(), 'owner'))
  );

CREATE POLICY "leaderboard_kudos_delete" ON public.leaderboard_kudos
  FOR DELETE TO authenticated
  USING (from_user_id = auth.uid()
         OR public.has_role(auth.uid(), 'admin')
         OR public.has_role(auth.uid(), 'owner'));

CREATE TRIGGER trg_leaderboard_kudos_updated_at
  BEFORE UPDATE ON public.leaderboard_kudos
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE INDEX idx_leaderboard_kudos_to ON public.leaderboard_kudos(to_user_id, created_at DESC);

-- 4. Seed the badge set -----------------------------------------------------

INSERT INTO public.leaderboard_achievements
  (key, name, description, icon, color, metric, threshold, sort_order, active, rarity, window_kind, rule_key)
VALUES
  ('first_deal','First Deal','Signed your first job.','trophy','var(--primary)','jobs_signed',1,10,true,'common','lifetime','jobs_signed_lifetime'),
  ('jobs_10','10 Jobs Signed','Ten signed jobs on the board.','briefcase','var(--primary)','jobs_signed',10,20,true,'common','lifetime','jobs_signed_lifetime'),
  ('jobs_50','50 Jobs Signed','Fifty signed jobs.','briefcase','var(--primary)','jobs_signed',50,30,true,'uncommon','lifetime','jobs_signed_lifetime'),
  ('jobs_100','100 Jobs Signed','A hundred signed jobs.','briefcase','var(--warning)','jobs_signed',100,40,true,'rare','lifetime','jobs_signed_lifetime'),
  ('signed_100k','$100K Signed','One hundred thousand dollars of signed work.','dollar-sign','var(--primary)','signed_value',100000,50,true,'uncommon','lifetime','signed_value_lifetime'),
  ('signed_500k','$500K Signed','Half a million in signed work.','dollar-sign','var(--warning)','signed_value',500000,60,true,'rare','lifetime','signed_value_lifetime'),
  ('signed_1m','$1M Signed','A million dollars of signed work.','gem','var(--warning)','signed_value',1000000,70,true,'legendary','lifetime','signed_value_lifetime'),
  ('streak_5','5-Day Streak','Activity logged five days running.','flame','var(--primary)','streak_days',5,80,true,'common','streak','activity_streak_days'),
  ('streak_30','30-Day Streak','Activity logged thirty days running.','flame','var(--warning)','streak_days',30,90,true,'rare','streak','activity_streak_days'),
  ('goal_3_months','On Target x3','Hit your goal three months in a row.','target','var(--success)','goal_months',3,100,true,'rare','month','goal_months_streak'),
  ('top_conversion','Closer of the Month','Highest conversion rate last month.','percent','var(--primary)','conversion',1,110,true,'rare','month','top_conversion_month'),
  ('fastest_response','Fastest Draw','Fastest average response time last month.','zap','var(--primary)','response',1,120,true,'rare','month','fastest_response_month'),
  ('most_meetings','Most Meetings','Most meetings held last month.','users','var(--primary)','meetings',1,130,true,'uncommon','month','most_meetings_month'),
  ('big_deal_50k','Whale','A single deal over $50,000.','anchor','var(--warning)','deal_value',50000,140,true,'rare','lifetime','single_deal_value'),
  ('goasted_recovered','Back From The Dead','Won back a GOASTED account.','heart-pulse','var(--success)','accounts',1,150,true,'legendary','lifetime','goasted_recovered'),
  ('carrier_opened','Carrier Opener','Opened a new carrier relationship.','shield','var(--primary)','accounts',1,160,true,'rare','lifetime','carrier_opened'),
  ('tradeshow_closed','Show Closer','Turned a tradeshow lead into a signed job.','tent','var(--primary)','jobs',1,170,true,'rare','lifetime','tradeshow_closed'),
  ('team_goal','Team Effort','Your whole team hit the monthly goal.','users-round','var(--success)','team',1,180,true,'uncommon','month','team_goal_month'),
  ('directors_award','Director''s Award','Granted by the Sales Director for exceptional work.','crown','var(--warning)','manual',1,190,true,'legendary','manual','manual')
ON CONFLICT (key) DO UPDATE SET
  rarity = EXCLUDED.rarity,
  window_kind = EXCLUDED.window_kind,
  rule_key = EXCLUDED.rule_key,
  description = EXCLUDED.description,
  icon = EXCLUDED.icon,
  sort_order = EXCLUDED.sort_order;

-- 5. The evaluator ----------------------------------------------------------

CREATE OR REPLACE FUNCTION public.award_achievements()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  def record;
  awarded integer := 0;
  new_rows integer;
  prev_month_start date := date_trunc('month', now() - interval '1 month')::date;
  prev_month_end date := date_trunc('month', now())::date;
  prev_key text := to_char(date_trunc('month', now() - interval '1 month'), 'YYYY-MM');
BEGIN
  -- Sales roles only: chasers and crew never appear on the board or earn badges.
  CREATE TEMP TABLE _eligible ON COMMIT DROP AS
  SELECT DISTINCT ur.user_id
    FROM public.user_roles ur
   WHERE ur.role::text IN ('sales_person','outside_sales_rep','cold_caller','sales_head','sales_manager','location_manager','regional','owner','admin')
     AND NOT EXISTS (
       SELECT 1 FROM public.user_roles c
        WHERE c.user_id = ur.user_id AND c.role::text IN ('field_chaser','crew','field')
     );

  -- Signed jobs, attributed to the person who created them.
  CREATE TEMP TABLE _jobs ON COMMIT DROP AS
  SELECT j.id, j.created_by AS user_id, j.created_at, j.account_id, j.location_id,
         COALESCE(j.agreed_price, j.billed_amount, j.estimated_amount, 0)::numeric AS value
    FROM public.jobs j
   WHERE j.created_by IS NOT NULL AND j.status::text <> 'cancelled';

  FOR def IN
    SELECT * FROM public.leaderboard_achievements WHERE active AND rule_key <> 'manual'
  LOOP
    IF def.rule_key = 'jobs_signed_lifetime' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT j.user_id, def.id, 'lifetime', count(*)
        FROM _jobs j JOIN _eligible e ON e.user_id = j.user_id
       GROUP BY j.user_id HAVING count(*) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'signed_value_lifetime' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT j.user_id, def.id, 'lifetime', sum(j.value)
        FROM _jobs j JOIN _eligible e ON e.user_id = j.user_id
       GROUP BY j.user_id HAVING sum(j.value) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'single_deal_value' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT j.user_id, def.id, 'lifetime', max(j.value)
        FROM _jobs j JOIN _eligible e ON e.user_id = j.user_id
       GROUP BY j.user_id HAVING max(j.value) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'activity_streak_days' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT s.user_id, def.id, 'lifetime', s.streak
        FROM (
          SELECT d.user_id, max(d.run_len) AS streak
            FROM (
              SELECT g.user_id, count(*) AS run_len
                FROM (
                  SELECT t.created_by AS user_id, t.occurred_at::date AS day,
                         t.occurred_at::date - (dense_rank() OVER (PARTITION BY t.created_by ORDER BY t.occurred_at::date))::int AS grp
                    FROM public.touchpoints t
                   WHERE t.created_by IS NOT NULL
                   GROUP BY t.created_by, t.occurred_at::date
                ) g
               GROUP BY g.user_id, g.grp
            ) d
           GROUP BY d.user_id
        ) s
        JOIN _eligible e ON e.user_id = s.user_id
       WHERE s.streak >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'goasted_recovered' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT a.assigned_rep, def.id, 'lifetime', count(*)
        FROM public.accounts a JOIN _eligible e ON e.user_id = a.assigned_rep
       WHERE a.goasted_at IS NOT NULL AND a.stage::text IN ('active_client','won')
       GROUP BY a.assigned_rep HAVING count(*) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'carrier_opened' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT a.assigned_rep, def.id, 'lifetime', count(*)
        FROM public.accounts a JOIN _eligible e ON e.user_id = a.assigned_rep
       WHERE a.stage::text IN ('active_client','won')
         AND (COALESCE(a.account_type_detail,'') ILIKE '%carrier%'
              OR COALESCE(a.account_type_detail,'') ILIKE '%insur%'
              OR EXISTS (SELECT 1 FROM unnest(COALESCE(a.what_they_do, ARRAY[]::text[])) w
                          WHERE w ILIKE '%carrier%' OR w ILIKE '%insur%'))
       GROUP BY a.assigned_rep HAVING count(*) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'tradeshow_closed' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT j.user_id, def.id, 'lifetime', count(*)
        FROM _jobs j
        JOIN _eligible e ON e.user_id = j.user_id
        LEFT JOIN public.accounts a ON a.id = j.account_id
       WHERE a.tradeshow_id IS NOT NULL
       GROUP BY j.user_id HAVING count(*) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'most_meetings_month' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT m.user_id, def.id, prev_key, m.held
        FROM (
          SELECT t.created_by AS user_id, count(*) AS held
            FROM public.touchpoints t
           WHERE t.meeting_held IS TRUE
             AND t.occurred_at >= prev_month_start AND t.occurred_at < prev_month_end
             AND t.created_by IS NOT NULL
           GROUP BY t.created_by
        ) m
        JOIN _eligible e ON e.user_id = m.user_id
       WHERE m.held > 0
       ORDER BY m.held DESC
       LIMIT 1
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'fastest_response_month' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT r.user_id, def.id, prev_key, r.mins
        FROM (
          SELECT t.created_by AS user_id,
                 avg(EXTRACT(epoch FROM (t.replied_at - t.occurred_at)) / 60.0) AS mins,
                 count(*) AS n
            FROM public.touchpoints t
           WHERE t.replied_at IS NOT NULL AND t.created_by IS NOT NULL
             AND t.occurred_at >= prev_month_start AND t.occurred_at < prev_month_end
           GROUP BY t.created_by
        ) r
        JOIN _eligible e ON e.user_id = r.user_id
       WHERE r.n >= 3 AND r.mins IS NOT NULL
       ORDER BY r.mins ASC
       LIMIT 1
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'top_conversion_month' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT c.user_id, def.id, prev_key, round(c.rate * 100, 1)
        FROM (
          SELECT e.user_id,
                 (SELECT count(*) FROM _jobs j
                   WHERE j.user_id = e.user_id
                     AND j.created_at >= prev_month_start AND j.created_at < prev_month_end)::numeric
                 / NULLIF((SELECT count(*) FROM public.accounts a
                            WHERE a.assigned_rep = e.user_id), 0) AS rate
            FROM _eligible e
        ) c
       WHERE c.rate IS NOT NULL AND c.rate > 0
       ORDER BY c.rate DESC
       LIMIT 1
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'goal_months_streak' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT h.user_id, def.id, prev_key, count(*)
        FROM (
          SELECT g.subject_user_id AS user_id, date_trunc('month', g.starts_on)::date AS m
            FROM public.goals g
           WHERE g.is_active AND g.subject_user_id IS NOT NULL
             AND g.period_type::text = 'month'
             AND g.starts_on >= (date_trunc('month', now()) - interval '3 months')::date
             AND g.ends_on < date_trunc('month', now())::date
             AND (
               (g.metric::text = 'jobs_won' AND (
                  SELECT count(*) FROM _jobs j
                   WHERE j.user_id = g.subject_user_id
                     AND j.created_at >= g.starts_on AND j.created_at < (g.ends_on + 1)
                ) >= g.target_value)
               OR
               (g.metric::text = 'billed_value' AND (
                  SELECT COALESCE(sum(j.value), 0) FROM _jobs j
                   WHERE j.user_id = g.subject_user_id
                     AND j.created_at >= g.starts_on AND j.created_at < (g.ends_on + 1)
                ) >= g.target_value)
             )
           GROUP BY g.subject_user_id, date_trunc('month', g.starts_on)
        ) h
        JOIN _eligible e ON e.user_id = h.user_id
       GROUP BY h.user_id HAVING count(*) >= def.threshold
      ON CONFLICT DO NOTHING;

    ELSIF def.rule_key = 'team_goal_month' THEN
      INSERT INTO public.user_achievements (user_id, achievement_id, period_key, value)
      SELECT lm.user_id, def.id, prev_key, 1
        FROM public.location_members lm
        JOIN _eligible e ON e.user_id = lm.user_id
       WHERE EXISTS (
         SELECT 1
           FROM public.goals g
          WHERE g.location_id = lm.location_id
            AND g.is_active
            AND g.subject_user_id IS NULL
            AND g.period_type::text = 'month'
            AND g.starts_on >= prev_month_start AND g.ends_on < prev_month_end + 1
            AND g.metric::text = 'billed_value'
            AND (SELECT COALESCE(sum(j.value), 0) FROM _jobs j
                  WHERE j.location_id = lm.location_id
                    AND j.created_at >= prev_month_start AND j.created_at < prev_month_end)
                >= g.target_value
       )
      ON CONFLICT DO NOTHING;
    END IF;

    GET DIAGNOSTICS new_rows = ROW_COUNT;
    awarded := awarded + COALESCE(new_rows, 0);
  END LOOP;

  -- Tell everyone who just unlocked something.
  INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
  SELECT ua.user_id, 'achievement_unlocked'::notification_type,
         'Badge unlocked — ' || a.name,
         COALESCE(a.description, 'You earned a new badge.'),
         'achievement', ua.id, '/my-goals', 'normal'::notification_priority
    FROM public.user_achievements ua
    JOIN public.leaderboard_achievements a ON a.id = ua.achievement_id
   WHERE ua.created_at > now() - interval '5 minutes'
     AND NOT EXISTS (
       SELECT 1 FROM public.notifications n
        WHERE n.entity_type = 'achievement' AND n.entity_id = ua.id
     );

  RETURN awarded;
END;
$$;

GRANT EXECUTE ON FUNCTION public.award_achievements() TO authenticated, service_role;