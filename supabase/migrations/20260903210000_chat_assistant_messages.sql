-- Polaris answers inside internal chat.
--
-- When someone writes "@polaris <question>" in a conversation, a server
-- function runs a Polaris turn scoped to THAT user's permissions and posts the
-- answer back into the same conversation for every member to read.
--
-- The answer keeps sender_id = the asking user, because sender_id must be a
-- real profile (messages_sender_id_profiles_fkey) and because the asker is who
-- the answer is attributed to for audit and scope. What makes it Polaris is
-- author_kind = 'assistant'. Only the service role can write that value: the
-- member insert policy pins author_kind to 'user', so a client cannot post a
-- message dressed up as Polaris, and a trigger stops author_kind from being
-- flipped afterwards. Reads follow the existing membership policy untouched.
--
-- Re-runnable.

ALTER TABLE public.messages
  ADD COLUMN IF NOT EXISTS author_kind text NOT NULL DEFAULT 'user';

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_author_kind_check;
ALTER TABLE public.messages
  ADD CONSTRAINT messages_author_kind_check CHECK (author_kind IN ('user', 'assistant'));

-- Members may only ever author as themselves.
DROP POLICY IF EXISTS "Members send messages" ON public.messages;
CREATE POLICY "Members send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND author_kind = 'user'
    AND public.is_conversation_member(conversation_id, auth.uid())
  );

-- author_kind is immutable, and a Polaris answer can be retracted (soft-deleted
-- by the person who asked, whose sender_id it carries) but never rewritten.
CREATE OR REPLACE FUNCTION public.guard_message_author_kind()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF NEW.author_kind IS DISTINCT FROM OLD.author_kind THEN
    RAISE EXCEPTION 'author_kind cannot be changed';
  END IF;
  IF OLD.author_kind = 'assistant'
     AND NOT (NEW.deleted_at IS NOT NULL AND NEW.body IS NULL)
     AND (NEW.body IS DISTINCT FROM OLD.body OR NEW.edited_at IS DISTINCT FROM OLD.edited_at)
  THEN
    RAISE EXCEPTION 'assistant messages can be retracted, not edited';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_guard_message_author_kind ON public.messages;
CREATE TRIGGER trg_guard_message_author_kind
  BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_message_author_kind();

-- One answer per mention: the server looks this up before running a turn.
CREATE INDEX IF NOT EXISTS idx_msg_assistant_mention
  ON public.messages ((metadata->>'mention_message_id'))
  WHERE author_kind = 'assistant';
