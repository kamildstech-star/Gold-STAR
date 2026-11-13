import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { MessageSquarePlus, Search } from "lucide-react";
import { useMemo, useState } from "react";

import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { personLabel, relChatTime, type Conversation, type PersonProfile } from "@/lib/chat";
import { NewConversationDialog } from "./new-conversation-dialog";

interface ChatListRow extends Conversation {
  members: {
    user_id: string;
    last_read_at: string;
    muted: boolean;
    profile: PersonProfile | null;
  }[];
  unread: number;
}

export function ChatList() {
  const app = useAppContext();
  const params = useParams({ strict: false }) as {
    conversationId?: string;
  };
  const [q, setQ] = useState("");
  const [openNew, setOpenNew] = useState(false);

  const listQ = useQuery({
    queryKey: ["chat-list", app.userId],
    enabled: !!app.userId,
    queryFn: async (): Promise<ChatListRow[]> => {
      // 1. get memberships for the current user, joined with conversation
      const { data: mine, error } = await supabase
        .from("conversation_members")
        .select("last_read_at, conversation:conversations(*)")
        .eq("user_id", app.userId!);
      if (error) throw error;
      const convs = (mine ?? [])
        .map((m) => ({
          conv: m.conversation as Conversation,
          last_read_at: m.last_read_at,
        }))
        .filter((r) => r.conv);

      if (convs.length === 0) return [];
      const ids = convs.map((r) => r.conv.id);

      // 2. all members of those conversations, with the profile embedded via
      // conversation_members_user_id_profiles_fkey
      const { data: memberRows, error: memberErr } = await supabase
        .from("conversation_members")
        .select(
          "conversation_id, user_id, last_read_at, muted, profile:profiles!conversation_members_user_id_profiles_fkey(full_name)",
        )
        .in("conversation_id", ids);
      if (memberErr) throw memberErr;

      const byConv = new Map<string, ChatListRow["members"]>();
      for (const m of memberRows ?? []) {
        const arr = byConv.get(m.conversation_id) ?? [];
        arr.push({
          user_id: m.user_id,
          last_read_at: m.last_read_at,
          muted: m.muted,
          profile: m.profile ?? null,
        });
        byConv.set(m.conversation_id, arr);
      }

      // 3. unread counts — one batched query instead of one count per conversation.
      // Conversations whose last message predates my last read cannot have unread messages.
      const unreadByConv = new Map<string, number>();
      const candidates = convs.filter(
        ({ conv, last_read_at }) =>
          conv.last_message_at && new Date(conv.last_message_at) > new Date(last_read_at),
      );
      if (candidates.length > 0) {
        const oldestRead = candidates.reduce(
          (min, c) => (new Date(c.last_read_at) < new Date(min) ? c.last_read_at : min),
          candidates[0]!.last_read_at,
        );
        const { data: unreadRows, error: unreadErr } = await supabase
          .from("messages")
          .select("conversation_id, sent_at")
          .in(
            "conversation_id",
            candidates.map((c) => c.conv.id),
          )
          .gt("sent_at", oldestRead)
          .neq("sender_id", app.userId!)
          .is("deleted_at", null)
          .limit(2000);
        if (unreadErr) throw unreadErr;
        const readBy = new Map(candidates.map((c) => [c.conv.id, new Date(c.last_read_at)]));
        for (const row of unreadRows ?? []) {
          const readAt = readBy.get(row.conversation_id);
          if (!readAt || new Date(row.sent_at) <= readAt) continue;
          unreadByConv.set(row.conversation_id, (unreadByConv.get(row.conversation_id) ?? 0) + 1);
        }
      }

      return convs
        .map(({ conv }) => ({
          ...conv,
          members: byConv.get(conv.id) ?? [],
          unread: unreadByConv.get(conv.id) ?? 0,
        }))
        .sort(
          (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime(),
        );
    },
    staleTime: 20_000,
    refetchInterval: 60_000,
  });

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return listQ.data ?? [];
    return (listQ.data ?? []).filter((c) => {
      const label = conversationLabel(c, app.userId).toLowerCase();
      return (
        label.includes(needle) || (c.last_message_preview ?? "").toLowerCase().includes(needle)
      );
    });
  }, [listQ.data, q, app.userId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b bg-card p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="h-9 pl-8"
            placeholder="Search chats"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Button size="icon" variant="ghost" onClick={() => setOpenNew(true)} aria-label="New chat">
          <MessageSquarePlus className="size-5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {listQ.isLoading ? (
          <div className="p-4 text-sm text-muted-foreground">Loading…</div>
        ) : listQ.error ? (
          <div className="m-3 rounded border border-destructive/40 bg-destructive/5 p-3 text-xs text-destructive">
            <div className="font-medium">Couldn't load your chats</div>
            <p className="mt-1 break-words">{(listQ.error as Error).message}</p>
            <Button size="sm" variant="outline" className="mt-2" onClick={() => listQ.refetch()}>
              Retry
            </Button>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-3 text-center">
            <div className="text-sm font-medium">No chats yet</div>
            <p className="text-xs text-muted-foreground">
              Start a direct or group chat with anyone at Gold Star.
            </p>
            <Button size="sm" onClick={() => setOpenNew(true)}>
              <MessageSquarePlus className="mr-2 size-4" /> Start a chat
            </Button>
          </div>
        ) : (
          <ul>
            {filtered.map((c) => {
              const active = params.conversationId === c.id;
              const label = conversationLabel(c, app.userId);
              return (
                <li key={c.id}>
                  <Link
                    to="/chat/$conversationId"
                    params={{ conversationId: c.id }}
                    className={cn(
                      "flex items-center gap-3 border-b px-3 py-2.5 transition-colors hover:bg-accent/40",
                      active && "bg-accent/60",
                    )}
                  >
                    <Avatar label={label} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-2">
                        <span className="truncate text-sm font-medium">{label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {relChatTime(c.last_message_at)}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                          {c.last_message_preview || "No messages yet"}
                        </span>
                        {c.unread > 0 && (
                          <Badge className="h-5 min-w-5 shrink-0 rounded-full bg-primary px-1.5 text-[10px] tabular-nums text-primary-foreground">
                            {c.unread}
                          </Badge>
                        )}
                      </div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <NewConversationDialog
        open={openNew}
        onOpenChange={setOpenNew}
        onCreated={() => listQ.refetch()}
      />
    </div>
  );
}

export function conversationLabel(
  c: {
    kind: string;
    title: string | null;
    members: {
      user_id: string;
      profile: PersonProfile | null;
    }[];
  },
  currentUserId: string | null,
): string {
  if (c.title) return c.title;
  const others = c.members.filter((m) => m.user_id !== currentUserId);
  if (others.length === 0) return "You (note to self)";
  const names = others.map((m) => personLabel(m.profile));
  if (names.length <= 3) return names.join(",");
  return `${names.slice(0, 2).join(",")} +${names.length - 2}`;
}

export function Avatar({ label, size = 40 }: { label: string; size?: number }) {
  const initials = label
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
  return (
    <div
      className="grid shrink-0 place-items-center rounded-full bg-brand text-xs font-semibold text-brand-foreground"
      style={{ width: size, height: size }}
    >
      {initials || "?"}
    </div>
  );
}
