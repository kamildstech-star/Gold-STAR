import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";

import { BadgeIcon } from "@/components/leaderboard/badge-icon";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import {
  fetchBadgeDefs,
  fetchBadgeProgress,
  fetchEarnedBadges,
  fetchRepUniverse,
  rarityPct,
  RARITY_META,
  type BadgeDef,
  type Rarity,
} from "@/lib/achievements";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));

function progressFor(
  def: BadgeDef,
  prog: Record<string, { current: number; target: number; label: string }>,
): { current: number; target: number; label: string } | null {
  const p = prog[def.rule_key];
  if (!p) return null;
  return { current: p.current, target: Number(def.threshold), label: p.label };
}

/**
 * Trophy case — earned badges in colour, locked ones greyed with progress.
 * Rarity is live: the share of eligible sales people who hold the badge.
 */
export function TrophyCase({ userId, dense }: { userId: string; dense?: boolean }) {
  const defsQ = useQuery({ queryKey: ["badge-defs"], queryFn: fetchBadgeDefs });
  const allQ = useQuery({ queryKey: ["badges-earned-all"], queryFn: () => fetchEarnedBadges() });
  const uniQ = useQuery({ queryKey: ["badge-universe"], queryFn: fetchRepUniverse });
  const progQ = useQuery({
    queryKey: ["badge-progress", userId],
    queryFn: () => fetchBadgeProgress(userId),
    enabled: Boolean(userId),
  });

  const defs = defsQ.data ?? [];
  const earnedAll = allQ.data ?? [];
  const mine = new Map(
    earnedAll.filter((e) => e.user_id === userId).map((e) => [e.achievement_id, e]),
  );
  const universe = uniQ.data ?? 1;
  const prog = progQ.data ?? {};

  const sorted = [...defs].sort((a, b) => {
    const am = mine.has(a.id) ? 0 : 1;
    const bm = mine.has(b.id) ? 0 : 1;
    return am - bm || a.sort_order - b.sort_order;
  });

  return (
    <div
      className={cn(
        "grid gap-2",
        dense ? "grid-cols-4 sm:grid-cols-6" : "grid-cols-3 sm:grid-cols-5 lg:grid-cols-7",
      )}
    >
      {sorted.map((def) => {
        const earned = mine.get(def.id);
        const meta = RARITY_META[(def.rarity as Rarity) ?? "common"];
        const pct = rarityPct(earnedAll, def.id, universe);
        const p = earned ? null : progressFor(def, prog);
        const ratio = p ? Math.min(p.current / Math.max(p.target, 1), 1) : 0;
        return (
          <Tooltip key={def.id}>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "flex flex-col items-center gap-1 rounded-md border p-2 text-center transition",
                  earned ? meta.ring : "border-dashed border-border opacity-60",
                )}
              >
                <div
                  className={cn(
                    "relative flex h-9 w-9 items-center justify-center rounded-full border",
                    earned ? meta.ring : "border-border",
                  )}
                >
                  <BadgeIcon
                    name={def.icon}
                    className={cn("h-4 w-4", earned ? meta.text : "text-muted-foreground")}
                  />
                  {!earned ? (
                    <Lock className="absolute -bottom-1 -right-1 h-3 w-3 rounded-full bg-background text-muted-foreground" />
                  ) : null}
                </div>
                <span className="line-clamp-2 text-[11px] font-medium leading-tight">
                  {def.name}
                </span>
                {p ? (
                  <>
                    <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/60"
                        style={{ width: `${ratio * 100}%` }}
                      />
                    </div>
                    <span className="text-[10px] text-muted-foreground">
                      {fmt(p.current)} / {fmt(p.target)}
                    </span>
                  </>
                ) : (
                  <span className={cn("text-[10px]", earned ? meta.text : "text-muted-foreground")}>
                    {meta.label}
                  </span>
                )}
              </div>
            </TooltipTrigger>
            <TooltipContent className="max-w-[220px] text-[12px]">
              <p className="font-medium">{def.name}</p>
              {def.description ? <p className="text-muted-foreground">{def.description}</p> : null}
              <p className="mt-1 text-muted-foreground">
                {meta.label} · held by {pct}% of reps
              </p>
              {earned ? (
                <p className="text-muted-foreground">
                  Earned {new Date(earned.earned_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
                  {earned.note ? ` — ${earned.note}` : ""}
                </p>
              ) : p ? (
                <p className="text-muted-foreground">
                  {fmt(p.current)} of {fmt(p.target)} {p.label}
                </p>
              ) : null}
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
