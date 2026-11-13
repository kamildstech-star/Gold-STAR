import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Loader2, Search, X } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { describeDbError, errText } from "@/lib/db-errors";
import { useAppContext } from "@/components/app-context";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { personLabel } from "@/lib/chat";
import { Avatar } from "./chat-list";
import { cn } from "@/lib/utils";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}

export function NewConversationDialog({ open, onOpenChange, onCreated }: Props) {
  const app = useAppContext();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<{ user_id: string; label: string }[]>([]);
  const [title, setTitle] = useState("");

  const searchQ = useQuery({
    queryKey: ["chat-user-search", q, app.userId],
    enabled: open,
    queryFn: async () => {
      let query = supabase
        .from("profiles")
        .select("user_id, full_name, is_active")
        .eq("is_active", true)
        .neq("user_id", app.userId!)
        .limit(20);
      const needle = q.trim();
      if (needle) {
        query = query.or(`full_name.ilike.%${needle}%`);
      }
      const { data, error } = await query;
      if (error) throw error;
      return data ?? [];
    },
  });

  const create = useMutation({
    mutationFn: async () => {
      if (!app.userId || picked.length === 0) return null;
      const isGroup = picked.length > 1;
      const { data: conv, error } = await supabase
        .from("conversations")
        .insert({
          kind: isGroup ? "group" : "direct",
          title: isGroup ? title.trim() || null : null,
          created_by: app.userId,
        })
        .select("id")
        .single();
      if (error) throw error;

      const members = [app.userId, ...picked.map((p) => p.user_id)];
      const { error: mErr } = await supabase.from("conversation_members").insert(
        members.map((uid) => ({
          conversation_id: conv.id,
          user_id: uid,
          is_admin: uid === app.userId,
        })),
      );
      if (mErr) throw mErr;
      return conv.id as string;
    },
    onSuccess: (id) => {
      onCreated();
      onOpenChange(false);
      setPicked([]);
      setTitle("");
      setQ("");
      if (id) navigate({ to: "/chat/$conversationId", params: { conversationId: id } });
    },
    onError: (e) => {
      console.error("[chat] create conversation:", e);
      toast.error(describeDbError(e, { action: "Starting chat" }));
    },
  });

  const pickedIds = useMemo(() => new Set(picked.map((p) => p.user_id)), [picked]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Start a new chat</DialogTitle>
        </DialogHeader>

        {picked.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {picked.map((p) => (
              <Badge key={p.user_id} variant="secondary" className="gap-1">
                {p.label}
                <button
                  type="button"
                  onClick={() => setPicked((prev) => prev.filter((x) => x.user_id !== p.user_id))}
                  aria-label={`Remove ${p.label}`}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
          </div>
        )}

        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
          <Input
            className="pl-8"
            placeholder="Search people…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="max-h-72 overflow-y-auto rounded-sm border">
          {searchQ.isLoading ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              <Loader2 className="mr-1 inline size-3 animate-spin" /> Searching
            </div>
          ) : searchQ.error ? (
            <div className="p-4 text-center text-sm text-destructive">{errText(searchQ.error)}</div>
          ) : (searchQ.data ?? []).length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">Nobody matches.</div>
          ) : (
            (searchQ.data ?? []).map((u) => {
              const label = personLabel(u);
              const already = pickedIds.has(u.user_id);
              return (
                <button
                  key={u.user_id}
                  type="button"
                  onClick={() =>
                    !already && setPicked((prev) => [...prev, { user_id: u.user_id, label }])
                  }
                  className={cn(
                    "flex w-full items-center gap-2 border-b p-2 text-left text-sm last:border-0 hover:bg-accent/50",
                    already && "opacity-60",
                  )}
                >
                  <Avatar label={label} size={32} />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{label}</div>
                  </div>
                  {already && <span className="text-xs text-primary">Added</span>}
                </button>
              );
            })
          )}
        </div>

        {picked.length > 1 && (
          <Input
            placeholder="Group name (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        )}

        <DialogFooter>
          <Button
            onClick={() => create.mutate()}
            disabled={picked.length === 0 || create.isPending}
          >
            {picked.length > 1 ? "Create group" : "Start chat"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
