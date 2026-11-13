
-- 1. Scheduled hours ------------------------------------------------------
ALTER TABLE public.markets
  ADD COLUMN IF NOT EXISTS shift_start_time time,
  ADD COLUMN IF NOT EXISTS shift_end_time time;

ALTER TABLE public.chaser_territories
  ADD COLUMN IF NOT EXISTS shift_start_time time,
  ADD COLUMN IF NOT EXISTS shift_end_time time;

ALTER TABLE public.chaser_shifts
  ADD COLUMN IF NOT EXISTS scheduled_start_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_end_at timestamptz,
  ADD COLUMN IF NOT EXISTS scheduled_minutes integer,
  ADD COLUMN IF NOT EXISTS overtime_notified_at timestamptz,
  ADD COLUMN IF NOT EXISTS overtime_escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS auto_closed_at timestamptz,
  ADD COLUMN IF NOT EXISTS needs_correction boolean NOT NULL DEFAULT false;

-- 2. Settings defaults -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.chase_settings_defaults()
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'escalation_interval_seconds', 90,
    'live_lock_grace_minutes', 15,
    'overnight_lock_hours', 4,
    'lead_decay_hours', 24,
    'dedupe_window_minutes', 60,
    'default_exclusivity', 'exclusive',
    'overnight_severity_floor', 'other',
    'search_window_days', 14,
    'search_result_limit', 20,
    'search_min_chars', 3,
    'past_lead_retention_days', 90,
    'exposure_multi_family_units', 6,
    'exposure_row_house_span', 2,
    'exposure_semi_detached_span', 1,
    'exposure_detached_nearby', 4,
    'shift_default_start_time', '08:00',
    'shift_default_end_time', '19:00',
    'overtime_reminder_minutes', 15,
    'overtime_escalate_minutes', 60,
    'shift_auto_close_hours', 16
  )
$$;

-- 3. Stamp the schedule when a shift opens ---------------------------------
CREATE OR REPLACE FUNCTION public.chaser_shift_set_schedule()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_start time;
  v_end   time;
  v_day   date := (NEW.started_at AT TIME ZONE 'UTC')::date;
  s_at timestamptz;
  e_at timestamptz;
BEGIN
  SELECT ct.shift_start_time, ct.shift_end_time INTO v_start, v_end
  FROM public.chaser_territories ct
  WHERE ct.user_id = NEW.user_id;

  IF v_start IS NULL OR v_end IS NULL THEN
    SELECT COALESCE(v_start, m.shift_start_time), COALESCE(v_end, m.shift_end_time)
      INTO v_start, v_end
    FROM public.chaser_territories ct
    JOIN public.markets m ON m.id = ct.market_id
    WHERE ct.user_id = NEW.user_id;
  END IF;

  v_start := COALESCE(v_start, (public.chase_settings() ->> 'shift_default_start_time')::time);
  v_end   := COALESCE(v_end,   (public.chase_settings() ->> 'shift_default_end_time')::time);

  IF v_start IS NULL OR v_end IS NULL THEN
    RETURN NEW;
  END IF;

  s_at := (v_day + v_start) AT TIME ZONE 'UTC';
  e_at := (v_day + v_end) AT TIME ZONE 'UTC';
  IF e_at <= s_at THEN
    e_at := e_at + interval '1 day';
  END IF;
  -- Someone clocking in after their scheduled end is on the next window.
  IF NEW.started_at > e_at THEN
    s_at := s_at + interval '1 day';
    e_at := e_at + interval '1 day';
  END IF;

  NEW.scheduled_start_at := COALESCE(NEW.scheduled_start_at, s_at);
  NEW.scheduled_end_at   := COALESCE(NEW.scheduled_end_at, e_at);
  NEW.scheduled_minutes  := COALESCE(
    NEW.scheduled_minutes,
    (EXTRACT(EPOCH FROM (e_at - s_at)) / 60)::int
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chaser_shift_set_schedule ON public.chaser_shifts;
CREATE TRIGGER trg_chaser_shift_set_schedule
BEFORE INSERT ON public.chaser_shifts
FOR EACH ROW EXECUTE FUNCTION public.chaser_shift_set_schedule();

-- 4. Overtime sweep --------------------------------------------------------
CREATE OR REPLACE FUNCTION public.chase_shift_overtime_sweep()
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s record;
  mgr record;
  reminder_min int := public.chase_setting_num('overtime_reminder_minutes', 15)::int;
  escalate_min int := public.chase_setting_num('overtime_escalate_minutes', 60)::int;
  auto_hours   numeric := public.chase_setting_num('shift_auto_close_hours', 16);
  reminded int := 0;
  escalated int := 0;
  closed int := 0;
  over_min int;
  who text;
BEGIN
  FOR s IN
    SELECT cs.*, p.full_name
    FROM public.chaser_shifts cs
    LEFT JOIN public.profiles p ON p.user_id = cs.user_id
    WHERE cs.ended_at IS NULL
  LOOP
    who := COALESCE(s.full_name, 'A chaser');

    -- Auto clock-out safeguard
    IF now() - s.started_at >= make_interval(mins => (auto_hours * 60)::int) THEN
      UPDATE public.chaser_shifts
         SET ended_at = now(),
             auto_closed_at = now(),
             needs_correction = true
       WHERE id = s.id;
      closed := closed + 1;

      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        s.user_id, 'automation_escalation',
        'Shift closed automatically',
        'Your chase shift ran over ' || auto_hours || ' hours and was closed automatically. Your manager can correct the end time.',
        'chaser_shift', s.id, '/chase', 'high'
      );

      FOR mgr IN
        SELECT lm.user_id FROM public.location_members lm
        WHERE lm.location_id = s.location_id AND lm.role IN ('manager', 'owner')
      LOOP
        INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
        VALUES (
          mgr.user_id, 'automation_escalation',
          'Chase shift auto-closed — correction needed',
          who || '''s shift ran over ' || auto_hours || ' hours and was closed automatically. Review and correct the end time.',
          'chaser_shift', s.id, '/chase', 'high'
        );
      END LOOP;
      CONTINUE;
    END IF;

    IF s.scheduled_end_at IS NULL OR now() <= s.scheduled_end_at THEN
      CONTINUE;
    END IF;

    over_min := (EXTRACT(EPOCH FROM (now() - s.scheduled_end_at)) / 60)::int;

    -- Repeating clock-out reminder
    IF s.overtime_notified_at IS NULL
       OR now() - s.overtime_notified_at >= make_interval(mins => GREATEST(reminder_min, 1)) THEN
      INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
      VALUES (
        s.user_id, 'automation_escalation',
        'Shift ended — clock out?',
        'Your shift ended ' || over_min || ' minutes ago. Clock out when you are done.',
        'chaser_shift', s.id, '/chase', 'high'
      );
      UPDATE public.chaser_shifts SET overtime_notified_at = now() WHERE id = s.id;
      reminded := reminded + 1;
    END IF;

    -- One-time manager escalation
    IF s.overtime_escalated_at IS NULL AND over_min >= escalate_min THEN
      FOR mgr IN
        SELECT lm.user_id FROM public.location_members lm
        WHERE lm.location_id = s.location_id AND lm.role IN ('manager', 'owner')
      LOOP
        INSERT INTO public.notifications (user_id, type, title, body, entity_type, entity_id, href, priority)
        VALUES (
          mgr.user_id, 'automation_escalation',
          'Chaser still on shift past hours',
          who || ' is ' || over_min || ' minutes past their scheduled shift end and is still clocked in.',
          'chaser_shift', s.id, '/chase', 'high'
        );
      END LOOP;
      UPDATE public.chaser_shifts SET overtime_escalated_at = now() WHERE id = s.id;
      escalated := escalated + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('reminded', reminded, 'escalated', escalated, 'auto_closed', closed);
END;
$$;

REVOKE ALL ON FUNCTION public.chase_shift_overtime_sweep() FROM public;
GRANT EXECUTE ON FUNCTION public.chase_shift_overtime_sweep() TO authenticated, service_role;
