import * as React from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Bug,
  CalendarDays,
  CloudRain,
  Droplets,
  Flame,
  MoreVertical,
  PanelRightOpen,
  Wind,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { type CardDensity } from "@/lib/card-density";
import { fmtDate, fmtMoney } from "@/lib/table-prefs";
import { JOB_LOSS_LABELS } from "@/lib/jobs";
import { useLossTypes } from "@/lib/loss-categories";
import { stopRowClick, useRowNav } from "@/components/clickable-row";
import { LabelPills } from "@/components/label-pill";
import { fetchLabelMap, type Label } from "@/lib/labels";
// The pipeline card's own due-date reading, imported rather than re-derived.
// "3d late" has to mean the same thing on both boards, and there are already
// four different `dueLabel`s in this repo — a fifth would be a bug in waiting.
import { dueLabel } from "@/components/pipeline-board";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  HEALTH_META,
  INSURANCE_STYLE,
  PHASE_TONE_STYLE,
  initials,
  phaseTone,
  type ActiveClientRow,
} from "@/lib/active-clients";

/**
 * Card face of an active client, shared by the Cards grid and the Kanban
 * board. Same account, same tokens, three densities — the board's own setting,
 * the same three the pipeline offers (see lib/card-density.ts):
 *
 *   full     everything the card knows, the face the Cards grid has always had
 *   normal   the working column card: tighter type, one grab-height
 *   compact  who and how much — for scanning a long column for one account
 *
 * The grid keeps "full" whatever the board is set to; the setting is a board
 * setting, and a three-across grid has room for the whole face anyway.
 */

const MUTED = "var(--muted-foreground)";
const NAVY = "var(--foreground)";

/**
 * Account labels for the cards on screen, keyed by account id — the pipeline
 * board's `LabelMapContext`, on this board.
 *
 * #171 left the pills off because they are a second query. Mark overruled it:
 * "keep the client 360 panel, make everything else match". A label is how this
 * office marks an account "VIP", "Do not call", "Insurance dispute", and a
 * board you scan for the account that has gone quiet is exactly where that
 * belongs.
 *
 * It stays off the critical path: the board renders from `active-clients`
 * alone, the pills appear when the second query lands, and a card with no
 * labels — or a failed read — draws nothing where they would have been.
 */
const LabelMapContext = React.createContext<Record<string, Label[]>>({});

export function ClientLabelsProvider({
  ids,
  children,
}: {
  ids: string[];
  children: React.ReactNode;
}) {
  // Sorted, so re-ranking a column (the board sorts by urgency, the page by
  // whatever the header was last clicked) is not a different cache key for the
  // same set of accounts.
  const key = React.useMemo(() => [...ids].sort(), [ids]);
  const labelsQ = useQuery({
    queryKey: ["active-clients-labels", key],
    enabled: key.length > 0,
    queryFn: () => fetchLabelMap("account", key),
    staleTime: 60_000,
  });
  return <LabelMapContext.Provider value={labelsQ.data ?? {}}>{children}</LabelMapContext.Provider>;
}

function CardLabels({ id }: { id: string }) {
  const map = React.useContext(LabelMapContext);
  const list = map[id] ?? [];
  // `LabelPills` prints an em dash for an empty list, which on a card is a
  // line of nothing. No labels means no row at all.
  if (list.length === 0) return null;
  return <LabelPills labels={list} max={3} className="mt-1.5" />;
}

/** Loss glyph, tinted from the managed loss-type palette like the pipeline board. */
function LossIcon({ lossType }: { lossType: string }) {
  const lossTypes = useLossTypes();
  const cls = lossTypes.badgeForKey(lossType);
  const token = lossType.toLowerCase();
  const Icon =
    token === "fire" || token === "smoke"
      ? Flame
      : token === "storm"
        ? CloudRain
        : token === "mold" || token === "biohazard"
          ? Bug
          : token === "cleaning" || token === "asbestos"
            ? Wind
            : token === "water" || token === "sewer"
              ? Droplets
              : AlertTriangle;
  return (
    <span
      aria-hidden
      className={cn("grid size-7 shrink-0 place-items-center rounded-lg", cls)}
      title={lossTypes.labelForKey(lossType)}
    >
      <Icon className="size-4" />
    </span>
  );
}

export function lossLabel(lossType: string): string {
  return `${JOB_LOSS_LABELS[lossType as keyof typeof JOB_LOSS_LABELS] ?? lossType} Damage`;
}

function Chip({
  bg,
  fg,
  title,
  children,
}: {
  bg: string;
  fg: string;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      title={title}
      className="inline-flex max-w-full items-center truncate rounded-md px-2 py-1 text-[11.5px] font-semibold"
      style={{ background: bg, color: fg }}
    >
      {children}
    </span>
  );
}

/**
 * Initials chip for the person who owns the account — the pipeline card's
 * `RepAvatar`, on this card. A board card that never says whose client it is
 * makes you open something to find out, and the pipeline has never made you.
 */
function OwnerAvatar({ name }: { name: string | null }) {
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-full bg-[var(--muted)] text-[9px] font-semibold text-[var(--muted-foreground)]"
    >
      {name ? initials(name) : "—"}
    </span>
  );
}

/**
 * Kebab beside the Quick view button. Exported for the List view's row, which
 * draws the same pair in its last cell so the three views of the page carry
 * the same two controls.
 */
export function CardMenu({ row }: { row: ActiveClientRow }) {
  const navigate = useNavigate();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${row.name}`}
          {...stopRowClick}
          className="-mr-1 -mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]"
        >
          <MoreVertical className="h-4 w-4" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()}>
        <DropdownMenuItem
          onSelect={() => navigate({ to: "/accounts/$id", params: { id: row.accountId } })}
        >
          Open account
        </DropdownMenuItem>
        <DropdownMenuItem
          disabled={!row.jobId}
          onSelect={() => row.jobId && navigate({ to: "/jobs/$id", params: { id: row.jobId } })}
        >
          View job
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export type ClientCardProps = {
  row: ActiveClientRow;
  /** Commission rule — job value is hidden when false. */
  money: boolean;
  /**
   * Opens the Client 360 panel for this account — from the Quick view button
   * beside the kebab, not from the card. See the click model in `ClientCard`.
   */
  onQuickView?: () => void;
  /** How much of the card to draw. See lib/card-density.ts. */
  density?: CardDensity;
  /** True while this card is the one riding the DragOverlay. */
  overlay?: boolean;
  /** Highlighted because the Client 360 panel is showing it. */
  active?: boolean;
  /** Dimmed while its stage change is in flight. */
  pending?: boolean;
  className?: string;
};

/**
 * THE CLICK MODEL. Clicking the card opens the account record; the small
 * panel button beside the kebab opens Client 360.
 *
 * Until now it was the other way round: the card opened the panel and only
 * the name — a link a rep had to know was one — reached the record. Mark,
 * with the board and a prospect record side by side: "When clicking on an
 * active client, it's supposed to have the same look as the pipeline, which
 * is this page on the second screenshot." On the pipeline board the card is
 * the door to the record, so here the card is too, through the same
 * `useRowNav` the pipeline card uses — Enter and Space, a real link on the
 * name for middle-click, a drag is not a click.
 *
 * And Mark, earlier the same day: "keep the client 360 panel." It stays, one
 * click away, on a button that is always on the card rather than an entry in
 * the kebab — a dispatcher who works this board all day should not pay two
 * clicks per client for the panel that used to be one. The button stops the
 * row navigation the way the kebab and the name do.
 */
export const ClientCard = React.forwardRef<
  HTMLDivElement,
  ClientCardProps & Omit<React.HTMLAttributes<HTMLDivElement>, "onSelect">
>(function ClientCard(
  { row, money, onQuickView, density = "full", overlay, active, pending, className, ...rest },
  ref,
) {
  const nav = useRowNav(overlay ? null : `/accounts/${row.accountId}`);
  const tone = PHASE_TONE_STYLE[phaseTone(row.phase)];
  const ins = INSURANCE_STYLE[row.insurance];
  const health = HEALTH_META[row.health];
  // Both column densities share one tighter face; compact then drops what is
  // not "which account, how healthy, how much".
  const compact = density !== "full";
  const minimal = density === "compact";

  /*
   * How late the next milestone is, read exactly as a pipeline card reads its
   * next activity: "Today", "Tomorrow", "4d", "12d late". The board already
   * ranks cards by that clock (see card-urgency.ts) and then printed a bare
   * date, so the card at the top of the column never said why it was there.
   */
  const due = dueLabel(row.nextMilestone?.due ?? null);
  /*
   * The pipeline's rot wash, on this card. #171 argued the column was already
   * the wash here; Mark overruled it — "make everything else match".
   *
   * It is driven by the clock this card already reads, not a second definition
   * of "needs attention": the milestone `dueLabel` says is late is the one the
   * card prints as "12d late" and the one the column ranks by. So the wash and
   * the red text can never disagree, and at compact density — where the
   * lateness is one of the lines dropped — the wash is what is left saying it.
   */
  const overdue = due.tone === "late";
  const dueTone =
    due.tone === "late"
      ? "font-semibold text-[var(--destructive)]"
      : due.tone === "warn"
        ? "font-semibold text-[var(--warning)]"
        : "text-[var(--muted-foreground)]";

  return (
    <div
      ref={ref}
      {...rest}
      role={nav?.role}
      tabIndex={nav?.tabIndex}
      aria-label={row.name}
      /*
       * The navigation handlers run alongside whatever the host spread on —
       * on the board that is dnd-kit's pointer listener, and both need the
       * press. dnd-kit swallows the click that ends a real drag itself, and
       * `useRowNav` measures pointer travel on top of that, so a drag never
       * opens the record and a click never starts a drag.
       */
      onPointerDown={(e) => {
        nav?.onPointerDown(e);
        rest.onPointerDown?.(e);
      }}
      onClick={(e) => {
        nav?.onClick(e);
        rest.onClick?.(e);
      }}
      onKeyDown={(e) => {
        nav?.onKeyDown(e);
        rest.onKeyDown?.(e);
      }}
      className={cn(
        // 10px and `rot-card`, both straight off the pipeline card: two boards
        // whose cards sit at different radii do not read as the same board.
        "rounded-[10px] border border-[var(--border)] bg-card text-left shadow-[0_1px_2px_rgb(16_24_40_/_0.06)]",
        overdue && "rot-card",
        compact ? "px-3 py-2.5" : "p-4",
        !overlay &&
          "transition-shadow hover:shadow-[0_4px_10px_rgb(16_24_40_/_0.10)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]",
        nav && "cursor-pointer",
        active && "ring-1 ring-[var(--primary)]",
        pending && "opacity-60",
        overlay && "cursor-grabbing",
        className,
      )}
      style={
        overlay
          ? { transform: "scale(1.02)", boxShadow: "0 8px 20px rgba(16,24,40,0.16)", ...rest.style }
          : rest.style
      }
    >
      {/* identity */}
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            "flex shrink-0 items-center justify-center rounded-full font-bold",
            compact ? "h-8 w-8 text-[11px]" : "h-10 w-10 text-[12.5px]",
          )}
          style={{ background: "var(--accent)", color: "var(--primary)" }}
        >
          {initials(row.name)}
        </span>
        <div className="min-w-0 flex-1">
          {/* The name stays a real link, so open-in-new-tab keeps working; the
              rest of the card goes to the same record through `useRowNav`. */}
          {overlay ? (
            <div
              className={cn("truncate font-semibold", compact ? "text-[13px]" : "text-[14px]")}
              style={{ color: NAVY }}
            >
              {row.name}
            </div>
          ) : (
            <Link
              to="/accounts/$id"
              params={{ id: row.accountId }}
              {...stopRowClick}
              className={cn(
                "block truncate font-semibold hover:underline",
                compact ? "text-[13px]" : "text-[14px]",
              )}
              /* The pipeline card's name is `--foreground`, not `--primary`.
                 It is still a link and still underlines on hover; on a card
                 whose every other line is navy, a blue name was the loudest
                 thing on the board and the least worth being loud. */
              style={{ color: NAVY }}
            >
              {row.name}
            </Link>
          )}
          <div className="truncate text-[11.5px]" style={{ color: MUTED }}>
            {row.address}
            {row.city ? ` · ${row.city}` : ""}
          </div>
        </div>
        {overlay ? null : (
          <span className="flex shrink-0 items-start">
            {onQuickView ? (
              <button
                type="button"
                aria-label={`Quick view ${row.name}`}
                title="Quick view — open Client 360 beside the board"
                aria-pressed={active}
                {...stopRowClick}
                onClick={(e) => {
                  e.stopPropagation();
                  onQuickView();
                }}
                className={cn(
                  "-mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[var(--muted-foreground)] hover:bg-[var(--muted)] hover:text-[var(--foreground)]",
                  active && "bg-[var(--muted)] text-[var(--primary)]",
                )}
              >
                <PanelRightOpen className="h-4 w-4" />
              </button>
            ) : null}
            <CardMenu row={row} />
          </span>
        )}
      </div>

      {/* current incident — the first thing compact gives up, because the loss
          type is on the account page and this density is for finding the card */}
      <div
        className={cn("flex items-center gap-2.5", compact ? "mt-2" : "mt-3", minimal && "hidden")}
      >
        {row.lossType ? (
          <>
            <LossIcon lossType={row.lossType} />
            <div className="min-w-0">
              <div
                className={cn("truncate font-medium", compact ? "text-[12px]" : "text-[12.5px]")}
                style={{ color: NAVY }}
              >
                {lossLabel(row.lossType)}
              </div>
              <div className="truncate text-[11.5px]" style={{ color: MUTED }}>
                {fmtDate(row.lossDate)}
              </div>
            </div>
          </>
        ) : (
          <div className="text-[12px]" style={{ color: MUTED }}>
            No open incident
          </div>
        )}
      </div>

      {/* status chips */}
      <div className={cn("flex flex-wrap items-center gap-1.5", compact ? "mt-2" : "mt-3")}>
        {row.phase && !minimal ? (
          <Chip bg={tone.bg} fg={tone.fg}>
            {row.phase}
          </Chip>
        ) : null}
        {minimal ? null : (
          <Chip bg={ins.bg} fg={ins.fg}>
            {ins.label}
          </Chip>
        )}
        {/*
          Health, said once. Mark, with a screenshot of a "Watch" chip sitting
          over "Relationship · Watch": "watch is mentioned twice".

          The chip is the worse of the two tracks, so whenever the tracks line
          renders, one of its two words is the chip's word again. The line is
          the one that carries the information -- which job fixes it -- and it
          already colours each word with its band, so the line stays and the
          chip yields to it. The chip is still the whole of the health story
          where the line is not drawn: at compact density, where the card is
          name, health, money and owner, and on an account whose type runs no
          clock, which has no tracks to show.
        */}
        {minimal || row.healthTracks.length === 0 ? (
          <Chip bg={health.soft} fg={health.text} title={row.healthReason}>
            {health.label}
          </Chip>
        ) : null}
        {/*
          Non-Compliant is NOT a health colour, and is drawn so it cannot be
          mistaken for one: outlined rather than tinted, beside the band rather
          than instead of it. The band is a priority — Critical means go and
          chase this. This is a statement about standing: at 15+ days
          outstanding Gold Star may not be allowed to take their work at all.
          They come apart in both directions, so folding one into the other
          would lose the distinction the office actually acts on.
        */}
        {row.nonCompliant ? (
          <span
            className="inline-flex shrink-0 items-center rounded border border-current px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
            style={{ color: HEALTH_META.critical.color }}
            title="15+ days of outstanding paperwork — Gold Star may not be approved to take this client's work"
          >
            Non-Compliant
          </span>
        ) : null}
      </div>

      {/*
        Both tracks, labelled, in the place of a headline band.
        These say WHICH JOB fixes it, and they are different jobs — you cannot
        phone your way out of an expired certificate, and you cannot file your
        way out of four months of silence. A single band told a rep the client
        was red and left them to guess; a band above these said one of them
        twice. Dropped only at the most compact density, where the card is
        name, health, money and owner, and the chip above takes over.
        An account whose type runs no clock (a homeowner) has no tracks at
        all — `computeHealthTracks` returns none — so this renders nothing and
        the reason line below carries the explanation instead.
      */}
      {!minimal && row.healthTracks.length > 0 ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1">
          {row.healthTracks.map((t) => (
            <span
              key={t.key}
              className="inline-flex min-w-0 items-center gap-1.5 text-[11px]"
              title={`${t.label}: ${t.reason}`}
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full"
                style={{ background: HEALTH_META[t.health].color }}
              />
              <span className="shrink-0" style={{ color: MUTED }}>
                {t.label}
              </span>
              <span className="shrink-0 font-medium" style={{ color: HEALTH_META[t.health].text }}>
                {HEALTH_META[t.health].label}
              </span>
            </span>
          ))}
        </div>
      ) : null}

      {/* The band alone is not actionable — say why, whenever it is not Healthy. */}
      {row.health !== "healthy" && !minimal ? (
        <div className="mt-1 min-w-0 truncate text-[11px]" style={{ color: MUTED }}>
          {row.healthReason}
        </div>
      ) : null}

      {/*
        The cure window. Melly: "The rep then has thirty days." Once the sweep
        has opened an episode the card says which day of the thirty this is
        and when the deadline falls, and past it, that the manager's day-30
        decision is waiting. The band says Critical; this says how long.
      */}
      {row.critical && !minimal ? (
        <div
          className="mt-1 min-w-0 truncate text-[11px] font-medium"
          style={{ color: HEALTH_META.critical.text }}
          title={`Critical since ${fmtDate(row.critical.openedAt)} · recovery due ${fmtDate(row.critical.deadline)}`}
        >
          {row.critical.decisionDue
            ? `Day-30 decision due · ${-row.critical.daysLeft} day${-row.critical.daysLeft === 1 ? "" : "s"} past deadline`
            : `Day ${row.critical.dayOf} of 30 · recovery due ${fmtDate(row.critical.deadline)}`}
        </div>
      ) : null}

      {/* Account labels, in the pipeline card's own place: under the status
          chips, above the owner. Dropped at compact for the reason every other
          line is — compact is name, health, money and owner. */}
      {minimal ? null : <CardLabels id={row.accountId} />}

      {/* Owner. Kept at every density on purpose: compact drops everything that
          is not who, how healthy and how much, and the pipeline's compact card
          makes the same call — "name, money and owner". */}
      <div className={cn("flex items-center gap-1.5 text-[11.5px]", compact ? "mt-2" : "mt-3")}>
        <OwnerAvatar name={row.assignedRepName} />
        <span className="truncate" style={{ color: "var(--muted-foreground)" }}>
          {row.assignedRepName ?? "Unassigned"}
        </span>
      </div>

      {/* milestone + value */}
      {compact ? (
        <div
          className={cn(
            "mt-2 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-1.5 text-[11.5px]",
            // Compact with no right to see money leaves nothing in this row but
            // its own rule, so the row goes too.
            minimal && !money && "hidden",
          )}
        >
          <span
            className={cn("flex min-w-0 items-center gap-1.5", minimal && "hidden")}
            style={{ color: MUTED }}
          >
            <CalendarDays className="size-3.5 shrink-0" />
            <span className="truncate">{row.nextMilestone?.title ?? "No next milestone"}</span>
          </span>
          {row.nextMilestone?.due && !minimal ? (
            <span className={cn("shrink-0 tabular-nums", dueTone)}>{due.text}</span>
          ) : null}
          {money ? (
            <span className="ml-auto shrink-0 font-semibold tabular-nums" style={{ color: NAVY }}>
              {fmtMoney(row.jobValue ?? 0)}
            </span>
          ) : null}
        </div>
      ) : (
        <div className="mt-3 flex items-end justify-between gap-3 border-t border-[var(--border)] pt-2.5">
          <div className="min-w-0">
            <div className="text-[11px] uppercase tracking-[0.04em]" style={{ color: MUTED }}>
              Next milestone
            </div>
            {row.nextMilestone ? (
              <>
                <div className="truncate text-[12.5px] font-medium" style={{ color: NAVY }}>
                  {row.nextMilestone.title}
                </div>
                <div className="flex items-center gap-1.5 text-[11.5px]">
                  <span style={{ color: MUTED }}>{fmtDate(row.nextMilestone.due)}</span>
                  {/* Only when it says something the date does not. A flat
                      "May 20" printed twice is noise. */}
                  {due.tone !== "flat" ? (
                    <span className={cn("shrink-0 tabular-nums", dueTone)}>{due.text}</span>
                  ) : null}
                </div>
              </>
            ) : (
              <div className="text-[12.5px]" style={{ color: MUTED }}>
                Nothing scheduled
              </div>
            )}
          </div>
          {money ? (
            <div className="shrink-0 text-right">
              <div className="text-[11px] uppercase tracking-[0.04em]" style={{ color: MUTED }}>
                Job value
              </div>
              <div className="text-[15px] font-bold tabular-nums" style={{ color: NAVY }}>
                {fmtMoney(row.jobValue ?? 0)}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
});

/** Responsive card grid: 1 column on a phone, 2 on a tablet, 3 when wide. */
export function ActiveClientsCards({
  rows,
  money,
  loading,
  selectedId,
  onQuickView,
  emptyMessage = "No clients match this view.",
}: {
  rows: ActiveClientRow[];
  money: boolean;
  loading?: boolean;
  selectedId?: string | null;
  /** Opens the Client 360 panel for a row; the card itself opens the record. */
  onQuickView: (row: ActiveClientRow) => void;
  emptyMessage?: string;
}) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        {Array.from({ length: 6 }, (_, i) => (
          <div
            key={i}
            className="h-[196px] animate-pulse rounded-xl border border-[var(--border)] bg-[var(--muted)]/40"
          />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-[var(--border)] bg-card px-6 py-14 text-center">
        <div className="text-[13px] font-semibold" style={{ color: NAVY }}>
          Nothing to show
        </div>
        <div className="mt-1 text-[12.5px]" style={{ color: MUTED }}>
          {emptyMessage}
        </div>
      </div>
    );
  }

  return (
    /* The grid draws the same card face as the board, so it reads the same
       label map — one query, shared through the react-query cache when the two
       views are looking at the same accounts. */
    <ClientLabelsProvider ids={rows.map((r) => r.accountId)}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 [&>*]:min-w-0">
        {rows.map((r) => (
          <ClientCard
            key={r.accountId}
            row={r}
            money={money}
            active={selectedId === r.accountId}
            onQuickView={() => onQuickView(r)}
          />
        ))}
      </div>
    </ClientLabelsProvider>
  );
}
