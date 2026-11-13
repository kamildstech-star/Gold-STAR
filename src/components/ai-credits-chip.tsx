import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect } from "react";

import { useAppContext } from "@/components/app-context";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";

/**
 * The AI credits chip in the top bar, for Owners, Admins and Developers (the
 * people who may buy credits; the RPC refuses anyone else). It shows the
 * balance; its popover shows this month's credits per person and links to
 * Settings → AI credits to top up. Credits only, never raw cost.
 */

type ByUser = {
  month: string;
  balance: number;
  last_topup_credits: number;
  used_this_month: number;
  used_last_month: number;
  users: { user_id: string | null; name: string | null; credits: number }[];
};

const MANAGERS = new Set(["owner", "admin", "dev"]);

/** Fired after an AI call this tab made has been charged (Polaris replies). */
export const AI_CREDITS_USED_EVENT = "recovery-hub:ai-credits-used";

// The billing functions are not in the generated Database types.
const rpc = (fn: string) =>
  (
    supabase.rpc as unknown as (
      f: string,
    ) => Promise<{ data: unknown; error: { message: string } | null }>
  )(fn);

const n = (v: number) => Math.round(v).toLocaleString("en-US");

function monthName(ym: string) {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Date(y, m - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
}

export function AiCreditsChip() {
  // Real roles, not effective: View As must not show a rep the company balance.
  const { realRoles } = useAppContext();
  const canSee = realRoles.some((r) => MANAGERS.has(r));
  const query = useQuery({
    queryKey: ["ai-credits", "by-user"],
    enabled: canSee,
    queryFn: async () => {
      const { data, error } = await rpc("ai_credits_usage_by_user");
      if (error) throw new Error(error.message);
      return data as ByUser;
    },
    staleTime: 60_000,
    refetchInterval: () => (document.visibilityState === "visible" ? 120_000 : false),
    retry: false,
  });
  // A Polaris reply has just been charged: show the new balance now rather
  // than at the next two-minute poll.
  const { refetch } = query;
  useEffect(() => {
    if (!canSee) return;
    const onUsed = () => void refetch();
    window.addEventListener(AI_CREDITS_USED_EVENT, onUsed);
    return () => window.removeEventListener(AI_CREDITS_USED_EVENT, onUsed);
  }, [canSee, refetch]);
  const o = query.data;
  if (!canSee || !o) return null;

  const out = o.balance <= 0;
  const low = !out && o.last_topup_credits > 0 && o.balance <= o.last_topup_credits * 0.25;
  const ink = out ? "text-destructive" : low ? "text-warning" : "text-foreground";

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 px-2"
          aria-label={`AI credits: ${n(o.balance)}`}
        >
          <span className={cn("text-[11px] font-medium tabular-nums", ink)}>
            {n(o.balance)} credits
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[320px] p-0">
        <div className="border-b px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            AI credits
          </div>
          <div className={cn("text-2xl font-semibold tabular-nums", ink)}>
            {n(o.balance)} credits
          </div>
          {out ? (
            <p className="mt-0.5 text-[13px] text-destructive">
              Credits ran out. Top up to keep AI working.
            </p>
          ) : low ? (
            <p className="mt-0.5 text-[13px] text-warning">Credits are running low. Top up soon.</p>
          ) : null}
        </div>
        <div className="px-4 pt-3 text-[13px] text-muted-foreground">
          Used in {monthName(o.month)}:{" "}
          <span className="font-semibold text-foreground tabular-nums">
            {n(o.used_this_month)} credits
          </span>
        </div>
        <ul className="max-h-[260px] overflow-y-auto px-4 py-1">
          {o.users.length === 0 ? (
            <li className="py-2 text-[13px] text-muted-foreground">No AI used yet this month.</li>
          ) : (
            o.users.map((u) => (
              <li
                key={u.user_id ?? "automations"}
                className="flex items-center justify-between gap-3 border-b py-2 text-[13px] last:border-b-0"
              >
                <span
                  className={cn(
                    "truncate",
                    u.user_id ? "text-foreground" : "text-muted-foreground",
                  )}
                >
                  {u.user_id ? u.name : "Automations"}
                </span>
                <span className="shrink-0 tabular-nums text-muted-foreground">{n(u.credits)}</span>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center justify-between border-t px-4 py-2 text-[13px] text-muted-foreground">
          <span>Used last month</span>
          <span className="font-semibold text-foreground tabular-nums">
            {n(o.used_last_month)} credits
          </span>
        </div>
        <div className="border-t px-4 py-2.5">
          <Link
            to="/admin/ai-credits"
            className="text-[13px] font-medium text-link underline-offset-2 hover:underline"
          >
            Top up and manage credits
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}
