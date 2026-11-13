-- next_job_number(): the local variable and the column are both `scope_key`.
--
-- WRITTEN, NOT APPLIED. One function is replaced. No table, column, policy,
-- trigger, grant or ownership change, and nothing is dropped.
--
-- THE SYMPTOM. Creating a job fails with:
--
--   column reference "scope_key" is ambiguous
--
-- THE CAUSE. `public.next_job_number()` (20260805193344) declares a PL/pgSQL
-- local called `scope_key`, and `public.job_number_counters` has a COLUMN of
-- the same name. They meet in one statement:
--
--   INSERT INTO public.job_number_counters (scope_key, last_value)
--   VALUES (scope_key, 1)
--   ON CONFLICT (scope_key) DO UPDATE SET last_value = ... + 1
--   RETURNING last_value INTO n;
--
-- `ON CONFLICT (scope_key)` is an index-inference clause, so the target
-- table's columns are in scope there. PL/pgSQL also has a variable of that
-- name, and under the default `plpgsql.variable_conflict = error` it refuses to
-- choose — which is the right behaviour, because the two readings mean
-- completely different things: the COLUMN names the unique index to arbitrate
-- on, while the VARIABLE is the value being inserted.
--
-- WHY IT SURFACED ONLY NOW. Two reasons, and both are worth knowing.
--
--   1. Until 20260914090000 nobody could reach this code at all. The trigger
--      that calls it ran as the invoking user, who had no EXECUTE on the
--      function, so every insert died earlier with 42501. Fixing that exposed
--      the next fault along the same path. This is a SECOND defect on the job
--      creation path, not a regression introduced by that fix.
--   2. The statement only runs when `job_number_settings` HAS a row. With the
--      table empty the function returns from the early branch:
--
--        IF NOT FOUND THEN RETURN 'GS-' || ... nextval(...) ... END IF;
--
--      so the INSERT is never compiled at run time and the ambiguity never
--      fires. Staging has a settings row; a database without one would look
--      perfectly healthy. The regression test added alongside this migration
--      covers BOTH paths for exactly that reason — the first version of it
--      only exercised the empty-settings branch and passed against the bug.
--
-- THE FIX. Rename the local to `v_scope_key`. That is the whole change.
-- Once no variable is called `scope_key`, every remaining mention of that name
-- can only be the column, so:
--
--   * `INSERT INTO public.job_number_counters (scope_key, last_value)` — the
--     column list, unchanged, and never ambiguous (identifier position).
--   * `VALUES (v_scope_key, 1)` — unambiguously the variable's value.
--   * `ON CONFLICT (scope_key)` — UNAMBIGUOUSLY THE COLUMN, which is what this
--     clause has always needed to mean. It still infers the same
--     `job_number_counters_pkey` on `scope_key`, so conflict handling is
--     byte-for-byte the behaviour that was intended.
--
-- Qualifying the references instead would also compile, but a variable that
-- shares a column's name is a trap that the next person has to re-derive. The
-- `v_` prefix removes the collision rather than working around it.
--
-- NOTHING ELSE CHANGES. Checked name by name against the two tables —
-- `job_number_counters` is (scope_key, last_value) and `job_number_settings` is
-- (id, prefix, pattern, seq_padding, seq_scope, updated_by, updated_at). The
-- function's other locals are `s`, `n` and `out_text`; none matches a column of
-- either table, so `scope_key` was the only collision. Every number-formatting
-- line is verbatim: the same early return, the same scope CASE, the same
-- {YYYY}/{YY}/{MM}/{DD}/{SEQ} replacements in the same order, the same
-- `lpad(n::text, s.seq_padding, '0')`, the same `s.prefix || out_text`. Job
-- numbers already issued keep their shape and the counter is untouched.
--
-- SECURITY DEFINER and `SET search_path = public` are carried over EXACTLY as
-- defined in 20260805193344. This migration does not grant EXECUTE to anybody:
-- `next_job_number()` stays revoked from `anon` and `authenticated`, reachable
-- only through `jobs_before_write()`, per 20260914090000.
--
-- RE-RUNNABLE. CREATE OR REPLACE only; applying twice is identical to once.

CREATE OR REPLACE FUNCTION public.next_job_number()
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  s public.job_number_settings%ROWTYPE;
  v_scope_key text;
  n integer;
  out_text text;
BEGIN
  SELECT * INTO s FROM public.job_number_settings WHERE id;
  IF NOT FOUND THEN
    RETURN 'GS-' || to_char(now(),'YYYY') || '-' || lpad(nextval('public.jobs_number_seq')::text, 5, '0');
  END IF;

  v_scope_key := CASE s.seq_scope
    WHEN 'daily' THEN to_char(now(),'YYYYMMDD')
    WHEN 'monthly' THEN to_char(now(),'YYYYMM')
    WHEN 'yearly' THEN to_char(now(),'YYYY')
    ELSE 'global' END;

  INSERT INTO public.job_number_counters (scope_key, last_value)
  VALUES (v_scope_key, 1)
  ON CONFLICT (scope_key) DO UPDATE SET last_value = public.job_number_counters.last_value + 1
  RETURNING last_value INTO n;

  out_text := s.pattern;
  out_text := replace(out_text, '{YYYY}', to_char(now(),'YYYY'));
  out_text := replace(out_text, '{YY}', to_char(now(),'YY'));
  out_text := replace(out_text, '{MM}', to_char(now(),'MM'));
  out_text := replace(out_text, '{DD}', to_char(now(),'DD'));
  out_text := replace(out_text, '{SEQ}', lpad(n::text, s.seq_padding, '0'));
  RETURN s.prefix || out_text;
END $$;

COMMENT ON FUNCTION public.next_job_number() IS
  'Allocates the next job number from job_number_settings + job_number_counters. Called only by jobs_before_write(); stays revoked from anon and authenticated so end users cannot burn numbers directly. Local is v_scope_key so it cannot collide with job_number_counters.scope_key. See 20260914100000.';
