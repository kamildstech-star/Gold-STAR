-- =========================================================
-- PART 2 — Chat + storage RLS
-- =========================================================

CREATE TYPE public.conversation_kind AS ENUM ('direct', 'group');
CREATE TYPE public.attachment_kind AS ENUM ('image', 'audio', 'video', 'file');

-- conversations -------------------------------------------------------------

CREATE TABLE public.conversations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind                 conversation_kind NOT NULL,
  title                text,
  avatar_path          text,
  created_by           uuid NOT NULL,
  last_message_at      timestamptz NOT NULL DEFAULT now(),
  last_message_preview text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversations_last_message ON public.conversations(last_message_at DESC);

GRANT SELECT, INSERT, UPDATE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

-- conversation_members ------------------------------------------------------

CREATE TABLE public.conversation_members (
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL,
  joined_at       timestamptz NOT NULL DEFAULT now(),
  last_read_at    timestamptz NOT NULL DEFAULT now(),
  muted           boolean NOT NULL DEFAULT false,
  is_admin        boolean NOT NULL DEFAULT false,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX idx_cm_user ON public.conversation_members(user_id);
CREATE INDEX idx_cm_conv ON public.conversation_members(conversation_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_members TO authenticated;
GRANT ALL ON public.conversation_members TO service_role;
ALTER TABLE public.conversation_members ENABLE ROW LEVEL SECURITY;

-- messages ------------------------------------------------------------------

CREATE TABLE public.messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  sender_id            uuid NOT NULL,
  body                 text,
  reply_to_message_id  uuid REFERENCES public.messages(id),
  shared_record_type   text CHECK (shared_record_type IS NULL OR shared_record_type IN ('lead','job','account')),
  shared_record_id     uuid,
  sent_at              timestamptz NOT NULL DEFAULT now(),
  edited_at            timestamptz,
  deleted_at           timestamptz,
  metadata             jsonb NOT NULL DEFAULT '{}'::jsonb   -- reserved for future per-message translation cache
);
CREATE INDEX idx_msg_conv_sent_desc ON public.messages(conversation_id, sent_at DESC);
CREATE INDEX idx_msg_sender ON public.messages(sender_id);
CREATE INDEX idx_msg_body_search ON public.messages USING gin (to_tsvector('english', COALESCE(body, '')));

GRANT SELECT, INSERT, UPDATE ON public.messages TO authenticated;  -- no DELETE: soft-delete only
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

-- message_attachments -------------------------------------------------------

CREATE TABLE public.message_attachments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  kind              attachment_kind NOT NULL,
  storage_path      text NOT NULL,
  mime              text,
  size_bytes        bigint,
  duration_seconds  numeric,
  width             int,
  height            int,
  thumbnail_path    text,
  waveform_peaks    jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_att_msg ON public.message_attachments(message_id);

GRANT SELECT, INSERT, DELETE ON public.message_attachments TO authenticated;
GRANT ALL ON public.message_attachments TO service_role;
ALTER TABLE public.message_attachments ENABLE ROW LEVEL SECURITY;

-- message_reactions ---------------------------------------------------------

CREATE TABLE public.message_reactions (
  message_id  uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL,
  emoji       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX idx_react_msg ON public.message_reactions(message_id);

GRANT SELECT, INSERT, DELETE ON public.message_reactions TO authenticated;
GRANT ALL ON public.message_reactions TO service_role;
ALTER TABLE public.message_reactions ENABLE ROW LEVEL SECURITY;

-- message_receipts ----------------------------------------------------------

CREATE TABLE public.message_receipts (
  message_id    uuid NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL,
  delivered_at  timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz,
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX idx_receipts_msg ON public.message_receipts(message_id);
CREATE INDEX idx_receipts_user_unread ON public.message_receipts(user_id) WHERE read_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON public.message_receipts TO authenticated;
GRANT ALL ON public.message_receipts TO service_role;
ALTER TABLE public.message_receipts ENABLE ROW LEVEL SECURITY;

-- Membership helper: SECURITY DEFINER so it can be called from every
-- membership-derived policy without recursion.

CREATE OR REPLACE FUNCTION public.is_conversation_member(_conv uuid, _user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.conversation_members
    WHERE conversation_id = _conv AND user_id = _user
  )
$$;

REVOKE ALL ON FUNCTION public.is_conversation_member(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_conversation_member(uuid, uuid) TO authenticated;

-- POLICIES ------------------------------------------------------------------

-- conversations
CREATE POLICY "Members read conversations" ON public.conversations
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(id, auth.uid()));

CREATE POLICY "Anyone can create a conversation they own" ON public.conversations
  FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid());

CREATE POLICY "Members update conversation metadata" ON public.conversations
  FOR UPDATE TO authenticated
  USING (public.is_conversation_member(id, auth.uid()))
  WITH CHECK (public.is_conversation_member(id, auth.uid()));

-- conversation_members
CREATE POLICY "Members read own memberships" ON public.conversation_members
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(conversation_id, auth.uid()));

CREATE POLICY "Creator or member can add memberships" ON public.conversation_members
  FOR INSERT TO authenticated
  WITH CHECK (
    public.is_conversation_member(conversation_id, auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.conversations c
      WHERE c.id = conversation_id AND c.created_by = auth.uid()
    )
  );

CREATE POLICY "User updates own membership" ON public.conversation_members
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "User leaves conversation" ON public.conversation_members
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- messages
CREATE POLICY "Members read messages" ON public.messages
  FOR SELECT TO authenticated
  USING (public.is_conversation_member(conversation_id, auth.uid()));

CREATE POLICY "Members send messages" ON public.messages
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_id = auth.uid()
    AND public.is_conversation_member(conversation_id, auth.uid())
  );

CREATE POLICY "Sender edits own message" ON public.messages
  FOR UPDATE TO authenticated
  USING (sender_id = auth.uid())
  WITH CHECK (sender_id = auth.uid());
-- No DELETE policy: hard delete is disallowed. Soft-delete sets deleted_at via UPDATE.

-- message_attachments
CREATE POLICY "Members read attachments" ON public.message_attachments
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conversation_member(m.conversation_id, auth.uid())
    )
  );
CREATE POLICY "Sender inserts attachments" ON public.message_attachments
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND m.sender_id = auth.uid()
        AND public.is_conversation_member(m.conversation_id, auth.uid())
    )
  );
CREATE POLICY "Sender removes own attachment" ON public.message_attachments
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id AND m.sender_id = auth.uid()
    )
  );

-- message_reactions
CREATE POLICY "Members read reactions" ON public.message_reactions
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conversation_member(m.conversation_id, auth.uid())
    )
  );
CREATE POLICY "Users add own reactions" ON public.message_reactions
  FOR INSERT TO authenticated
  WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conversation_member(m.conversation_id, auth.uid())
    )
  );
CREATE POLICY "Users remove own reactions" ON public.message_reactions
  FOR DELETE TO authenticated
  USING (user_id = auth.uid());

-- message_receipts
CREATE POLICY "Members read receipts" ON public.message_receipts
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.messages m
      WHERE m.id = message_id
        AND public.is_conversation_member(m.conversation_id, auth.uid())
    )
  );
CREATE POLICY "Users insert own receipts" ON public.message_receipts
  FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid());
CREATE POLICY "Users update own receipts" ON public.message_receipts
  FOR UPDATE TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Trigger: keep conversations.last_message_* fresh on every new message.

CREATE OR REPLACE FUNCTION public.bump_conversation_on_message()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.conversations
     SET last_message_at      = NEW.sent_at,
         last_message_preview = LEFT(COALESCE(NEW.body, ''), 200),
         updated_at           = now()
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END $$;

CREATE TRIGGER trg_bump_conversation
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.bump_conversation_on_message();

-- Realtime publication
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_receipts;
ALTER PUBLICATION supabase_realtime ADD TABLE public.message_reactions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.conversations;

-- Storage policies: bucket 'chat-attachments' is created separately via the
-- storage tool. Path convention: {conversation_id}/{message_id}/{filename}
-- The uuid cast is guarded by a regex on the leading path segment.

CREATE POLICY "Chat attachments: members read"
  ON storage.objects FOR SELECT TO authenticated
  USING (
    bucket_id = 'chat-attachments'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    AND public.is_conversation_member(
      (SPLIT_PART(name, '/', 1))::uuid,
      auth.uid()
    )
  );

CREATE POLICY "Chat attachments: members upload"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'chat-attachments'
    AND name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/'
    AND public.is_conversation_member(
      (SPLIT_PART(name, '/', 1))::uuid,
      auth.uid()
    )
    AND owner = auth.uid()
  );

CREATE POLICY "Chat attachments: uploader deletes own"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'chat-attachments' AND owner = auth.uid());

-- Part 1 tightening: owner as well as admin --------------------------------

DROP POLICY IF EXISTS "tags_write_admin" ON public.tags;
CREATE POLICY "tags_write_privileged"
  ON public.tags FOR ALL TO authenticated
  USING (public.is_privileged(auth.uid()))
  WITH CHECK (public.is_privileged(auth.uid()));

DROP POLICY IF EXISTS "Admins view sync_runs" ON public.sync_runs;
CREATE POLICY "Privileged view sync_runs"
  ON public.sync_runs FOR SELECT TO authenticated
  USING (public.is_privileged(auth.uid()));