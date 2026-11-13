import { sharedRecordPath, type SharedRecordType, type SharePickerType } from "@/lib/chat-records";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CheckCheck,
  Download,
  FileText,
  Image as ImageIcon,
  Loader2,
  Mic,
  Paperclip,
  PenLine,
  Play,
  Pause,
  Reply,
  Send,
  SmilePlus,
  Trash2,
  X,
  Link2,
  ExternalLink,
} from "lucide-react";
import { Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { AssistantMarkdown } from "@/components/assistant-markdown";
import { PolarisMark } from "@/components/polaris-mark";
import { askPolarisInChat } from "@/lib/chat-assistant.functions";
import {
  ASSISTANT_HANDLE,
  completeMention,
  hasAssistantMention,
  mentionQueryAtCaret,
} from "@/lib/chat-mention";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  attachmentFileName,
  chatTime,
  computeTick,
  dayLabel,
  displayBody,
  formatBytes,
  formatDuration,
  groupMessages,
  isAssistantMessage,
  isItemMessage,
  itemLabel,
  QUICK_EMOJI,
  sameDay,
  threadNotes,
  type Conversation,
  type Message,
  type MessageAttachment,
  type MessageReaction,
  type MessageReceipt,
  type TickState,
  personLabel,
  type PersonProfile,
} from "@/lib/chat";
import { errText } from "@/lib/db-errors";

import { VoiceRecorder } from "@/lib/voice";
import { Avatar, conversationLabel } from "./chat-list";
import { ShareRecordPicker } from "./share-record-picker";
import { signStoredFile, signedUrlStaleMs } from "@/lib/signed-url";

const PAGE_SIZE = 40;
const BUCKET = "chat-attachments";

interface ChatWindowProps {
  conversationId: string;
}

interface MemberWithProfile {
  user_id: string;
  last_read_at: string;
  profile: PersonProfile | null;
}

export function ChatWindow({ conversationId }: ChatWindowProps) {
  const app = useAppContext();
  const qc = useQueryClient();

  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [presenceOnline, setPresenceOnline] = useState<Set<string>>(new Set());
  const [typingUsers, setTypingUsers] = useState<Map<string, number>>(new Map());
  const [lightbox, setLightbox] = useState<string | null>(null);
  /** Polaris turns in flight for this conversation (drives the "thinking" row). */
  const [polarisBusy, setPolarisBusy] = useState(0);
  const askPolaris = useServerFn(askPolarisInChat);

  // ---------- fetch conversation + members ----------
  const convQ = useQuery({
    queryKey: ["chat-conversation", conversationId],
    queryFn: async (): Promise<{
      conversation: Conversation;
      members: MemberWithProfile[];
    }> => {
      const [c, m] = await Promise.all([
        supabase.from("conversations").select("*").eq("id", conversationId).single(),
        supabase
          .from("conversation_members")
          .select(
            "user_id, last_read_at, profile:profiles!conversation_members_user_id_profiles_fkey(full_name)",
          )
          .eq("conversation_id", conversationId),
      ]);
      if (c.error) throw c.error;
      if (m.error) throw m.error;
      return {
        conversation: c.data as Conversation,
        members: (m.data ?? []).map((row) => ({
          user_id: row.user_id,
          last_read_at: row.last_read_at,
          profile: row.profile ?? null,
        })),
      };
    },
  });

  const otherMemberIds = useMemo(
    () => (convQ.data?.members ?? []).map((m) => m.user_id).filter((id) => id !== app.userId),
    [convQ.data, app.userId],
  );

  // ---------- messages (paginated upward) ----------
  const msgsQ = useQuery({
    queryKey: ["chat-messages", conversationId],
    queryFn: async (): Promise<Message[]> => {
      const { data, error } = await supabase
        .from("messages")
        .select("*")
        .eq("conversation_id", conversationId)
        .order("sent_at", { ascending: false })
        .limit(PAGE_SIZE);
      if (error) throw error;
      return (data ?? []).reverse();
    },
  });

  const [loadingOlder, setLoadingOlder] = useState(false);
  const [reachedTop, setReachedTop] = useState(false);
  const loadOlder = async () => {
    const cur = msgsQ.data ?? [];
    if (cur.length === 0 || loadingOlder || reachedTop) return;
    setLoadingOlder(true);
    const { data, error } = await supabase
      .from("messages")
      .select("*")
      .eq("conversation_id", conversationId)
      .lt("sent_at", cur[0].sent_at)
      .order("sent_at", { ascending: false })
      .limit(PAGE_SIZE);
    setLoadingOlder(false);
    if (error) return;
    if (!data || data.length === 0) {
      setReachedTop(true);
      return;
    }
    qc.setQueryData<Message[]>(["chat-messages", conversationId], [...data.reverse(), ...cur]);
  };

  // ---------- attachments (bulk-fetched for all visible messages) ----------
  const msgIds = (msgsQ.data ?? []).map((m) => m.id);
  const attsQ = useQuery({
    queryKey: ["chat-atts", conversationId, msgIds.join(",")],
    enabled: msgIds.length > 0,
    queryFn: async (): Promise<MessageAttachment[]> => {
      const { data, error } = await supabase
        .from("message_attachments")
        .select("*")
        .in("message_id", msgIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  // ---------- reactions + receipts ----------
  const reactionsQ = useQuery({
    queryKey: ["chat-reactions", conversationId, msgIds.join(",")],
    enabled: msgIds.length > 0,
    queryFn: async (): Promise<MessageReaction[]> => {
      const { data, error } = await supabase
        .from("message_reactions")
        .select("*")
        .in("message_id", msgIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  const receiptsQ = useQuery({
    queryKey: ["chat-receipts", conversationId, msgIds.join(",")],
    enabled: msgIds.length > 0,
    queryFn: async (): Promise<MessageReceipt[]> => {
      const { data, error } = await supabase
        .from("message_receipts")
        .select("*")
        .in("message_id", msgIds);
      if (error) throw error;
      return data ?? [];
    },
  });

  // ---------- realtime: messages, receipts, reactions ----------
  useEffect(() => {
    const ch = supabase
      .channel(`chat:${conversationId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "messages",
          filter: `conversation_id=eq.${conversationId}`,
        },
        () => {
          qc.invalidateQueries({ queryKey: ["chat-messages", conversationId] });
          qc.invalidateQueries({ queryKey: ["chat-atts", conversationId] });
        },
      )
      .on("postgres_changes", { event: "*", schema: "public", table: "message_receipts" }, () => {
        qc.invalidateQueries({ queryKey: ["chat-receipts", conversationId] });
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "message_reactions" }, () => {
        qc.invalidateQueries({ queryKey: ["chat-reactions", conversationId] });
      })
      .subscribe();
    return () => {
      supabase.removeChannel(ch);
    };
  }, [conversationId, qc]);

  // ---------- realtime presence + typing (broadcast) ----------
  useEffect(() => {
    if (!app.userId) return;
    const ch = supabase.channel(`presence:${conversationId}`, {
      config: { presence: { key: app.userId } },
    });
    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState();
      setPresenceOnline(new Set(Object.keys(state)));
    });
    ch.on("broadcast", { event: "typing" }, ({ payload }) => {
      const uid = payload?.user_id as string | undefined;
      if (!uid || uid === app.userId) return;
      setTypingUsers((prev) => {
        const copy = new Map(prev);
        copy.set(uid, Date.now());
        return copy;
      });
    });
    ch.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await ch.track({
          user_id: app.userId,
          name: app.fullName || app.email,
          online_at: new Date().toISOString(),
        });
      }
    });
    const interval = setInterval(() => {
      // expire stale typing indicators
      setTypingUsers((prev) => {
        const copy = new Map(prev);
        const now = Date.now();
        for (const [uid, ts] of prev) if (now - ts > 4000) copy.delete(uid);
        return copy;
      });
    }, 1500);
    return () => {
      clearInterval(interval);
      supabase.removeChannel(ch);
    };
  }, [conversationId, app.userId, app.fullName, app.email]);

  const emitTyping = () => {
    supabase.channel(`presence:${conversationId}`).send({
      type: "broadcast",
      event: "typing",
      payload: { user_id: app.userId },
    });
  };

  // ---------- mark messages as read on view ----------
  useEffect(() => {
    if (!app.userId || !msgsQ.data || msgsQ.data.length === 0) return;
    const now = new Date().toISOString();
    const foreignIds = msgsQ.data
      .filter((m) => m.sender_id !== app.userId && !m.id.startsWith("optimistic-"))
      .map((m) => m.id);
    if (foreignIds.length === 0) return;
    (async () => {
      await supabase.from("message_receipts").upsert(
        foreignIds.map((id) => ({
          message_id: id,
          user_id: app.userId!,
          delivered_at: now,
          read_at: now,
        })),
        { onConflict: "message_id,user_id" },
      );
      await supabase
        .from("conversation_members")
        .update({ last_read_at: now })
        .eq("conversation_id", conversationId)
        .eq("user_id", app.userId!);
      qc.invalidateQueries({ queryKey: ["chat-list"] });
    })();
  }, [msgsQ.data, app.userId, conversationId, qc]);

  // ---------- send ----------
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pending, setPending] = useState<Message[]>([]);

  /**
   * Inserts one message and resolves to its id. `replyToId` overrides the
   * composer's reply state: the composer sends a file as its own message and
   * then the typed note as a reply to that id, so the note threads under the
   * file card instead of quoting whatever the user was replying to.
   */
  const send: SendMessage = async (opts) => {
    if (!app.userId) return null;
    const replyToId = opts.replyToId === undefined ? (replyTo?.id ?? null) : opts.replyToId;
    const tempId = `optimistic-${crypto.randomUUID()}`;
    const optimistic: Message = {
      id: tempId,
      conversation_id: conversationId,
      sender_id: app.userId,
      author_kind: "user",
      body: opts.body ?? null,
      reply_to_message_id: replyToId,
      shared_record_type: opts.shared?.type ?? null,
      shared_record_id: opts.shared?.id ?? null,
      sent_at: new Date().toISOString(),
      edited_at: null,
      deleted_at: null,
      metadata: {},
      is_demo: false,
    };
    setPending((p) => [...p, optimistic]);
    setReplyTo(null);
    let insertedId: string | null = null;
    try {
      const { data: inserted, error } = await supabase
        .from("messages")
        .insert({
          conversation_id: conversationId,
          sender_id: app.userId,
          body: opts.body ?? null,
          reply_to_message_id: replyToId,
          shared_record_type: opts.shared?.type ?? null,
          shared_record_id: opts.shared?.id ?? null,
        })
        .select("*")
        .single();
      if (error) throw error;
      insertedId = inserted.id;
      if (opts.attachment) {
        const path = `${conversationId}/${inserted.id}/${crypto.randomUUID()}-${opts.attachment.fileName}`;
        const up = await supabase.storage.from(BUCKET).upload(path, opts.attachment.blob, {
          contentType: opts.attachment.mime,
          upsert: false,
        });
        if (up.error) throw up.error;
        const { error: attErr } = await supabase.from("message_attachments").insert({
          message_id: inserted.id,
          kind: opts.attachment.kind,
          storage_path: path,
          mime: opts.attachment.mime,
          size_bytes: opts.attachment.blob.size,
          duration_seconds: opts.attachment.durationSec ?? null,
          width: opts.attachment.width ?? null,
          height: opts.attachment.height ?? null,
          waveform_peaks: opts.attachment.peaks ?? null,
        });
        if (attErr) throw attErr;
      }
      // "@polaris …" runs exactly one Polaris turn, fired once from the
      // sender's client after the message is stored. The answer arrives
      // through realtime like any other message.
      if (opts.body && hasAssistantMention(opts.body)) {
        setPolarisBusy((n) => n + 1);
        askPolaris({ data: { conversationId, messageId: inserted.id } })
          .catch((e: unknown) => toast.error(`Polaris couldn't answer: ${errText(e)}`))
          .finally(() => setPolarisBusy((n) => Math.max(0, n - 1)));
      }
      // Wait for the refetch so a note sent right after a file finds the
      // file's real id in the stream and threads under it on first paint.
      await qc.invalidateQueries({ queryKey: ["chat-messages", conversationId] });
    } catch (e) {
      toast.error(`Send failed: ${(e as Error).message}`);
      return null;
    } finally {
      setPending((p) => p.filter((m) => m.id !== tempId));
    }
    return insertedId;
  };

  // ---------- scroll behaviour ----------
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Auto-scroll to bottom on first load / when a new message arrives near bottom.
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [msgsQ.data, pending, polarisBusy]);

  // ---------- handlers for scroll-up pagination ----------
  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (e.currentTarget.scrollTop < 60) {
      const heightBefore = e.currentTarget.scrollHeight;
      loadOlder().then(() => {
        // preserve scroll position after new content is prepended
        requestAnimationFrame(() => {
          if (!scrollRef.current) return;
          const diff = scrollRef.current.scrollHeight - heightBefore;
          scrollRef.current.scrollTop = diff + 60;
        });
      });
    }
  };

  // ---------- derived ----------
  const allMessages = useMemo(() => [...(msgsQ.data ?? []), ...pending], [msgsQ.data, pending]);
  const attsByMsg = useMemo(() => {
    const m = new Map<string, MessageAttachment[]>();
    for (const a of attsQ.data ?? []) {
      const arr = m.get(a.message_id) ?? [];
      arr.push(a);
      m.set(a.message_id, arr);
    }
    return m;
  }, [attsQ.data]);
  const messageById = useMemo(
    () => new Map(allMessages.map((m) => [m.id, m] as const)),
    [allMessages],
  );
  // Notes (replies sent straight after a file or shared record) leave the
  // top-level stream and render in a rail under the card they belong to.
  const threads = useMemo(
    () => threadNotes(allMessages, (m) => isItemMessage(m, attsByMsg.get(m.id) ?? [])),
    [allMessages, attsByMsg],
  );
  const grouped = useMemo(
    () => groupMessages(allMessages.filter((m) => !threads.noteIds.has(m.id))),
    [allMessages, threads],
  );
  const previewOf = (m: Message): string => {
    const atts = attsByMsg.get(m.id) ?? [];
    return isItemMessage(m, atts) ? itemLabel(m, atts) : displayBody(m);
  };
  const replyIsItem = replyTo ? isItemMessage(replyTo, attsByMsg.get(replyTo.id) ?? []) : false;

  const membersById = useMemo(() => {
    const m = new Map<string, MemberWithProfile>();
    for (const x of convQ.data?.members ?? []) m.set(x.user_id, x);
    return m;
  }, [convQ.data]);

  const title = convQ.data
    ? conversationLabel(
        {
          kind: convQ.data.conversation.kind,
          title: convQ.data.conversation.title,
          members: convQ.data.members,
        },
        app.userId,
      )
    : "Chat";

  const onlineOthers = otherMemberIds.filter((id) => presenceOnline.has(id));
  const anyTyping = Array.from(typingUsers.keys()).filter((id) => otherMemberIds.includes(id));

  if (convQ.error) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
          <div className="font-medium">Couldn't load this conversation</div>
          <p className="mt-1 break-words text-xs">{errText(convQ.error)}</p>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => convQ.refetch()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b bg-card px-4 py-3">
        <Avatar label={title} size={36} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold">{title}</div>
          <div className="text-[11px] text-muted-foreground">
            {anyTyping.length > 0
              ? "typing…"
              : onlineOthers.length > 0
                ? `${onlineOthers.length} online`
                : convQ.data
                  ? `${convQ.data.members.length} member${convQ.data.members.length === 1 ? "" : "s"}`
                  : ""}
          </div>
        </div>
      </div>

      {/* Message stream */}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto bg-muted/30 px-2 py-3"
      >
        {loadingOlder && (
          <div className="flex justify-center py-2 text-xs text-muted-foreground">
            <Loader2 className="mr-1 size-3 animate-spin" /> Loading older
          </div>
        )}
        {reachedTop && (
          <div className="py-2 text-center text-[11px] text-muted-foreground">
            Start of conversation
          </div>
        )}
        {allMessages.length === 0 && !msgsQ.isLoading && (
          <div className="flex h-full items-center justify-center px-3 text-center text-sm text-muted-foreground">
            No messages yet. Say hello.
          </div>
        )}
        {grouped.map((g, gi) => {
          const prevGroup = grouped[gi - 1];
          const showDay =
            !prevGroup ||
            !sameDay(prevGroup.items[prevGroup.items.length - 1].sent_at, g.items[0].sent_at);
          // A Polaris answer carries the asker's sender_id; it is never "own".
          const assistant = isAssistantMessage(g.items[0]);
          const isOwn = !assistant && g.sender_id === app.userId;
          const sender = membersById.get(g.sender_id);
          return (
            <div key={g.key}>
              {showDay && (
                <div className="my-3 flex items-center justify-center">
                  <span className="rounded-full bg-background/80 px-3 py-1 text-[10px] font-medium text-muted-foreground">
                    {dayLabel(g.items[0].sent_at)}
                  </span>
                </div>
              )}
              <MessageGroupBlock
                items={g.items}
                isOwn={isOwn}
                assistant={assistant}
                senderName={
                  assistant
                    ? `Polaris · asked by ${personLabel(sender?.profile)}`
                    : personLabel(sender?.profile)
                }
                currentUserId={app.userId}
                otherMemberIds={otherMemberIds}
                attsByMsg={attsByMsg}
                reactions={reactionsQ.data ?? []}
                receipts={receiptsQ.data ?? []}
                notesByItem={threads.notesByItem}
                messageById={messageById}
                previewOf={previewOf}
                onReply={setReplyTo}
                onReact={(mid, emoji) => reactTo(mid, emoji, app.userId!)}
                onDelete={(mid) => softDelete(mid, app.userId!)}
                onImageClick={setLightbox}
                membersById={membersById}
                isGroup={(convQ.data?.members.length ?? 0) > 2}
              />
            </div>
          );
        })}
        {polarisBusy > 0 && (
          <div className="mb-2 flex gap-2 px-1" aria-live="polite">
            <div className="shrink-0" style={{ width: 32 }}>
              <PolarisAvatar size={32} />
            </div>
            <div className="flex items-center gap-2 rounded-sm border border-dashed bg-card px-3 py-2 text-xs text-muted-foreground">
              <PolarisMark className="size-4 animate-pulse" /> Polaris is thinking…
            </div>
          </div>
        )}
      </div>

      {/* Composer */}
      {app.writesDisabled ? (
        <div className="border-t bg-muted/40 p-3 text-center text-xs text-muted-foreground">
          Messaging is disabled while View As is active.
        </div>
      ) : (
        <Composer
          reply={replyTo}
          replyLabel={replyTo ? previewOf(replyTo) : ""}
          replyIsItem={replyIsItem}
          onClearReply={() => setReplyTo(null)}
          onSend={send}
          onTyping={emitTyping}
        />
      )}

      {/* Lightbox */}
      <ImageLightbox path={lightbox} onClose={() => setLightbox(null)} />
    </div>
  );
}

// ------------- helpers ---------------

async function reactTo(messageId: string, emoji: string, userId: string) {
  // Toggle: if user already reacted with this emoji, remove it, else insert.
  const { data } = await supabase
    .from("message_reactions")
    .select("*")
    .eq("message_id", messageId)
    .eq("user_id", userId)
    .eq("emoji", emoji)
    .maybeSingle();
  if (data) {
    await supabase
      .from("message_reactions")
      .delete()
      .eq("message_id", messageId)
      .eq("user_id", userId)
      .eq("emoji", emoji);
  } else {
    await supabase
      .from("message_reactions")
      .insert({ message_id: messageId, user_id: userId, emoji });
  }
}

async function softDelete(messageId: string, userId: string) {
  const { error } = await supabase
    .from("messages")
    .update({ body: null, deleted_at: new Date().toISOString() })
    .eq("id", messageId)
    .eq("sender_id", userId);
  if (error) toast.error(error.message);
  else toast.success("Deleted");
}

// ------------- Message group block ---------------

/** Polaris in the avatar column, where a person's initials would be. */
function PolarisAvatar({ size = 32 }: { size?: number }) {
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full border bg-card"
      style={{ width: size, height: size }}
      aria-label="Polaris"
    >
      <PolarisMark className="size-[60%]" />
    </div>
  );
}

function MessageGroupBlock({
  items,
  isOwn,
  assistant,
  senderName,
  currentUserId,
  otherMemberIds,
  attsByMsg,
  reactions,
  receipts,
  notesByItem,
  messageById,
  previewOf,
  onReply,
  onReact,
  onDelete,
  onImageClick,
  membersById,
  isGroup,
}: {
  items: Message[];
  isOwn: boolean;
  /** The whole stack is Polaris answers (they never mix with a person's). */
  assistant: boolean;
  senderName: string;
  currentUserId: string | null;
  otherMemberIds: string[];
  attsByMsg: Map<string, MessageAttachment[]>;
  reactions: MessageReaction[];
  receipts: MessageReceipt[];
  notesByItem: Map<string, Message[]>;
  messageById: Map<string, Message>;
  previewOf: (m: Message) => string;
  onReply: (m: Message) => void;
  onReact: (mid: string, emoji: string) => void;
  onDelete: (mid: string) => void;
  onImageClick: (path: string) => void;
  membersById: Map<string, MemberWithProfile>;
  isGroup: boolean;
}) {
  const bubbleFor = (
    msg: Message,
    own: boolean,
    extra: { isLast: boolean; compact?: boolean; senderLabel?: string; onAddNote?: () => void },
  ) => {
    const rcpts = receipts.filter((r) => r.message_id === msg.id);
    const replyMsg = msg.reply_to_message_id
      ? (messageById.get(msg.reply_to_message_id) ?? null)
      : null;
    return (
      <MessageBubble
        key={msg.id}
        msg={msg}
        atts={attsByMsg.get(msg.id) ?? []}
        rxns={reactions.filter((r) => r.message_id === msg.id)}
        tick={computeTick(msg, own, otherMemberIds, rcpts)}
        isOwn={own}
        assistant={isAssistantMessage(msg)}
        isLast={extra.isLast}
        compact={extra.compact}
        senderLabel={extra.senderLabel}
        onAddNote={extra.onAddNote}
        onReply={() => onReply(msg)}
        onReact={(emoji) => onReact(msg.id, emoji)}
        onDelete={() => onDelete(msg.id)}
        onImageClick={onImageClick}
        replyMsg={replyMsg}
        replyPreview={replyMsg ? previewOf(replyMsg) : ""}
        membersById={membersById}
      />
    );
  };

  return (
    <div className={cn("mb-2 flex gap-2 px-1", isOwn ? "flex-row-reverse" : "")}>
      <div className="shrink-0" style={{ width: 32 }}>
        {assistant ? (
          <PolarisAvatar size={32} />
        ) : (
          !isOwn && <Avatar label={senderName} size={32} />
        )}
      </div>
      <div className={cn("flex min-w-0 max-w-[76%] flex-col gap-0.5", isOwn && "items-end")}>
        {!isOwn && (isGroup || assistant) && (
          <div className="px-1 text-[11px] font-medium text-primary">{senderName}</div>
        )}
        {items.map((msg, i) => {
          const isLast = i === items.length - 1;
          if (!isItemMessage(msg, attsByMsg.get(msg.id) ?? [])) {
            return bubbleFor(msg, isOwn, { isLast });
          }
          const notes = notesByItem.get(msg.id) ?? [];
          return (
            <div key={msg.id} className={cn("flex w-full flex-col gap-0.5", isOwn && "items-end")}>
              {bubbleFor(msg, isOwn, {
                isLast: isLast && notes.length === 0,
                onAddNote: () => onReply(msg),
              })}
              {notes.length > 0 && (
                <div
                  className={cn(
                    "flex w-full flex-col gap-1 py-0.5",
                    isOwn
                      ? "border-r-2 border-primary/40 pr-2"
                      : "border-l-2 border-primary/40 pl-2",
                  )}
                >
                  {notes.map((n) => {
                    const own = n.sender_id === currentUserId;
                    return (
                      <div
                        key={n.id}
                        className={cn("flex w-full", own ? "justify-end" : "justify-start")}
                      >
                        {bubbleFor(n, own, {
                          isLast: false,
                          compact: true,
                          senderLabel:
                            n.sender_id !== msg.sender_id
                              ? personLabel(membersById.get(n.sender_id)?.profile)
                              : undefined,
                        })}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({
  msg,
  atts,
  rxns,
  tick,
  isOwn,
  isLast,
  onReply,
  onReact,
  onDelete,
  onImageClick,
  replyMsg,
  replyPreview,
  membersById,
  compact = false,
  senderLabel,
  onAddNote,
  assistant = false,
}: {
  msg: Message;
  atts: MessageAttachment[];
  rxns: MessageReaction[];
  tick: TickState | null;
  isOwn: boolean;
  /** A Polaris answer: gold-edged card, markdown body, no ticks or notes. */
  assistant?: boolean;
  isLast: boolean;
  onReply: () => void;
  onReact: (emoji: string) => void;
  onDelete: () => void;
  onImageClick: (path: string) => void;
  replyMsg: Message | null;
  replyPreview: string;
  membersById: Map<string, MemberWithProfile>;
  /** A note in the rail under a file: smaller, no tail, no quote (the rail is the link). */
  compact?: boolean;
  /** Shown above the text when the note's author differs from the card's. */
  senderLabel?: string;
  /** Present on file and record cards; composes a reply that threads underneath. */
  onAddNote?: () => void;
}) {
  const [showActions, setShowActions] = useState(false);
  const deleted = !!msg.deleted_at;
  // A shared record's body is the auto-generated "Shared job: J-100" label. It
  // feeds the chat-list preview and reply quotes, but the card already says it.
  const autoLabel =
    !!msg.shared_record_type && !!msg.body?.startsWith(`Shared ${msg.shared_record_type}:`);
  const body = deleted ? displayBody(msg) : autoLabel ? "" : (msg.body ?? "");

  const tail =
    isLast &&
    !compact &&
    (isOwn
      ? "after:absolute after:right-[-6px] after:bottom-0 after:size-3 after:rounded-bl-full after:bg-primary"
      : "after:absolute after:left-[-6px] after:bottom-0 after:size-3 after:rounded-br-full after:bg-card");

  return (
    <div
      className="group relative"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
      <div
        id={`msg-${msg.id}`}
        className={cn(
          "relative rounded-sm px-3 py-2 text-sm",
          compact && "px-2.5 py-1.5 text-[13px]",
          isOwn
            ? "rounded-br-md bg-primary text-primary-foreground"
            : "rounded-bl-md bg-card text-card-foreground border",
          assistant && "border-l-2 border-l-[var(--brand-gold)] bg-card",
          tail,
        )}
      >
        {senderLabel && (
          <div
            className={cn(
              "mb-0.5 text-[11px] font-medium",
              isOwn ? "text-primary-foreground/80" : "text-primary",
            )}
          >
            {senderLabel}
          </div>
        )}
        {replyMsg && !compact && (
          <button
            type="button"
            className={cn(
              "mb-1.5 block w-full rounded-sm border-l-2 px-2 py-1 text-left text-xs",
              isOwn
                ? "border-primary-foreground/60 bg-primary-foreground/10"
                : "border-primary bg-muted/60",
            )}
            onClick={() => {
              const el = document.getElementById(`msg-${replyMsg.id}`);
              el?.scrollIntoView({ behavior: "smooth", block: "center" });
              el?.animate(
                [{ background: "hsl(var(--primary)/0.2)" }, { background: "transparent" }],
                { duration: 1000 },
              );
            }}
          >
            <div className="truncate opacity-70">
              {personLabel(membersById.get(replyMsg.sender_id)?.profile)}
            </div>
            <div className="truncate">{replyPreview}</div>
          </button>
        )}

        {msg.shared_record_type && msg.shared_record_id && (
          <SharedRecordCard
            type={msg.shared_record_type as SharedRecordType}
            id={msg.shared_record_id}
            isOwn={isOwn}
          />
        )}

        {atts.map((a) => (
          <AttachmentView key={a.id} att={a} isOwn={isOwn} onImageClick={onImageClick} />
        ))}

        {body && assistant && !deleted ? (
          <div className="min-w-0 max-w-prose overflow-x-auto">
            <AssistantMarkdown content={body} />
          </div>
        ) : (
          body && (
            <div className={cn("whitespace-pre-wrap break-words", deleted && "italic opacity-70")}>
              {body}
            </div>
          )
        )}

        <div
          className={cn(
            "mt-0.5 flex items-center justify-end gap-2 text-[10px]",
            isOwn ? "text-primary-foreground/80" : "text-muted-foreground",
          )}
        >
          {onAddNote && !deleted && !assistant && (
            <button
              type="button"
              onClick={onAddNote}
              className="mr-auto inline-flex items-center gap-1 text-[11px] font-medium hover:underline"
            >
              <PenLine className="size-3" /> Add note
            </button>
          )}
          <span className="font-mono tabular-nums">{chatTime(msg.sent_at)}</span>
          {isOwn && <TickIcon state={tick} />}
        </div>
      </div>

      {rxns.length > 0 && (
        <ReactionsBar rxns={rxns} isOwn={isOwn} onToggle={onReact} membersById={membersById} />
      )}

      {showActions && !deleted && (
        <div
          className={cn(
            "absolute top-0 flex -translate-y-1/2 items-center gap-0.5 rounded-full border bg-background px-1 py-0.5",
            isOwn ? "left-0 -translate-x-full pr-1" : "right-0 translate-x-full pl-1",
          )}
        >
          <Popover>
            <PopoverTrigger asChild>
              <Button size="icon" variant="ghost" className="size-6">
                <SmilePlus className="size-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-1">
              <div className="flex gap-1">
                {QUICK_EMOJI.map((e) => (
                  <button
                    key={e}
                    type="button"
                    onClick={() => onReact(e)}
                    className="rounded p-1 text-lg hover:bg-accent"
                  >
                    {e}
                  </button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button size="icon" variant="ghost" className="size-6" onClick={onReply}>
            <Reply className="size-3.5" />
          </Button>
          {isOwn && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" className="size-6">
                  <Trash2 className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={onDelete}>Delete for everyone</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      )}
    </div>
  );
}

function TickIcon({ state }: { state: TickState | null }) {
  if (!state) return null;
  if (state === "sending") return <Loader2 className="size-3 animate-spin opacity-70" />;
  if (state === "sent") return <Check className="size-3 opacity-80" />;
  if (state === "delivered") return <CheckCheck className="size-3 opacity-80" />;
  // read - blue-ish tint
  return (
    <CheckCheck className="size-3 text-info-foreground" style={{ color: "oklch(0.78 0.14 240)" }} />
  );
}

function ReactionsBar({
  rxns,
  isOwn,
  onToggle,
  membersById,
}: {
  rxns: MessageReaction[];
  isOwn: boolean;
  onToggle: (emoji: string) => void;
  membersById: Map<string, MemberWithProfile>;
}) {
  const grouped = new Map<string, MessageReaction[]>();
  for (const r of rxns) {
    const arr = grouped.get(r.emoji) ?? [];
    arr.push(r);
    grouped.set(r.emoji, arr);
  }
  return (
    <div className={cn("mt-1 flex flex-wrap gap-1", isOwn && "justify-end")}>
      {Array.from(grouped.entries()).map(([emoji, list]) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onToggle(emoji)}
          title={list.map((r) => personLabel(membersById.get(r.user_id)?.profile)).join(",")}
          className="inline-flex items-center gap-1 rounded-full border bg-background px-1.5 py-0.5 text-xs  hover:bg-accent"
        >
          <span>{emoji}</span>
          <span className="text-[10px] tabular-nums text-muted-foreground">{list.length}</span>
        </button>
      ))}
    </div>
  );
}

// -------- attachments --------

function AttachmentView({
  att,
  isOwn,
  onImageClick,
}: {
  att: MessageAttachment;
  isOwn: boolean;
  onImageClick: (path: string) => void;
}) {
  if (att.kind === "image") {
    return (
      <div className="mb-1 max-w-72">
        <InlineImage att={att} onClick={onImageClick} />
        <AttachmentMeta att={att} isOwn={isOwn} />
      </div>
    );
  }
  if (att.kind === "audio") {
    return <VoicePlayer att={att} isOwn={isOwn} />;
  }
  return <FileAttachment att={att} isOwn={isOwn} />;
}

/** Name and size under a photo; the card is the message, so it needs a caption. */
function AttachmentMeta({ att, isOwn }: { att: MessageAttachment; isOwn: boolean }) {
  const size = formatBytes(att.size_bytes);
  return (
    <div
      className={cn(
        "flex items-baseline gap-2 px-0.5 pt-1 text-[11px]",
        isOwn ? "text-primary-foreground/85" : "text-muted-foreground",
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium">
        {attachmentFileName(att.storage_path)}
      </span>
      {size && <span className="shrink-0 font-mono tabular-nums">{size}</span>}
    </div>
  );
}

function useSignedUrl(path: string | null) {
  return useQuery({
    queryKey: ["signed-url", path],
    enabled: !!path,
    // Held a minute short of the link's life, so a click never lands on a
    // dead one. Ten minutes, the default; the query refetches after that.
    staleTime: signedUrlStaleMs(),
    queryFn: async () => {
      const { data, error } = await signStoredFile(supabase, BUCKET, path!);
      if (error) throw error;
      return data.signedUrl;
    },
  });
}

function InlineImage({
  att,
  onClick,
}: {
  att: MessageAttachment;
  onClick: (path: string) => void;
}) {
  const urlQ = useSignedUrl(att.storage_path);
  return (
    <button
      type="button"
      onClick={() => onClick(att.storage_path)}
      className="mb-1 block max-w-72 overflow-hidden rounded-sm border bg-muted/60"
    >
      {urlQ.data ? (
        <img
          src={urlQ.data}
          alt=""
          loading="lazy"
          className="h-auto max-h-72 w-auto object-cover"
        />
      ) : (
        <div className="grid size-48 place-items-center text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
        </div>
      )}
    </button>
  );
}

function FileAttachment({ att, isOwn }: { att: MessageAttachment; isOwn: boolean }) {
  const urlQ = useSignedUrl(att.storage_path);
  const name = attachmentFileName(att.storage_path);
  const size = formatBytes(att.size_bytes);
  return (
    <a
      href={urlQ.data ?? "#"}
      target="_blank"
      rel="noreferrer"
      aria-label={`Open ${name}`}
      className={cn(
        "mb-1 flex w-64 max-w-full items-center gap-2 rounded-sm border px-2 py-2 text-xs",
        isOwn
          ? "border-primary-foreground/30 bg-primary-foreground/10 hover:bg-primary-foreground/20"
          : "border-border bg-muted/60 hover:bg-muted",
      )}
    >
      <div
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-sm",
          isOwn ? "bg-primary-foreground/15" : "bg-background",
        )}
      >
        <FileText className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className={cn("text-[10px]", isOwn ? "opacity-80" : "text-muted-foreground")}>
          {[size, att.mime?.split("/").pop()?.toUpperCase()].filter(Boolean).join(" · ")}
        </div>
      </div>
      <Download className="size-3.5 shrink-0 opacity-70" />
    </a>
  );
}

function VoicePlayer({ att, isOwn }: { att: MessageAttachment; isOwn: boolean }) {
  const urlQ = useSignedUrl(att.storage_path);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [rate, setRate] = useState(1);
  const [progress, setProgress] = useState(0);
  const peaks = ((att.waveform_peaks as number[] | null) ?? []).filter(
    (n) => typeof n === "number",
  );
  const dur = att.duration_seconds ?? 0;

  const toggle = () => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.playbackRate = rate;
      el.play();
    }
  };

  useEffect(() => {
    const el = audioRef.current;
    if (!el) return;
    const onT = () => setProgress(el.currentTime / (dur || el.duration || 1));
    const onEnd = () => {
      setPlaying(false);
      setProgress(0);
    };
    const onP = () => setPlaying(true);
    const onPa = () => setPlaying(false);
    el.addEventListener("timeupdate", onT);
    el.addEventListener("ended", onEnd);
    el.addEventListener("play", onP);
    el.addEventListener("pause", onPa);
    return () => {
      el.removeEventListener("timeupdate", onT);
      el.removeEventListener("ended", onEnd);
      el.removeEventListener("play", onP);
      el.removeEventListener("pause", onPa);
    };
  }, [dur]);

  const barColor = isOwn ? "bg-primary-foreground" : "bg-primary";
  const dimColor = isOwn ? "bg-primary-foreground/30" : "bg-primary/30";

  return (
    <div
      className={cn(
        "mb-1 flex w-64 items-center gap-2 rounded-full px-2 py-1.5",
        isOwn ? "bg-primary-foreground/10" : "bg-muted/50",
      )}
    >
      <Button
        type="button"
        size="icon"
        variant="ghost"
        className="size-8 shrink-0"
        onClick={toggle}
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
      </Button>
      <div className="flex h-8 min-w-0 flex-1 items-center gap-[2px]">
        {peaks.length === 0
          ? Array.from({ length: 30 }).map((_, i) => (
              <span
                key={i}
                className={cn("w-[2px] rounded-full", dimColor)}
                style={{ height: 4 + Math.abs(Math.sin(i)) * 12 }}
              />
            ))
          : peaks.map((p, i) => (
              <span
                key={i}
                className={cn(
                  "w-[2px] rounded-full",
                  i / peaks.length < progress ? barColor : dimColor,
                )}
                style={{ height: Math.max(3, p * 22) }}
              />
            ))}
      </div>
      <button
        type="button"
        onClick={() => setRate((r) => (r === 1 ? 1.5 : r === 1.5 ? 2 : 1))}
        className={cn(
          "shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium tabular-nums",
          isOwn
            ? "border-primary-foreground/30 text-primary-foreground"
            : "border-border text-foreground",
        )}
      >
        {rate}×
      </button>
      <span
        className={cn(
          "shrink-0 font-mono text-[10px] tabular-nums",
          isOwn ? "text-primary-foreground/80" : "text-muted-foreground",
        )}
      >
        {formatDuration(dur)}
      </span>
      {urlQ.data && <audio ref={audioRef} src={urlQ.data} preload="metadata" />}
    </div>
  );
}

// -------- shared record card --------

function SharedRecordCard({
  type,
  id,
  isOwn,
}: {
  type: SharedRecordType;
  id: string;
  isOwn: boolean;
}) {
  const q = useQuery({
    queryKey: ["shared-record", type, id],
    queryFn: async () => {
      if (type === "project") {
        const { data, error } = await supabase
          .from("projects")
          .select("id,name,address")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        return data;
      }
      if (type === "invoice") {
        const { data, error } = await supabase
          .from("invoices")
          .select("id,invoice_number,customer_name,status,job_id")
          .eq("id", id)
          .maybeSingle();
        if (error) throw error;
        return data ? { ...data, name: data.invoice_number, address: data.customer_name } : null;
      }
      if (type === "job") {
        const { data } = await supabase
          .from("jobs")
          .select("id, job_number, address, status, loss_type")
          .eq("id", id)
          .maybeSingle();
        return data;
      }
      const { data } = await supabase
        .from("accounts")
        .select("id, name, status, account_type")
        .eq("id", id)
        .maybeSingle();
      return data;
    },
  });
  const r = q.data as Record<string, unknown> | null;
  const to = sharedRecordPath(type, id, r?.job_id as string | null | undefined);
  return (
    <div
      className={cn(
        "mb-1 flex items-start gap-2 rounded-sm border p-2",
        isOwn
          ? "border-primary-foreground/30 bg-primary-foreground/10"
          : "border-primary/30 bg-primary/5",
      )}
    >
      <Link2 className="mt-0.5 size-4 shrink-0 opacity-70" />
      <div className="min-w-0 flex-1 text-xs">
        <div className="mb-0.5 font-mono text-[10px] uppercase opacity-70">{type}</div>
        {q.isLoading ? (
          <div className="opacity-60">Loading…</div>
        ) : !r ? (
          <div className="opacity-60">Record not accessible</div>
        ) : (
          <>
            <div className="font-semibold">
              {(r as { name?: string; job_number?: string; address?: string }).name ??
                (r as { job_number?: string }).job_number ??
                (r as { address?: string }).address ??
                id}
            </div>
            {type === "lead" && (
              <div className="opacity-70">
                {(r as { locality?: string; region?: string }).locality},{" "}
                {(r as { locality?: string; region?: string }).region} ·{" "}
                {(r as { pipeline_stage: string }).pipeline_stage}
              </div>
            )}
            {type === "job" && (
              <div className="opacity-70">
                {(r as { address: string; status: string }).address} ·{" "}
                {(r as { status: string }).status}
              </div>
            )}
            {type === "account" && (
              <div className="opacity-70">
                {(r as { account_type: string; status: string }).account_type} ·{" "}
                {(r as { status: string }).status}
              </div>
            )}
          </>
        )}
        {r && (
          <Link
            to={to}
            className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium underline underline-offset-2 hover:opacity-80"
          >
            Open <ExternalLink className="size-3" />
          </Link>
        )}
      </div>
    </div>
  );
}

// -------- composer --------

/** What the paperclip / image / record buttons put in the composer before Send. */
type Staged =
  | {
      kind: "image" | "file";
      file: File;
      previewUrl: string | null;
      width?: number;
      height?: number;
    }
  | { kind: "record"; type: SharePickerType; id: string; label: string };

function Composer({
  reply,
  replyLabel,
  replyIsItem,
  onClearReply,
  onSend,
  onTyping,
}: {
  reply: Message | null;
  replyLabel: string;
  replyIsItem: boolean;
  onClearReply: () => void;
  onSend: SendMessage;
  onTyping: () => void;
}) {
  const [text, setText] = useState("");
  const [staged, setStaged] = useState<Staged | null>(null);
  const [sending, setSending] = useState(false);
  const [recording, setRecording] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [sharePicker, setSharePicker] = useState(false);
  /** Characters typed after "@" at the caret while a Polaris mention is possible. */
  const [mentionQ, setMentionQ] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const imageRef = useRef<HTMLInputElement | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const tickRef = useRef<number | null>(null);
  const typingRef = useRef<number>(0);

  const applyMention = () => {
    const el = textRef.current;
    const caret = el?.selectionStart ?? text.length;
    const next = completeMention(text, caret);
    setText(next.text);
    setMentionQ(null);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(next.caret, next.caret);
    });
  };

  const clearStaged = () => {
    setStaged((s) => {
      if (s && s.kind !== "record" && s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      return null;
    });
  };

  /**
   * Records and captions are one message. Files retain the existing note
   * threading behavior. Plain text is unchanged.
   */
  const submit = async () => {
    const body = text.trim();
    if ((!body && !staged) || sending) return;
    const s = staged;
    setSending(true);
    setText("");
    setStaged(null);
    try {
      // A record and its caption share one database insert, so retrying a
      // failed caption cannot duplicate an already-sent record.
      if (s?.kind === "record") {
        const sent = await onSend({
          shared: { type: s.type, id: s.id },
          body: body || undefined,
        });
        if (sent === null) {
          setStaged(s);
          setText(body);
        }
        return;
      }
      let itemId: string | null = null;
      if (s) {
        itemId = await onSend({
          attachment: {
            blob: s.file,
            kind: s.kind,
            mime: s.file.type || "application/octet-stream",
            fileName: s.file.name,
            width: s.width,
            height: s.height,
          },
        });
        if (itemId === null) {
          // The send already toasted its error. Put everything back so nothing is lost.
          setStaged(s);
          setText(body);
          return;
        }
        if (s.previewUrl) URL.revokeObjectURL(s.previewUrl);
      }
      if (body) {
        const ok = await onSend(itemId ? { body, replyToId: itemId } : { body });
        if (ok === null) setText(body);
      }
    } finally {
      setSending(false);
    }
  };

  const startRec = async () => {
    try {
      recorderRef.current = new VoiceRecorder();
      await recorderRef.current.start();
      setRecording(true);
      setElapsed(0);
      tickRef.current = window.setInterval(() => {
        setElapsed(recorderRef.current?.elapsedSec() ?? 0);
      }, 200) as unknown as number;
    } catch (e) {
      toast.error(`Cannot record: ${(e as Error).message}`);
    }
  };

  const stopAndSend = async () => {
    if (!recorderRef.current) return;
    const res = await recorderRef.current.stop();
    if (tickRef.current) clearInterval(tickRef.current);
    setRecording(false);
    setElapsed(0);
    if (!res) return;
    void onSend({
      attachment: {
        blob: res.blob,
        kind: "audio",
        mime: res.mime,
        durationSec: res.durationSec,
        peaks: res.peaks,
        fileName: "voice.webm",
      },
    });
  };

  const cancelRec = () => {
    recorderRef.current?.cancel();
    if (tickRef.current) clearInterval(tickRef.current);
    setRecording(false);
    setElapsed(0);
  };

  const onImagePick = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    const dims = await imageDims(f);
    clearStaged();
    setStaged({
      kind: "image",
      file: f,
      previewUrl: URL.createObjectURL(f),
      width: dims?.w,
      height: dims?.h,
    });
  };

  const onFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    clearStaged();
    setStaged({ kind: "file", file: f, previewUrl: null });
  };

  const canSend = !!text.trim() || !!staged;
  const placeholder = staged
    ? "Add a note (optional)"
    : reply && replyIsItem
      ? "Write a note"
      : "Type a message";

  const emitTypingThrottled = () => {
    const now = Date.now();
    if (now - typingRef.current > 2000) {
      onTyping();
      typingRef.current = now;
    }
  };

  return (
    <div className="border-t bg-card p-2">
      {reply && (
        <div className="mb-2 flex items-center gap-2 rounded-sm border-l-2 border-primary bg-muted/50 px-2 py-1 text-xs">
          <div className="min-w-0 flex-1">
            <div className="font-medium text-primary">
              {replyIsItem ? "Adding a note to" : "Replying"}
            </div>
            <div className="truncate text-muted-foreground">{replyLabel}</div>
          </div>
          <Button size="icon" variant="ghost" className="size-6" onClick={onClearReply}>
            <X className="size-3" />
          </Button>
        </div>
      )}

      {staged && <StagedChip staged={staged} onClear={clearStaged} />}

      {mentionQ !== null && !recording && (
        <div className="mb-1 overflow-hidden rounded-sm border bg-popover shadow-sm" role="listbox">
          <button
            type="button"
            role="option"
            aria-selected
            onMouseDown={(e) => e.preventDefault()}
            onClick={applyMention}
            className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs hover:bg-accent"
          >
            <PolarisMark className="size-4 shrink-0" />
            <span className="font-medium">{ASSISTANT_HANDLE}</span>
            <span className="min-w-0 truncate text-muted-foreground">
              Ask Polaris — the answer is posted here for everyone
            </span>
          </button>
        </div>
      )}

      {recording ? (
        <div className="flex items-center gap-2 rounded-full bg-destructive/10 px-3 py-2">
          <span className="inline-block size-2 animate-pulse rounded-full bg-destructive" />
          <span className="flex-1 font-mono text-sm tabular-nums text-destructive">
            Recording · {formatDuration(elapsed)}
          </span>
          <Button size="sm" variant="ghost" onClick={cancelRec}>
            <X className="mr-1 size-4" /> Cancel
          </Button>
          <Button size="sm" onClick={stopAndSend}>
            <Send className="mr-1 size-4" /> Send
          </Button>
        </div>
      ) : (
        <div className="flex items-end gap-1">
          <input
            ref={imageRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={onImagePick}
          />
          <input ref={fileRef} type="file" className="hidden" onChange={onFilePick} />
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => imageRef.current?.click()}
            aria-label="Attach image"
          >
            <ImageIcon className="size-5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => fileRef.current?.click()}
            aria-label="Attach file"
          >
            <Paperclip className="size-5" />
          </Button>
          <Button
            type="button"
            size="icon"
            variant="ghost"
            onClick={() => setSharePicker(true)}
            aria-label="Share a record"
          >
            <Link2 className="size-5" />
          </Button>
          <Textarea
            ref={textRef}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setMentionQ(
                mentionQueryAtCaret(
                  e.target.value,
                  e.target.selectionStart ?? e.target.value.length,
                ),
              );
              emitTypingThrottled();
            }}
            onBlur={() => setMentionQ(null)}
            onKeyDown={(e) => {
              if (mentionQ !== null && (e.key === "Enter" || e.key === "Tab")) {
                e.preventDefault();
                applyMention();
                return;
              }
              if (mentionQ !== null && e.key === "Escape") {
                setMentionQ(null);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={placeholder}
            rows={1}
            className="min-h-10 max-h-40 resize-none py-2"
          />
          {canSend ? (
            <Button
              type="button"
              size="icon"
              onClick={() => void submit()}
              disabled={sending}
              aria-label="Send"
            >
              {sending ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
            </Button>
          ) : (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              onClick={startRec}
              aria-label="Record voice note"
            >
              <Mic className="size-5" />
            </Button>
          )}
        </div>
      )}

      <ShareRecordPicker
        open={sharePicker}
        onOpenChange={setSharePicker}
        onPick={(type, id, label) => {
          clearStaged();
          setStaged({ kind: "record", type, id, label });
        }}
      />
    </div>
  );
}

/** The item waiting in the composer. Says up front that it goes out as its own message. */
function StagedChip({ staged, onClear }: { staged: Staged; onClear: () => void }) {
  const name = staged.kind === "record" ? staged.label : staged.file.name;
  const detail =
    staged.kind === "record"
      ? `${staged.type[0].toUpperCase()}${staged.type.slice(1)}`
      : formatBytes(staged.file.size);
  return (
    <div className="mb-2 flex items-center gap-2 rounded-sm border bg-muted/50 p-2 text-xs">
      {staged.kind === "image" && staged.previewUrl ? (
        <img src={staged.previewUrl} alt="" className="size-10 shrink-0 rounded-sm object-cover" />
      ) : (
        <div className="grid size-10 shrink-0 place-items-center rounded-sm border bg-background">
          {staged.kind === "record" ? (
            <Link2 className="size-4" />
          ) : (
            <FileText className="size-4" />
          )}
        </div>
      )}
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{name}</div>
        <div className="truncate text-muted-foreground">
          {detail ? `${detail} · ` : ""}
          {staged.kind === "record"
            ? "Your message will be included with this record"
            : "Sent as its own message; your text goes underneath as a note"}
        </div>
      </div>
      <Button size="icon" variant="ghost" className="size-6" onClick={onClear} aria-label="Remove">
        <X className="size-3" />
      </Button>
    </div>
  );
}

export interface SendOptions {
  body?: string;
  attachment?: {
    blob: Blob;
    kind: "image" | "audio" | "file";
    mime: string;
    durationSec?: number;
    peaks?: number[];
    width?: number;
    height?: number;
    fileName: string;
  };
  shared?: { type: SharedRecordType; id: string };
  /** Omit to reply to whatever the composer is replying to; pass null for none. */
  replyToId?: string | null;
}

/** Resolves to the inserted message id, or null when the send failed (already toasted). */
type SendMessage = (opts: SendOptions) => Promise<string | null>;

async function imageDims(file: File): Promise<{ w: number; h: number } | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
      URL.revokeObjectURL(url);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    img.src = url;
  });
}

// -------- lightbox --------

function ImageLightbox({ path, onClose }: { path: string | null; onClose: () => void }) {
  const urlQ = useSignedUrl(path);
  return (
    <Dialog open={!!path} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl bg-transparent p-0 shadow-none">
        <DialogHeader className="sr-only">
          <DialogTitle>Image preview</DialogTitle>
        </DialogHeader>
        {urlQ.data && (
          <img src={urlQ.data} alt="" className="max-h-[85vh] w-auto rounded-sm object-contain" />
        )}
      </DialogContent>
    </Dialog>
  );
}
