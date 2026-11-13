-- 11 Nov: "for tasks need a text area for notes how this completed".
-- Complete on Needs-you-today now asks how the task was done; the answer is
-- kept on the task. Optional, so every existing Complete keeps working.

ALTER TABLE public.tasks
  ADD COLUMN IF NOT EXISTS completion_note text
    CHECK (completion_note IS NULL OR length(completion_note) <= 2000);

COMMENT ON COLUMN public.tasks.completion_note IS
  'How the task was completed, typed when it was ticked. Cleared on reopen.';
