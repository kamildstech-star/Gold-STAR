import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Gift, Plus, Search, Ticket, Trophy } from "lucide-react";

import { useAppContext } from "@/components/app-context";
import { MetricStat } from "@/components/metric-stat";
import { RaffleDialog } from "@/components/raffle-dialog";
import { RafflePhasePill, RAFFLES_KEY } from "@/components/tradeshow-raffles-panel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { TAB_STRIP, TAB_TRIGGER, TabsCount } from "@/components/ui/tabs";
import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
import {
  listPrizesAndWinners,
  listRaffles,
  prizeMoney,
  RAFFLE_PHASE,
  rafflePhase,
  WINNER_STATUS,
  type RafflePhase,
  type WinnerStatus,
} from "@/lib/raffles";
import { canManageTradeshows } from "@/lib/roles";
import { TONE } from "@/lib/tone";
import { fetchTradeshows } from "@/lib/tradeshows";
import { cn } from "@/lib/utils";

export type RaffleSection = "raffles" | "prizes" | "winners";

const day = (iso: string) => new Date(iso).toLocaleDateString(DATE_LOCALE, US_DATE);

function Pill({ tone, children }: { tone: keyof typeof TONE; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center whitespace-nowrap rounded-full border px-2 text-[11px] font-semibold",
        TONE[tone],
      )}
    >
      {children}
    </span>
  );
}

/** Raffle counts, prizes and winners for one show (or every show), with filters. */
export function useRaffleBoardData(showId?: string) {
  const rafflesQ = useQuery({ queryKey: RAFFLES_KEY(showId), queryFn: () => listRaffles(showId) });
  const raffles = React.useMemo(() => rafflesQ.data?.raffles ?? [], [rafflesQ.data]);
  const ids = raffles.map((r) => r.id);
  const restQ = useQuery({
    queryKey: [...RAFFLES_KEY(showId), "board", ids.join(",")],
    queryFn: () => listPrizesAndWinners(ids),
    enabled: rafflesQ.isSuccess,
  });
  return {
    available: rafflesQ.data?.available !== false,
    loading: rafflesQ.isLoading || (ids.length > 0 && restQ.isLoading),
    raffles,
    prizes: restQ.data?.prizes ?? [],
    winners: restQ.data?.winners ?? [],
  };
}

/**
 * Every raffle, prize and winner in one place: on the Tradeshows page (all
 * shows, with a show filter) and in a show's own Raffles / Prizes / Winners
 * tabs. `sectionTabs` draws the board's own strip; a show page that already
 * has those tabs at the top leaves it off.
 */
export function RafflesBoard({
  show,
  section,
  onSection,
  sectionTabs = true,
}: {
  show?: { id: string; name: string };
  section: RaffleSection;
  onSection: (s: RaffleSection) => void;
  sectionTabs?: boolean;
}) {
  const app = useAppContext();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const canManage = canManageTradeshows(app.roles);
  const [creating, setCreating] = React.useState(false);
  const [q, setQ] = React.useState("");
  const [showFilter, setShowFilter] = React.useState("all");
  const [phase, setPhase] = React.useState<"all" | RafflePhase>("all");
  const [prizeState, setPrizeState] = React.useState<"all" | "open" | "awarded">("all");
  const [winnerState, setWinnerState] = React.useState<"all" | WinnerStatus>("all");

  const data = useRaffleBoardData(show?.id);
  const showsQ = useQuery({
    queryKey: ["tradeshows"],
    queryFn: fetchTradeshows,
    enabled: !show,
  });

  const needle = q.trim().toLowerCase();
  const hit = (...parts: (string | null | undefined)[]) =>
    !needle || parts.some((p) => p?.toLowerCase().includes(needle));
  const inShow = (id: string) => showFilter === "all" || id === showFilter;

  const raffles = data.raffles.filter(
    (r) =>
      inShow(r.tradeshow_id) &&
      (phase === "all" || rafflePhase(r, r.winners) === phase) &&
      hit(r.title, r.show_name),
  );
  const prizes = data.prizes.filter(
    (p) =>
      inShow(p.tradeshow_id) &&
      (prizeState === "all" ||
        (prizeState === "awarded" ? p.awarded >= p.quantity : p.awarded < p.quantity)) &&
      hit(p.name, p.description, p.raffle_title, p.show_name),
  );
  const winners = data.winners.filter(
    (w) =>
      inShow(w.tradeshow_id) &&
      (winnerState === "all" || w.status === winnerState) &&
      hit(w.name, w.email, w.company, w.prize_name, w.raffle_title, w.show_name),
  );

  // Stats follow the show filter, not the search, so they stay a summary.
  const scopedRaffles = data.raffles.filter((r) => inShow(r.tradeshow_id));
  const scopedPrizes = data.prizes.filter((p) => inShow(p.tradeshow_id));
  const scopedWinners = data.winners.filter((w) => inShow(w.tradeshow_id));
  const live = scopedWinners.filter((w) => w.status !== "forfeited");
  const contacts = scopedRaffles.reduce((s, r) => s + r.entries, 0);
  const taking = scopedRaffles.filter((r) => rafflePhase(r, r.winners) === "open").length;
  const prizeUnits = scopedPrizes.reduce((s, p) => s + p.quantity, 0);
  const prizeValue = scopedPrizes.reduce((s, p) => s + (p.value ?? 0) * p.quantity, 0);
  const toContact = live.filter((w) => w.status === "drawn").length;
  const claimed = live.filter((w) => w.status === "claimed").length;

  const showOptions = (showsQ.data ?? []).map((s) => ({ id: s.id, name: s.name }));
  const filterShows = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of data.raffles) m.set(r.tradeshow_id, r.show_name);
    return [...m].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [data.raffles]);

  if (!data.available) {
    return (
      <p className="rounded-xl border border-warning/40 bg-warning/5 px-4 py-3 text-[13px] text-warning">
        Not live yet — the database is still missing the raffles migration.
      </p>
    );
  }

  const SECTIONS: { key: RaffleSection; label: string; icon: React.ReactNode; count: number }[] = [
    { key: "raffles", label: "Raffles", icon: <Ticket />, count: scopedRaffles.length },
    { key: "prizes", label: "Prizes", icon: <Gift />, count: scopedPrizes.length },
    { key: "winners", label: "Winners", icon: <Trophy />, count: live.length },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        {sectionTabs ? (
          <div role="tablist" className={TAB_STRIP}>
            {SECTIONS.map((s) => (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={section === s.key}
                data-state={section === s.key ? "active" : "inactive"}
                className={TAB_TRIGGER}
                onClick={() => onSection(s.key)}
              >
                {s.icon} {s.label} <TabsCount>{s.count}</TabsCount>
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        {canManage && (
          <Button size="sm" disabled={app.writesDisabled} onClick={() => setCreating(true)}>
            <Plus className="mr-1 size-3.5" /> Create raffle
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <MetricStat
          compactOnPhone
          size="md"
          value={scopedRaffles.length}
          label="Raffles"
          hint={taking ? `${taking} taking entries` : "None taking entries"}
          icon={<Ticket className="size-4" />}
        />
        <MetricStat
          compactOnPhone
          size="md"
          value={contacts.toLocaleString("en-US")}
          label="Contacts collected"
        />
        <MetricStat compactOnPhone size="md" value={prizeUnits} label="Prizes" />
        <MetricStat
          compactOnPhone
          size="md"
          value={prizeValue ? prizeMoney(prizeValue) : "—"}
          label="Prize value"
        />
        <MetricStat
          compactOnPhone
          size="md"
          value={`${live.length}/${prizeUnits}`}
          label="Winners drawn"
          tone={prizeUnits > 0 && live.length >= prizeUnits ? "success" : "default"}
        />
        <MetricStat
          compactOnPhone
          size="md"
          value={toContact}
          label="Winners to contact"
          hint={`${claimed} claimed`}
          tone={toContact ? "warning" : "default"}
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              section === "winners"
                ? "Search winner, email, company, prize…"
                : section === "prizes"
                  ? "Search prize or raffle…"
                  : "Search raffle or show…"
            }
            className="h-8 pl-8 text-[13px]"
          />
        </div>
        {!show && (
          <Select value={showFilter} onValueChange={setShowFilter}>
            <SelectTrigger className="h-8 w-[200px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All shows</SelectItem>
              {filterShows.map((s) => (
                <SelectItem key={s.id} value={s.id}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {section === "raffles" && (
          <Select value={phase} onValueChange={(v) => setPhase(v as typeof phase)}>
            <SelectTrigger className="h-8 w-[170px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              {(Object.keys(RAFFLE_PHASE) as RafflePhase[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {RAFFLE_PHASE[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        {section === "prizes" && (
          <Select value={prizeState} onValueChange={(v) => setPrizeState(v as typeof prizeState)}>
            <SelectTrigger className="h-8 w-[170px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All prizes</SelectItem>
              <SelectItem value="open">Still to draw</SelectItem>
              <SelectItem value="awarded">Fully drawn</SelectItem>
            </SelectContent>
          </Select>
        )}
        {section === "winners" && (
          <Select
            value={winnerState}
            onValueChange={(v) => setWinnerState(v as typeof winnerState)}
          >
            <SelectTrigger className="h-8 w-[170px] text-[13px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Any status</SelectItem>
              {(Object.keys(WINNER_STATUS) as WinnerStatus[]).map((k) => (
                <SelectItem key={k} value={k}>
                  {WINNER_STATUS[k].label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <section className="overflow-hidden rounded-xl border bg-card shadow-sm">
        {data.loading ? (
          <p className="px-4 py-6 text-[13px] text-muted-foreground">Loading…</p>
        ) : data.raffles.length === 0 ? (
          <div className="px-4 py-10 text-center text-[13px] text-muted-foreground">
            No raffles {show ? "for this show " : ""}yet.
            {canManage && " Press Create raffle to make one — it gets its own QR code."}
          </div>
        ) : section === "raffles" ? (
          raffles.length === 0 ? (
            <NoMatch />
          ) : (
            <ul className="divide-y">
              {raffles.map((r) => (
                <li key={r.id}>
                  <Link
                    to="/tradeshows/raffles/$raffleId"
                    params={{ raffleId: r.id }}
                    className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] hover:bg-muted/50"
                  >
                    <span className="grid size-9 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                      <Ticket className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-semibold">{r.title}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {show ? "" : `${r.show_name} · `}created {day(r.created_at)}
                        {r.closes_at ? ` · closes ${day(r.closes_at)}` : ""}
                      </div>
                    </div>
                    <div className="text-right text-[12px] tabular-nums text-muted-foreground">
                      <div>
                        <b className="text-foreground">{r.entries}</b>
                        {r.max_entries != null ? ` / ${r.max_entries}` : ""} contact
                        {(r.max_entries ?? r.entries) === 1 ? "" : "s"}
                        {r.max_entries != null && r.entries >= r.max_entries && (
                          <b className="ml-1 text-warning">· Full</b>
                        )}
                      </div>
                      <div>
                        {r.winners}/{r.prizes} drawn
                      </div>
                    </div>
                    <RafflePhasePill raffle={r} />
                    <ChevronRight className="size-4 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          )
        ) : section === "prizes" ? (
          prizes.length === 0 ? (
            <NoMatch />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-[13px]">
                <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                  <tr>
                    <th className="px-4 py-2 font-semibold">Prize</th>
                    <th className="px-3 py-2 font-semibold">Raffle</th>
                    <th className="px-3 py-2 text-right font-semibold">Value</th>
                    <th className="px-3 py-2 text-right font-semibold">Qty</th>
                    <th className="px-3 py-2 font-semibold">Drawn</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {prizes.map((p) => (
                    <tr key={p.id} className="hover:bg-muted/40">
                      <td className="px-4 py-2 align-top">
                        <div className="font-semibold">{p.name}</div>
                        {p.description && (
                          <div className="text-[12px] text-muted-foreground">{p.description}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Link
                          to="/tradeshows/raffles/$raffleId"
                          params={{ raffleId: p.raffle_id }}
                          search={{ tab: "draw" }}
                          className="entity-link"
                        >
                          {p.raffle_title}
                        </Link>
                        {!show && (
                          <div className="text-[12px] text-muted-foreground">{p.show_name}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">
                        {p.value == null ? "—" : prizeMoney(p.value)}
                      </td>
                      <td className="px-3 py-2 text-right align-top tabular-nums">{p.quantity}</td>
                      <td className="px-3 py-2 align-top">
                        <Pill
                          tone={
                            p.awarded >= p.quantity ? "success" : p.awarded ? "warning" : "neutral"
                          }
                        >
                          {p.awarded}/{p.quantity} drawn
                        </Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        ) : winners.length === 0 ? (
          <NoMatch
            text={data.winners.length === 0 ? "No winners drawn yet." : "No winner matches."}
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-[13px]">
              <thead className="border-b bg-muted/40 text-[11px] uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th className="px-4 py-2 font-semibold">Winner</th>
                  <th className="px-3 py-2 font-semibold">Prize</th>
                  <th className="px-3 py-2 font-semibold">Raffle</th>
                  <th className="px-3 py-2 font-semibold">Drawn</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {winners.map((w) => (
                  <tr
                    key={w.id}
                    className={cn("hover:bg-muted/40", w.status === "forfeited" && "opacity-70")}
                  >
                    <td className="px-4 py-2 align-top">
                      <div className="font-semibold">{w.name}</div>
                      <div className="text-[12px] text-muted-foreground">
                        {[w.email, w.phone, w.company, w.industry].filter(Boolean).join(" · ")}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <div>{w.prize_name}</div>
                      {w.prize_value != null && (
                        <div className="text-[12px] tabular-nums text-muted-foreground">
                          {prizeMoney(w.prize_value)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Link
                        to="/tradeshows/raffles/$raffleId"
                        params={{ raffleId: w.raffle_id }}
                        search={{ tab: "draw" }}
                        className="entity-link"
                      >
                        {w.raffle_title}
                      </Link>
                      {!show && (
                        <div className="text-[12px] text-muted-foreground">{w.show_name}</div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 align-top tabular-nums">
                      {day(w.drawn_at)}
                      <div className="text-[12px] text-muted-foreground">
                        from {w.pool_size} entr{w.pool_size === 1 ? "y" : "ies"}
                      </div>
                    </td>
                    <td className="px-3 py-2 align-top">
                      <Pill tone={WINNER_STATUS[w.status].tone}>
                        {WINNER_STATUS[w.status].label}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <RaffleDialog
        open={creating}
        onClose={() => setCreating(false)}
        tradeshowId={show?.id ?? ""}
        showName={show?.name ?? ""}
        shows={showOptions}
        onSaved={(id) => {
          setCreating(false);
          void qc.invalidateQueries({ queryKey: ["tradeshow-raffles"] });
          void navigate({ to: "/tradeshows/raffles/$raffleId", params: { raffleId: id } });
        }}
      />
    </div>
  );
}

function NoMatch({ text = "Nothing matches these filters." }: { text?: string }) {
  return <p className="px-4 py-8 text-center text-[13px] text-muted-foreground">{text}</p>;
}
