import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { Sunrise, CheckCircle2, MessageSquare, ChevronRight } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { EmptyLine, LoadError } from "@/components/ui-density";
import { supabase } from "@/integrations/supabase/client";
import { useAppContext } from "@/components/app-context";
import { useCan } from "@/lib/permissions";
import { useMyPageAccess } from "@/lib/use-page-access";
import { cn } from "@/lib/utils";
import {
  fetchMorningBrief,
  topBriefItems,
  type BriefItem,
  type BriefSection,
  type MorningBrief,
} from "@/lib/morning-brief";

/**
 * Morning Brief — the manager's first screen of the day.
 *
 * The tile is a glance: the headline count, one line per section, and the
 * three most urgent rows across all of them. It is bounded like the tiles
 * beside it — a busy morning does not make it taller, it makes the counts
 * bigger. Every row, with its Open / Book / Message action, lives behind
 * *Open brief* in a drawer. A quiet morning renders one line saying so.
 */

/** How many rows the tile itself shows. The drawer shows everything. */
const TILE_ROWS = 3;

const SEVERITY_DOT: Record<BriefItem["severity"], string> = {
  danger: "bg-[#DC2626]",
  warn: "bg-[#F59E0B]",
  info: "bg-[var(--primary)]",
};

const SEVERITY_RANK: Record<BriefItem["severity"], number> = { danger: 0, warn: 1, info: 2 };

/** A section's dot takes the colour of its worst row. */
function sectionSeverity(s: BriefSection): BriefItem["severity"] {
  let worst: BriefItem["severity"] = "info";
  for (const item of s.items)
    if (SEVERITY_RANK[item.severity] < SEVERITY_RANK[worst]) worst = item.severity;
  return worst;
}

function headline(brief: MorningBrief | undefined): string {
  if (!brief) return "What needs a decision across your team today.";
  if (brief.total === 0) return "Nothing needs a decision.";
  return `${brief.total} thing${brief.total === 1 ? "" : "s"} need${brief.total === 1 ? "s" : ""} a decision.`;
}

export function MorningBriefCard() {
  const app = useAppContext();
  const navigate = useNavigate();
  const canSee = useCan("rep_cost.view");
  const [open, setOpen] = useState(false);

  const brief = useQuery({
    queryKey: ["morning-brief", app.userId],
    enabled: canSee && !!app.userId,
    staleTime: 5 * 60_000,
    queryFn: fetchMorningBrief,
  });

  if (!canSee) return null;

  async function messageRep(userId: string) {
    const me = app.userId;
    if (!me) return;
    try {
      const { data: mine } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("user_id", me);
      const { data: theirs } = await supabase
        .from("conversation_members")
        .select("conversation_id")
        .eq("user_id", userId);
      const mineSet = new Set((mine ?? []).map((r) => r.conversation_id));
      const shared = (theirs ?? []).map((r) => r.conversation_id).filter((id) => mineSet.has(id));
      let conversationId: string | null = null;
      if (shared.length) {
        const { data: convs } = await supabase
          .from("conversations")
          .select("id,kind")
          .in("id", shared)
          .eq("kind", "direct")
          .limit(1);
        conversationId = convs?.[0]?.id ?? null;
      }
      if (!conversationId) {
        const { data: conv, error } = await supabase
          .from("conversations")
          .insert({ kind: "direct", created_by: me })
          .select("id")
          .single();
        if (error) throw error;
        const { error: mErr } = await supabase.from("conversation_members").insert([
          { conversation_id: conv.id, user_id: me, is_admin: true },
          { conversation_id: conv.id, user_id: userId, is_admin: false },
        ]);
        if (mErr) throw mErr;
        conversationId = conv.id as string;
      }
      navigate({ to: "/chat/$conversationId", params: { conversationId } });
    } catch (e) {
      console.error("[morning-brief] message rep:", e);
      toast.error("Could not open that chat");
    }
  }

  const sections = brief.data?.sections ?? [];
  const top = topBriefItems(sections, TILE_ROWS);
  const total = brief.data?.total ?? 0;

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-1.5">
          <Sunrise className="h-4 w-4 text-muted-foreground" />
          Morning brief
        </CardTitle>
        <CardDescription>{headline(brief.data)}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3 pt-0">
        {brief.isLoading ? (
          <EmptyLine>Reading your pipeline…</EmptyLine>
        ) : brief.isError ? (
          <LoadError what="the morning brief" error={brief.error} onRetry={() => brief.refetch()} />
        ) : sections.length === 0 ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-[#16A34A]" />
            Nothing needs you this morning — pipeline, tasks and approvals are all inside their
            windows.
          </div>
        ) : (
          <>
            {/* One line per section. Each is a way into the drawer. */}
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {sections.map((s) => (
                <li key={s.key}>
                  <button
                    type="button"
                    onClick={() => setOpen(true)}
                    className="flex min-h-7 items-center gap-1.5 text-[13px] text-foreground hover:underline"
                  >
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        SEVERITY_DOT[sectionSeverity(s)],
                      )}
                      aria-hidden
                    />
                    <span>{s.title}</span>
                    <span className="tabular-nums text-muted-foreground">· {s.items.length}</span>
                  </button>
                </li>
              ))}
            </ul>

            <ul className="divide-y divide-border/60 border-y border-border/60">
              {top.map((item) => (
                <BriefRow key={item.id} item={item} onMessage={messageRep} />
              ))}
            </ul>

            <div className="mt-auto flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>
                {total <= top.length
                  ? "That's everything."
                  : `${total - top.length} more in the full brief.`}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-8 shrink-0"
                onClick={() => setOpen(true)}
              >
                Open brief
                <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent side="right" className="w-full sm:max-w-md">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-1.5">
              <Sunrise className="h-4 w-4 text-muted-foreground" />
              Morning brief
            </SheetTitle>
            <SheetDescription>{headline(brief.data)}</SheetDescription>
          </SheetHeader>
          <div className="space-y-4">
            {sections.map((s) => (
              <section key={s.key} aria-label={s.title}>
                <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  <span
                    className={cn("h-1.5 w-1.5 rounded-full", SEVERITY_DOT[sectionSeverity(s)])}
                    aria-hidden
                  />
                  {s.title}
                  <span className="tabular-nums">· {s.items.length}</span>
                </div>
                <ul className="divide-y divide-border/60">
                  {s.items.map((item) => (
                    <BriefRow key={item.id} item={item} onMessage={messageRep} />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </Card>
  );
}

/** One decision: dot, reason, fact, and the single action that clears it. */
function BriefRow({ item, onMessage }: { item: BriefItem; onMessage: (userId: string) => void }) {
  // The action is only a link to a page this person can open; otherwise the
  // row is the fact alone, never a button that lands on a refusal.
  const pageAccess = useMyPageAccess();
  return (
    <li className="flex items-center gap-2 py-1.5">
      <span
        className={cn("h-1.5 w-1.5 shrink-0 rounded-full", SEVERITY_DOT[item.severity])}
        aria-hidden
      />
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium leading-tight">{item.title}</div>
        <div className="truncate text-xs text-muted-foreground">{item.detail}</div>
      </div>
      {item.action.kind === "message" ? (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 shrink-0 px-2 text-xs"
          onClick={() => item.action.kind === "message" && onMessage(item.action.userId)}
        >
          <MessageSquare className="mr-1 h-3.5 w-3.5" />
          {item.action.label}
        </Button>
      ) : !pageAccess.canOpen(item.action.href) ? null : (
        <Button asChild size="sm" variant="ghost" className="h-7 shrink-0 px-2 text-xs">
          <Link to={item.action.href}>
            {item.action.label}
            <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
          </Link>
        </Button>
      )}
    </li>
  );
}
