import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Plus, Ticket } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { RaffleDialog } from "@/components/raffle-dialog";
import { Button } from "@/components/ui/button";
import { canManageTradeshows } from "@/lib/roles";
import { listRaffles, RAFFLE_PHASE, rafflePhase, type Raffle } from "@/lib/raffles";
import { TONE } from "@/lib/tone";
import { cn } from "@/lib/utils";
import type { Tradeshow } from "@/lib/tradeshows";

export const RAFFLES_KEY = (showId?: string) => ["tradeshow-raffles", showId ?? "all"] as const;

export function RafflePhasePill({
  raffle,
  className,
}: {
  raffle: Pick<Raffle, "status" | "closes_at"> & { winners?: number };
  className?: string;
}) {
  const phase = RAFFLE_PHASE[rafflePhase(raffle, raffle.winners ?? 0)];
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px] font-semibold",
        TONE[phase.tone],
        className,
      )}
    >
      {phase.label}
    </span>
  );
}

/**
 * The Raffles box on a show's Overview: each raffle with its entry count, and
 * Create raffle. Every raffle belongs to a show, so the show page is where
 * people look for it first — not only behind the Raffles tab.
 */
export function TradeshowRafflesPanel({
  show,
  onSeeAll,
}: {
  show: Pick<Tradeshow, "id" | "name">;
  /** Opens the show's Raffles tab. */
  onSeeAll?: () => void;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = canManageTradeshows(app.roles);
  const [creating, setCreating] = React.useState(false);
  const q = useQuery({ queryKey: RAFFLES_KEY(show.id), queryFn: () => listRaffles(show.id) });
  const raffles = q.data?.raffles ?? [];

  return (
    <section className="rounded-xl border bg-card shadow-sm">
      <header className="flex items-start justify-between gap-2 border-b px-4 py-2.5">
        <div>
          <h2 className="flex items-center gap-1.5 text-[14px] font-bold">
            <Ticket className="size-4" /> Raffles
          </h2>
          <p className="text-[11px] text-muted-foreground">
            A QR code that enters visitors in a prize draw — and gives you their contact.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {onSeeAll && raffles.length > 0 && (
            <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={onSeeAll}>
              Prizes &amp; winners
            </Button>
          )}
          {canManage && q.data?.available !== false && (
            <Button
              size="sm"
              variant={raffles.length === 0 ? "default" : "outline"}
              className="h-7 px-2"
              disabled={app.writesDisabled}
              onClick={() => setCreating(true)}
            >
              <Plus className="mr-1 size-3.5" /> Create raffle
            </Button>
          )}
        </div>
      </header>
      {q.data?.available === false ? (
        <p className="px-4 py-3 text-[12px] text-warning">
          Not live yet — the database is still missing the raffles migration.
        </p>
      ) : q.isLoading ? (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">Loading…</p>
      ) : raffles.length === 0 ? (
        <p className="px-4 py-3 text-[12px] text-muted-foreground">
          No raffle for this show yet.
          {canManage && " Create one and it gets its own QR code for the booth."}
        </p>
      ) : (
        <ul className="divide-y">
          {raffles.map((r) => (
            <li key={r.id}>
              <Link
                to="/tradeshows/raffles/$raffleId"
                params={{ raffleId: r.id }}
                className="flex items-center gap-2 px-4 py-2.5 text-[13px] hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{r.title}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {r.entries} contact{r.entries === 1 ? "" : "s"} · {r.winners}/{r.prizes} drawn
                  </div>
                </div>
                <RafflePhasePill raffle={r} />
                <ChevronRight className="size-4 text-muted-foreground" />
              </Link>
            </li>
          ))}
        </ul>
      )}
      <RaffleDialog
        open={creating}
        onClose={() => setCreating(false)}
        tradeshowId={show.id}
        showName={show.name}
        onSaved={(id) => {
          setCreating(false);
          void qc.invalidateQueries({ queryKey: ["tradeshow-raffles"] });
          void navigate({ to: "/tradeshows/raffles/$raffleId", params: { raffleId: id } });
        }}
      />
    </section>
  );
}
