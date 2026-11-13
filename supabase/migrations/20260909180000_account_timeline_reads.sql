-- The timeline read cache.
--
-- The AI suggestion card now reads the account's history instead of counting
-- rows. That read costs tokens, so it is generated once and stored here, keyed
-- by the account and the person who asked, together with the high-water mark
-- of the timeline it was computed from. Opening the page again re-uses this
-- row; the model is only called again once the timeline has actually moved.
--
-- Per person, not per desk, for the same reason `account_focus_dismissals` is:
-- RLS decides what a given user can see on the timeline, so a read computed
-- under one person's visibility must never be served to another.
--
-- Re-runnable.

CREATE TABLE IF NOT EXISTS public.account_timeline_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- Hash of the exact digest the read was produced from. Equal hash means the
  -- timeline has not moved and there is nothing new for a model to notice.
  fingerprint text NOT NULL,
  -- The same mark in human terms, for support and for the "read up to" line.
  latest_entry_at timestamptz,
  entry_count integer NOT NULL DEFAULT 0,
  -- 'ok' — a read was produced (items may still be empty: nothing stood out).
  -- 'insufficient' — too little history to say anything grounded.
  status text NOT NULL DEFAULT 'ok',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  model text,
  generated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, user_id)
);

ALTER TABLE public.account_timeline_reads
  ADD COLUMN IF NOT EXISTS fingerprint text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS latest_entry_at timestamptz,
  ADD COLUMN IF NOT EXISTS entry_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'ok',
  ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS model text,
  ADD COLUMN IF NOT EXISTS generated_at timestamptz NOT NULL DEFAULT now();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'account_timeline_reads_status_check'
  ) THEN
    ALTER TABLE public.account_timeline_reads
      ADD CONSTRAINT account_timeline_reads_status_check
      CHECK (status IN ('ok', 'insufficient'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS account_timeline_reads_account_idx
  ON public.account_timeline_reads (account_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.account_timeline_reads TO authenticated;
GRANT ALL ON public.account_timeline_reads TO service_role;

ALTER TABLE public.account_timeline_reads ENABLE ROW LEVEL SECURITY;

-- A read is the reader's own. Nobody else sees it, because nobody else is
-- guaranteed to have been able to see the history it was built from.
DROP POLICY IF EXISTS "own timeline reads" ON public.account_timeline_reads;
CREATE POLICY "own timeline reads"
  ON public.account_timeline_reads FOR ALL TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

COMMENT ON TABLE public.account_timeline_reads IS
  'Cached AI read of an account timeline, per account per user. Regenerated only when fingerprint no longer matches the current timeline.';
