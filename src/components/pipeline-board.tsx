import * as React from "react";
import { Link } from "@tanstack/react-router";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  AlarmClock,
  AlertTriangle,
  Bug,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudRain,
  Droplets,
  FileSignature,
  Flame,
  Paperclip,
  Plus,
  Trophy,
  Wind,
} from "lucide-react";

import { togglesActiveClients, pointerFirst } from "@/lib/pipeline-drop-target";
import { type SnoozeControlState } from "@/lib/pipeline-snooze";
import { type CardDensity } from "@/lib/card-density";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { LabelPills } from "@/components/label-pill";
import { fetchLabelMap, type Label } from "@/lib/labels";
import {
  AWAITING_APPROVAL_CARD,
  AWAITING_APPROVAL_ROW,
  approvalLabel,
  isAwaitingApproval,
} from "@/lib/approval";
import { ROW_NAV_CLASS, stopRowClick, useRowNav } from "@/components/clickable-row";
import { EmptyLine } from "@/components/ui-density";
import { useLossTypes } from "@/lib/loss-categories";
import { stageTone } from "@/lib/stage-tone";
import { useIsMobile } from "@/hooks/use-mobile";
import { layoutColumns, type ColumnLayout } from "@/lib/pipeline-fold";
import { compareByUrgency, type UrgencyCard } from "@/lib/card-urgency";
import {
  daysSince,
  fmtMoney,
  PRIORITY_LABEL,
  type OpportunityCard,
  type PipelineStage,
} from "@/lib/pipeline";

import { DATE_LOCALE, US_DATE } from "@/lib/date-format";
/** Account labels for every card on the board, keyed by account id. */
const LabelMapContext = React.createContext<Record<string, Label[]>>({});

function CardLabels({ id }: { id: string }) {
  const map = React.useContext(LabelMapContext);
  const list = map[id] ?? [];
  if (list.length === 0) return null;
  return <LabelPills labels={list} max={3} className="mt-1.5" />;
}

export type ViewMode = "kanban" | "grid" | "list";

type BoardProps = {
  stages: PipelineStage[];
  cards: OpportunityCard[];
  view: ViewMode;
  locationCode: (id: string) => string;
  repName: (id: string | null) => string;
  onMove: (card: OpportunityCard, stage: PipelineStage) => void;
  movingId: string | null;
  writesDisabled: boolean;
  /** Sales Head / Owner / Admin only — absent for everyone else. */
  onApprove?: (card: OpportunityCard) => void;
  approvingId?: string | null;
  /** Rot window in days, per stage id — from the automation stage windows. */
  rotDays?: Record<string, number>;
  /**
   * Account id to "is the outreach rule warning about this one", for the cards
   * the rule governs. A card absent from this map falls back to `rotDays`.
   */
  ruleWarning?: ReadonlyMap<string, boolean>;
  /**
   * The one snooze, per account id — see src/lib/pipeline-snooze.ts. Only the
   * cards that carry a control appear in the map; the rest get none.
   */
  snooze?: ReadonlyMap<string, SnoozeControlState>;
  /** Spends the snooze. Absent leaves the control visible but inert. */
  onSnooze?: (card: OpportunityCard) => void;
  snoozingId?: string | null;
  /**
   * "Create proposal" on the card. Mark: "Is there a way to make something in
   * the pipeline a proposal?" Absent draws no button.
   */
  onCreateProposal?: (card: OpportunityCard) => void;
  /** How much of each card to draw — the caller owns it so it can persist. */
  density?: CardDensity;
  /** Ghost "+" at the foot of a column adds straight into that stage. */
  onAddToStage?: (stage: PipelineStage) => void;
  /**
   * Active Clients: the clients themselves, and a place to drop a deal to win
   * one.
   *
   * Mark: "The Active Clients section on this page doesn't need to display the
   * full list of names -- just a total count is enough. When you drag and drop
   * a deal there, it should automatically move the client to active status."
   *
   * Won stages stopped rendering as prospect columns, which was right -- a
   * client is not an opportunity and listing them twice made the same
   * relationship appear in two workspaces. But it also took away the place you
   * drop a deal to win it. This is that place, without the list.
   *
   * Collapsed it is still that count. Expanded -- Mark: "what happened to be
   * able to click on the active clients to open it as a full size card and
   * show all the deals in there" -- it is a column of these very rows, so the
   * list is the count. Pass the clients, not a number: a tile that says 46 and
   * lists 41 is a bug report waiting to happen, and the only way to be sure
   * they agree is for there to be one of them.
   */
  activeClients?: OpportunityCard[];
  /** Render the tile straight after this stage's column. Null puts it last. */
  activeClientsAfterStageId?: string | null;
  onActivate?: (card: OpportunityCard) => void;
  /** Money rule — column totals and card values only render when true. */
  showMoney?: boolean;
  /**
   * Stage ids the person keeps folded to a strip. Owned by the caller so it
   * can persist per user; when absent the board keeps the set for the session.
   */
  folded?: ReadonlySet<string>;
  onToggleFold?: (stageId: string) => void;
};

function ageDays(card: OpportunityCard) {
  return daysSince(card.stage_changed_at);
}

/**
 * What the column ranking needs from a prospect card — see
 * src/lib/card-urgency.ts. "Age" here is the age the card already shows:
 * days in the stage, not days since the account was created.
 */
function urgencyOf(card: OpportunityCard): UrgencyCard {
  return {
    id: card.id,
    nextDueAt: card.next_activity?.due_date ?? null,
    ageDays: ageDays(card),
  };
}

function ageLabel(card: OpportunityCard) {
  const d = ageDays(card);
  return d == null ? "—" : d === 0 ? "today" : `${d}d`;
}

/** A card is rotting once it has sat in its stage longer than that stage allows. */
/**
 * Whether a card shows as going cold.
 *
 * Mark: "At 24 days of no activity, the deal card turns red."
 *
 * It used to measure days sitting in the STAGE against a rot window configured
 * separately per stage, which is a different question and came apart in both
 * directions. A deal worked yesterday but parked in Active Outreach for forty
 * days went red; a deal untouched for twenty-five days that changed stage last
 * week stayed white.
 *
 * So where the outreach rules govern a card -- Active Outreach and
 * Conversation Established -- the rule engine's own answer is authoritative,
 * including when it says the card is fine. `warning` there is days since any
 * activity against warn_days, plus the exhausted standard, which is the same
 * thing the card's own detail already says.
 *
 * Everywhere else the stage rot window still applies. It is a separate admin
 * feature for stages the outreach standard says nothing about, and this is not
 * the change that removes it.
 */
export function isRotting(
  card: OpportunityCard,
  rotDays?: Record<string, number>,
  ruleWarning?: ReadonlyMap<string, boolean>,
) {
  const governed = ruleWarning?.get(card.id);
  if (governed !== undefined) return governed;

  if (!card.stage_id || !rotDays) return false;
  const window = rotDays[card.stage_id];
  if (!window || window <= 0) return false;
  const d = ageDays(card);
  return d != null && d > window;
}

/* ------------------------------------------------------------------- card */

type CardProps = {
  card: OpportunityCard;
  locationCode: (id: string) => string;
  repName: (id: string | null) => string;
  writesDisabled: boolean;
  onApprove?: (card: OpportunityCard) => void;
  approving?: boolean;
  rotting?: boolean;
  /** The one snooze, when this card has one to show. */
  snooze?: SnoozeControlState | null;
  onSnooze?: (card: OpportunityCard) => void;
  snoozing?: boolean;
  /** Opens the proposal dialog for this card's account. */
  onCreateProposal?: (card: OpportunityCard) => void;
  /** True while this card is the one under the cursor in the DragOverlay. */
  overlay?: boolean;
  /** Won column: closed date + green chip instead of a next activity. */
  won?: boolean;
  /** Money rule — hides values for roles that may not see them. */
  showMoney?: boolean;
  /** How much of the card to draw. See lib/card-density.ts. */
  density?: CardDensity;
};

/** "$342K" / "$1.84M" — the compact money the mockup uses on column headers. */
export function compactMoney(n: number): string {
  if (!Number.isFinite(n)) return "$0";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1000)}K`;
  return `$${Math.round(n).toLocaleString("en-US")}`;
}

/** Relative urgency for the next activity: "2h", "Tomorrow", "May 20", "3d late". */
export function dueLabel(due: string | null): { text: string; tone: "flat" | "warn" | "late" } {
  if (!due) return { text: "—", tone: "flat" };
  const d = new Date(`${due}T12:00:00`);
  if (!Number.isFinite(d.getTime())) return { text: "—", tone: "flat" };
  const today = new Date();
  const days = Math.round(
    (new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() -
      new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()) /
      86400000,
  );
  if (days < 0) return { text: `${Math.abs(days)}d late`, tone: "late" };
  if (days === 0) return { text: "Today", tone: "late" };
  if (days === 1) return { text: "Tomorrow", tone: "warn" };
  if (days <= 6) return { text: `${days}d`, tone: "warn" };
  return {
    text: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    tone: "flat",
  };
}

export function isOverdue(card: OpportunityCard): boolean {
  return !!card.next_activity?.due_date && dueLabel(card.next_activity.due_date).tone === "late";
}

/**
 * Board card. White, hairline border, soft shadow — deal name, address, value,
 * source, owner and the next activity with its urgency. Two washes can apply
 * and they never mean the same thing: yellow is awaiting Sales Head approval,
 * pale red is past the stage rot window.
 */
const BoardCard = React.forwardRef<
  HTMLDivElement,
  CardProps & React.HTMLAttributes<HTMLDivElement>
>(function BoardCard(
  {
    card,
    locationCode,
    repName,
    writesDisabled,
    onApprove,
    approving,
    rotting,
    snooze,
    onSnooze,
    snoozing,
    onCreateProposal,
    overlay,
    won,
    showMoney = true,
    density = "normal",
    ...rest
  },
  ref,
) {
  const nav = useRowNav(card.full_access ? `/accounts/${card.id}` : null);
  const lossTypes = useLossTypes();
  const pending = isAwaitingApproval(card.approval_state);
  const navProps = overlay ? {} : (nav ?? {});
  const due = dueLabel(card.next_activity?.due_date ?? null);
  const [line1, line2] = (card.address ?? "").split(" · ");

  /*
   * Compact drops everything that is not name, money and owner. It is for
   * finding one card among forty, and every line kept is a line in the way.
   * Full adds what the card already knows but never showed.
   */
  const compact = density === "compact";
  const full = density === "full";
  const days = ageDays(card);

  return (
    <div
      ref={ref}
      {...navProps}
      {...rest}
      aria-label={card.name}
      className={cn(
        "rounded-[10px] border border-[var(--border)] bg-card shadow-[0_1px_2px_rgb(16_24_40_/_0.06)]",
        compact ? "px-2.5 py-1.5" : "px-3 py-2.5",
        !overlay && "transition-shadow hover:shadow-[0_4px_10px_rgb(16_24_40_/_0.10)]",
        nav && !overlay && ROW_NAV_CLASS,
        !writesDisabled && "cursor-grab active:cursor-grabbing",
        rotting && "rot-card",
        pending && AWAITING_APPROVAL_CARD,
        overlay && "cursor-grabbing",
        rest.className,
      )}
      style={
        overlay
          ? { transform: "scale(1.02)", boxShadow: "0 8px 20px rgba(16,24,40,0.16)", ...rest.style }
          : rest.style
      }
    >
      {pending && (
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.03em] text-warning">
          <span className="flex items-center gap-1">
            <Clock className="size-3" />
            {approvalLabel(card.approval_state, card.approval_due_on)}
          </span>
          {onApprove && (
            <button
              type="button"
              {...stopRowClick}
              disabled={writesDisabled || approving}
              onClick={(e) => {
                e.stopPropagation();
                onApprove(card);
              }}
              className="rounded-full border border-current px-1.5 py-px uppercase disabled:opacity-50"
            >
              {approving ? "…" : "Approve"}
            </button>
          )}
        </div>
      )}

      {/*
       * The snooze sits with the warning it answers, on the cards that are
       * warning. Mark: "The rep can hit snooze once if they know something the
       * system does not, like the office being closed for a holiday."
       *
       * `stopRowClick` is doing two jobs at once and both are load-bearing: its
       * onClick keeps the press off the card's row navigation, and its
       * onPointerDown keeps it off the dnd-kit listener spread on the same card
       * root, so a snooze can never start a drag and a drag can never snooze.
       */}
      {snooze && (
        <div className="mb-1.5 flex items-center justify-between gap-2 text-[10px] font-semibold uppercase tracking-[0.03em] text-[var(--destructive)]">
          <span className="flex min-w-0 items-center gap-1">
            <AlarmClock className="size-3 shrink-0" />
            <span className="truncate">{snooze.status}</span>
          </span>
          <button
            type="button"
            {...stopRowClick}
            disabled={writesDisabled || snoozing || snooze.disabled || !onSnooze}
            title={snooze.hint}
            aria-label={`${snooze.label} — ${snooze.hint}`}
            onClick={(e) => {
              e.stopPropagation();
              onSnooze?.(card);
            }}
            className="shrink-0 rounded-full border border-current px-1.5 py-px uppercase focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            {snoozing ? "…" : snooze.label}
          </button>
        </div>
      )}

      <div className="flex items-start gap-2.5">
        <LossGlyph keys={card.what_they_do} lossTypes={lossTypes} />
        <div className="min-w-0 flex-1">
          <Link
            to="/accounts/$id"
            params={{ id: card.id }}
            {...stopRowClick}
            className="block truncate text-[13px] font-semibold leading-[18px] text-[var(--foreground)] hover:underline"
          >
            {card.name}
          </Link>
          {!compact && line1 && (
            <div className="truncate text-[11.5px] leading-[16px] text-[var(--muted-foreground)]">
              {line1}
            </div>
          )}
          {!compact && line2 && (
            <div className="truncate text-[11.5px] leading-[16px] text-[var(--muted-foreground)]">
              {line2}
            </div>
          )}
          {full && card.contacts.length > 0 && (
            <div className="truncate text-[11.5px] leading-[16px] text-[var(--muted-foreground)]">
              {card.contacts.slice(0, 2).join(", ")}
              {card.contacts.length > 2 ? ` +${card.contacts.length - 2}` : ""}
            </div>
          )}
        </div>
      </div>

      {showMoney && (
        <div
          className={cn(
            compact
              ? "mt-1 text-[13px] font-semibold tabular-nums"
              : "mt-2 text-[14px] font-semibold tabular-nums",
            won ? "text-[var(--success)]" : "text-[var(--primary)]",
          )}
        >
          {fmtMoney(card.value)}
        </div>
      )}

      {won ? (
        card.stage_changed_at && (
          <div className="mt-0.5 text-[11.5px] text-[var(--muted-foreground)]">
            Closed: {new Date(card.stage_changed_at).toLocaleDateString(DATE_LOCALE, US_DATE)}
          </div>
        )
      ) : compact ? null : (
        <div className="mt-0.5 truncate text-[11.5px] text-[var(--muted-foreground)]">
          Source: {card.source ?? "—"}
          {full && days != null ? ` · ${days}d in stage` : ""}
          {full && card.attachment_count > 0 ? ` · ${card.attachment_count} file(s)` : ""}
        </div>
      )}

      {!compact && <CardLabels id={card.id} />}

      <div className={cn("flex items-center justify-between gap-2", compact ? "mt-1" : "mt-2")}>
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-[#4A5A70] dark:text-muted-foreground">
          <RepAvatar name={repName(card.assigned_rep)} />
          <span className="truncate">{repName(card.assigned_rep)}</span>
        </span>
        {won && (
          <span className="shrink-0 rounded-md bg-[#E6F6EF] dark:bg-[color-mix(in_oklab,var(--success)_18%,var(--card))] px-2 py-0.5 text-[11px] font-semibold text-[var(--success)]">
            Won
          </span>
        )}
        {/*
          The same `stopRowClick` pair as the snooze: the press neither opens
          the record nor starts a drag.
        */}
        {!won && !overlay && onCreateProposal && card.full_access && (
          <button
            type="button"
            {...stopRowClick}
            disabled={writesDisabled}
            title="Create proposal"
            aria-label={`Create proposal for ${card.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onCreateProposal(card);
            }}
            className="flex shrink-0 items-center gap-1 rounded-md border border-[var(--border)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          >
            <FileSignature className="size-3" />
            {compact ? null : "Proposal"}
          </button>
        )}
      </div>

      {!won && !compact && (
        <div className="mt-2 flex items-center justify-between gap-2 border-t border-[var(--border)] pt-1.5 text-[11.5px]">
          <span className="flex min-w-0 items-center gap-1.5 text-[var(--muted-foreground)]">
            <CalendarDays className="size-3.5 shrink-0" />
            <span className="truncate">{card.next_activity?.title ?? "No next activity"}</span>
          </span>
          <span
            className={cn(
              "shrink-0 tabular-nums",
              due.tone === "late"
                ? "font-semibold text-[var(--destructive)]"
                : due.tone === "warn"
                  ? "font-semibold text-[var(--warning)]"
                  : "text-[var(--muted-foreground)]",
            )}
          >
            {due.text}
          </span>
        </div>
      )}
    </div>
  );
});

/** Initials chip standing in for the rep photo in the mockups. */
function RepAvatar({ name }: { name: string }) {
  const initials =
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase())
      .join("") || "—";
  return (
    <span
      aria-hidden
      className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-[9px] font-semibold text-muted-foreground"
    >
      {initials}
    </span>
  );
}

/** Colour-coded loss glyph, tinted from the managed loss-type palette. */
function LossGlyph({
  keys,
  lossTypes,
}: {
  keys: string[];
  lossTypes: ReturnType<typeof useLossTypes>;
}) {
  const key = keys[0];
  if (!key) return null;
  const mapped = lossTypes.badgeForKey(key);
  // Fall back to the key itself when the option list carries no colour token.
  const token = /text-loss-([a-z]+)/.exec(mapped)?.[1] ?? key.toLowerCase();
  const cls = mapped.includes("text-loss-") ? mapped : `bg-loss-${token}/10 text-loss-${token}`;
  const Icon =
    token === "fire" || token === "smoke"
      ? Flame
      : token === "storm"
        ? CloudRain
        : token === "mold" || token === "biohazard"
          ? Bug
          : token === "cleaning" || token === "asbestos"
            ? Wind
            : token
              ? Droplets
              : AlertTriangle;
  return (
    <span
      aria-hidden
      className={cn("grid size-7 shrink-0 place-items-center rounded-lg", cls)}
      title={lossTypes.labelForKey(key)}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** Draggable wrapper — pointer sensors only, so it works on touch too. */
function DraggableCard(props: CardProps & { disabled: boolean; moving: boolean }) {
  const { disabled, moving, ...cardProps } = props;
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: props.card.id,
    disabled,
  });

  // At the origin we leave a flat placeholder, never a faded copy of the card.
  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        aria-hidden
        className="rounded-lg border border-dashed bg-muted/40"
        style={{ height: 84 }}
      />
    );
  }

  return (
    <BoardCard
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      {...cardProps}
      className={cn(moving && "opacity-60")}
    />
  );
}

/* ----------------------------------------------------------------- kanban */

/**
 * A stage's colour belongs to its header, not to a rule floating above it.
 *
 * The board used to print a 3px bar above each column, outside the header and
 * outside anything it described, which read as a row of unexplained coloured
 * lines across the top of the page. The colour now tints the band that already
 * carries the stage name and its count, and closes that band with a line in the
 * same hue. Same identity, inside the thing it identifies.
 *
 * The colour is the stage's TONE, by key (`stageTone`, lib/stage-tone.ts) —
 * the same colour the record's rail, the grid and list badges and the
 * Timeline's stage rows use, so Conversation Established is amber wherever a
 * rep meets it. Mark: "the colors here in the pipeline aren't exciting." The
 * admin-picked hex it used to read had no dark value and gave adjacent stages
 * the same colour. The band is the tone's soft tint (legible under
 * `--foreground` in both themes), closed by a solid line and led by a dot in
 * the full tone; the stage name is always there, so colour is never the only
 * signal.
 */
function stageTint(key: string | null | undefined): string {
  return stageTone(key).softColor;
}

function stageEdge(key: string | null | undefined): string {
  return stageTone(key).color;
}

/** A stage name with its colour: the grid's and the list's stage badge. */
function StageBadge({
  stage,
  className,
}: {
  stage: PipelineStage | undefined;
  className?: string;
}) {
  if (!stage) return <span className={className}>—</span>;
  const tone = stageTone(stage.key);
  return (
    <span
      data-stage-tone={tone.name}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold",
        tone.soft,
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
      <span className="truncate">{stage.name}</span>
    </span>
  );
}

/** Not a stage id: stage ids are uuids, so this can never collide with one. */
export const ACTIVE_CLIENTS_DROP_ID = "active-clients-drop";

/**
 * The stage Active Clients would be if it were one, so the expanded tile can
 * be a real `Column` instead of a second card design that drifts away from the
 * board it sits in. Its id doubles as the drop id, which is what keeps the
 * expanded column a place you can still drop a deal onto.
 */
const ACTIVE_CLIENTS_STAGE: PipelineStage = {
  id: ACTIVE_CLIENTS_DROP_ID,
  pipeline_id: "",
  key: "active_clients",
  name: "Active Clients",
  sort_order: 0,
  color: "var(--success)",
  probability: 100,
  is_won: true,
  is_lost: false,
  wip_limit: null,
  is_active: true,
};

/**
 * Active Clients: the count, the place you drop a deal to win one, and -- one
 * click in -- the clients themselves.
 *
 * Mark asked for the drill-down twice and was clear the second time that a
 * page was not it: "what happened to be able to click on the active clients to
 * open it as a full size card and show all the deals in there", then "and that
 * size should be the collapsed view" of the narrow tile he had screenshotted.
 * So the two states are one thing that grows, not a door to somewhere else --
 * collapsed is the tile exactly as it shipped, expanded is a column the width
 * and shape of every other column on the board.
 *
 * Collapsed on every load, deliberately. Fold state persists per user because
 * a rep works the same few stages every day; this is a peek at a list that
 * lives on its own page, and coming back tomorrow to a board with a column
 * bolted onto the end of it would be a surprise nobody asked for.
 */
function ActiveClientsTile({
  clients,
  dragging,
  draggingId,
  disabled,
  expanded,
  onToggle,
  props,
}: {
  clients: OpportunityCard[];
  dragging: boolean;
  draggingId: string | null;
  disabled: boolean;
  expanded: boolean;
  onToggle: () => void;
  props: BoardProps;
}) {
  if (expanded) {
    /* The board's own column, with the clients as its cards. Nothing here is
       drawn twice: the header, the tint, the count and the cards are the ones
       every stage gets, which is the whole point of "a full size card".
       Two components rather than two branches inside one, because each of them
       calls `useDroppable` with this same id: rendered together they would
       fight over one entry in dnd-kit's registry, and whichever unmounted last
       would take the drop target with it. */
    return (
      <Column
        stage={ACTIVE_CLIENTS_STAGE}
        cards={clients}
        props={props}
        draggingId={draggingId}
        layout={{ index: 0, folded: false, placement: "open" }}
        onToggleFold={onToggle}
        asActiveClients
      />
    );
  }
  return (
    <ActiveClientsStrip
      clients={clients}
      dragging={dragging}
      disabled={disabled}
      onToggle={onToggle}
    />
  );
}

/** Collapsed: the trophy, the count, and the place a won deal gets dropped. */
function ActiveClientsStrip({
  clients,
  dragging,
  disabled,
  onToggle,
}: {
  clients: OpportunityCard[];
  dragging: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: ACTIVE_CLIENTS_DROP_ID, disabled });
  /* Half of the click-versus-drop question -- `togglesActiveClients` is the
     other half, and explains why a mouse-up alone is not enough. */
  const pressedOnTile = React.useRef(false);

  return (
    <div
      ref={setNodeRef}
      aria-label="Active Clients drop target"
      data-placement="active-clients"
      className={cn(
        /* Full height, not self-start. Mark: "this needs to be as long as the
           longest box", and again as "this needs to follow down too". A short
           tile floating beside a full column reads as an afterthought, and it
           is the target you drop a won deal onto -- the taller it is, the
           easier it is to hit. `self-stretch` says so outright rather than
           leaning on the flex default, which an `items-start` anywhere up the
           chain would quietly cancel. The folded stage strips run the full
           height now too, for the same reason this one always did. */
        "flex w-[112px] shrink-0 snap-start flex-col items-center gap-1 self-stretch rounded-xl border border-dashed border-[var(--border)] px-2 pb-3 text-center",
        "bg-[color-mix(in_oklab,var(--success)_8%,var(--card))]",
        /* Only worth shouting about while something is being dragged. The rest
           of the time it is a number, not an invitation. */
        dragging && !isOver && "border-primary/40",
        isOver && "border-primary bg-primary/15 ring-2 ring-primary",
      )}
    >
      {/* A real <button>, so Enter and Space work and the focus ring is the
          browser's, and the whole tile is the target: it is already full
          height for the drop, and a taller door is an easier one to hit. */}
      <button
        type="button"
        aria-expanded={false}
        aria-label={`Show all ${clients.length} active clients`}
        title="Show all active clients"
        onPointerDown={() => {
          pressedOnTile.current = true;
        }}
        onClick={(e) => {
          const toggles = togglesActiveClients(e, pressedOnTile.current);
          pressedOnTile.current = false;
          if (toggles) onToggle();
        }}
        className="flex w-full flex-1 flex-col items-stretch rounded-lg px-1 transition-colors hover:bg-[color-mix(in_oklab,var(--foreground)_6%,transparent)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
      >
        {/* Mark, twice: "this needs to be sticky and not in the center", then,
            with the count long gone off the top of a scrolled page, "the title
            doesnt stay sticky like the other headers". The first time the
            answer was to move the count to the top and leave it there; sticky
            could not resolve because the button filled the tile and gave its
            contents nowhere to travel. So the button still fills the tile --
            it is the drop target and the click -- and this block inside it is
            what sticks, the same way the open column headers do. The tile
            itself stays put for dnd-kit, which adds the scroll to a measured
            rect and would mislocate a target that had stopped moving. */}
        <span className="flex flex-col items-center gap-1 pb-1 pt-4 md:sticky md:top-0">
          <Trophy className="size-4 text-[var(--muted-foreground)]" />
          <span className="text-[20px] font-bold leading-none tabular-nums text-[var(--foreground)]">
            {clients.length}
          </span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-foreground)]">
            Active clients
          </span>
          {dragging && (
            <span className="text-[10px] leading-tight text-[var(--muted-foreground)]">
              Drop to win
            </span>
          )}
        </span>
      </button>
    </div>
  );
}

function Column({
  stage,
  cards,
  props,
  draggingId,
  layout,
  onToggleFold,
  asActiveClients = false,
}: {
  stage: PipelineStage;
  cards: OpportunityCard[];
  props: BoardProps;
  draggingId: string | null;
  /** Where this column sits and how it shares the width — see `layoutColumns`. */
  layout: ColumnLayout;
  onToggleFold: (stageId: string) => void;
  /**
   * Active Clients borrows this column so that "a full size card" is literally
   * the same card, header and tint every stage gets. Three things differ, and
   * all three are about what these rows are: they are clients, not deals.
   *
   *  - the collapse control reports `aria-expanded`, because it collapses the
   *    tile back rather than folding a stage the caller has persisted;
   *  - the cards do not drag out. Moving a client back onto the funnel is a
   *    reversion with its own confirmation (src/lib/pipeline-reversion.ts),
   *    and a stray drag must not be able to do it silently;
   *  - there is no "Add Opportunity" — you win a client, you do not file one.
   *
   * Dropping a deal IN is untouched: the column keeps the drop id.
   */
  asActiveClients?: boolean;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: props.writesDisabled });
  const overWip = stage.wip_limit != null && cards.length > stage.wip_limit;
  const showGap = isOver && draggingId != null && !cards.some((c) => c.id === draggingId);
  const total = cards.reduce((sum, c) => sum + (c.full_access ? c.value : 0), 0);
  const money = props.showMoney !== false;

  if (layout.folded) {
    /* A folded stage is a 52px strip: its colour, the card count, the name
       read downwards, and the whole strip is the one tap that opens it. It
       stays a drop target so a card can be dragged straight onto it. */
    return (
      <div
        ref={setNodeRef}
        aria-label={`${stage.name} drop target`}
        data-placement={layout.placement}
        /* A folded stage has no header band to tint, so the strip itself carries
           the colour. It goes on the wrapper, not on the button, because an
           inline background would beat the button's `hover:` class. */
        style={stage.is_won || isOver ? undefined : { backgroundColor: stageTint(stage.key) }}
        className={cn(
          /* Full column height, and the label rides the top of the screen.
             Mark: "when collapsed it still needs to scroll down with you."

             This strip used to be `self-start` -- its own 160px, no taller --
             because a 52px sliver running the whole page had been its own
             complaint. That left the label at the top of the page, so once
             you had scrolled past it the strip was an unlabelled edge and,
             further down, nothing at all. Now it runs the height of the board
             and the chevron, count and name stick to the top of the screen
             the way the open headers do, so a folded stage stays identifiable
             and droppable wherever you are.

             The wrapper, not the label, is what dnd-kit measures, and the
             wrapper is not sticky. That is deliberate: dnd-kit re-reads a
             droppable's rect by adding the scroll since it was measured, so a
             sticky drop target that has stopped moving is mislocated by
             exactly that scroll while the drag is on. The label may stick;
             the target must not. */
          "flex w-[52px] shrink-0 snap-start flex-col rounded-xl border border-[var(--border)] bg-card shadow-[0_1px_2px_rgb(16_24_40_/_0.05)]",
          stage.is_won && "bg-[color-mix(in_oklab,var(--success)_8%,var(--card))]",
          /* Held over a folded stage, this strip is the only thing telling you
             where the card is about to go, and it is 52px wide. The open
             columns get a 1px ring because their whole area moves; this needs
             to be unmissable at a sixth of the width. */
          isOver && "border-primary bg-primary/15 ring-2 ring-primary",
        )}
      >
        {/* The button is the whole strip, so the tap that opens it works from
            anywhere down the page; the block inside it is what sticks. Its
            padding is on the block rather than the button so the chevron does
            not sit flush against the top edge once it is pinned there. */}
        <button
          type="button"
          aria-label={`Expand ${stage.name}`}
          title={`Expand ${stage.name}`}
          onClick={() => onToggleFold(stage.id)}
          className="flex flex-1 flex-col items-stretch rounded-xl px-1 text-[var(--foreground)] hover:bg-[var(--hover)]"
        >
          <span className="flex min-h-[160px] flex-col items-center gap-2.5 py-2.5 md:sticky md:top-0">
            <ChevronLeft className="size-4 shrink-0 text-[var(--muted-foreground)]" />
            <span
              aria-hidden
              className={cn("size-2.5 shrink-0 rounded-full", stageTone(stage.key).dot)}
            />
            <span
              className={cn(
                "min-w-[22px] shrink-0 rounded-full px-1.5 py-px text-center text-[11px] font-semibold tabular-nums",
                overWip
                  ? "bg-[var(--destructive)]/10 text-[var(--destructive)]"
                  : "bg-muted text-[var(--muted-foreground)]",
              )}
            >
              {cards.length}
            </span>
            <span
              className="max-h-[220px] truncate whitespace-nowrap text-[12px] font-semibold"
              style={{ writingMode: "vertical-rl" }}
            >
              {stage.name}
            </span>
          </span>
        </button>
      </div>
    );
  }

  return (
    <div
      ref={setNodeRef}
      className={cn(
        /* Phone: one stage nearly fills the viewport and snaps into place, and
           the column is height-capped so its cards scroll under a header that
           stays put.

           Desktop, Mark, with two screenshots: "cards need to auto resize to
           the cards above it". The row above the board fills the page; six
           columns at a fixed 268px left dead space beside them, and seven ran
           off the edge. So a column asks for 268px and grows to share whatever
           the strip has, up to 420px each, and only once every column is at
           its 268 does the page scroll sideways as it did before.

           `grow` with `basis-auto`, not `flex-1`. The page is `w-max` to the
           board (see pipeline.index.tsx), so the strip's natural width is what
           sizes the page, and a column whose basis is 0% contributes its
           CONTENT width to that -- the Active Clients board measured 379px a
           column from one long name. With the basis pinned to the width it
           asks for, the page grows by exactly 268 a column. */
        "flex max-h-[70svh] w-[85vw] max-w-[300px] shrink-0 snap-start flex-col rounded-xl border border-[var(--border)] bg-card shadow-[0_1px_2px_rgb(16_24_40_/_0.05)] md:max-h-none md:w-[268px] md:max-w-[420px] md:grow md:basis-auto",
        stage.is_won && "bg-[color-mix(in_oklab,var(--success)_8%,var(--card))]",
        isOver && "ring-1 ring-primary/40",
      )}
    >
      {/* The stage colour is the header band — see `stageTint`. */}
      <div
        /*
         * Mark: "it should still scroll down the screen, just the card titles
         * need to be stickied to the top of the screen like a website header."
         *
         * The first attempt capped the COLUMN height so the cards scrolled
         * inside it, and he rejected it: the page stopped moving. This is the
         * other shape -- the page scrolls as it always did, and the header
         * rides the top of the screen.
         *
         * The cards container below now has a 500px cap of its own, for
         * Melly's empty gap. That is not the shape Mark sent back: the column
         * is still `md:max-h-none` and the page still owns the vertical
         * scroll, so this header still sticks to the top of the screen on the
         * way down. What changed is only how tall the tallest column can get.
         *
         * It only resolves because the strip below is no longer a scroll
         * container. A sticky element sticks to its nearest scrollport, and
         * `overflow-x: auto` computes `overflow-y: auto` on the same box, which
         * parks the header in a scrollport that never scrolls vertically. In a
         * reproduction of this container chain the header sat at -691px after a
         * 700px scroll; handing the scroll to <main> puts it at 0px, and it
         * holds there after 1906px of sideways scrolling through eight columns.
         *
         * The phone keeps its own column height and its snap paging, which
         * nobody complained about, so this stays off there.
         */
        className="shrink-0 rounded-t-xl border-b-2 px-3 pb-2.5 pt-2.5 md:sticky md:top-0 md:z-10"
        data-stage-tone={stageTone(stage.key).name}
        style={{
          backgroundColor: stageTint(stage.key),
          borderBottomColor: stageEdge(stage.key),
        }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-semibold text-[var(--foreground)]">
              <span
                aria-hidden
                className={cn("size-2.5 shrink-0 rounded-full", stageTone(stage.key).dot)}
              />
              <span className="truncate">{stage.name}</span>
            </div>
            <div
              className={cn(
                "mt-0.5 text-[11.5px] tabular-nums",
                overWip ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]",
              )}
              title={stage.wip_limit != null ? `Limit ${stage.wip_limit}` : undefined}
            >
              {money && <>{compactMoney(total)} · </>}
              {cards.length}
              {stage.wip_limit != null ? ` / ${stage.wip_limit}` : ""}
            </div>
          </div>
          <button
            type="button"
            aria-expanded={asActiveClients ? true : undefined}
            aria-label={`Collapse ${stage.name}`}
            title={`Collapse ${stage.name}`}
            onClick={() => onToggleFold(stage.id)}
            className="mt-0.5 shrink-0 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      {/*
        The cards scroll INSIDE the column, capped at 500px.

        Melly, 17 Sep: deal cards "leave an odd empty gap below them... make all
        these deals a little bigger to fill this little gap... size it to the
        thing." The gap was the column stretching to the tallest one on the
        board and the cards sitting at the top of all that space. Capping the
        height is what removes it — the cards keep their own size, and a column
        with more than fits scrolls rather than growing.

        The cap is the same on every column, so the board reads level whether a
        stage holds two deals or twenty. `scroll-smooth` is on the container
        only; the board's horizontal scrolling and the sticky column headers
        above are untouched.

        overscroll-contain stops a flick at the end of a column from carrying
        on and scrolling the page behind it, which on a phone reads as the
        board jumping.
      */}
      <div
        className={cn(
          "flex max-h-[500px] min-h-[96px] flex-1 flex-col gap-2.5 overflow-y-auto overscroll-contain rounded-b-xl px-2.5 py-2.5",
          /*
            Smooth ONLY when nothing is being dragged. dnd-kit auto-scrolls a
            scrollable container by setting scrollTop itself, many times a
            second; CSS scroll-behavior: smooth animates every one of those,
            so the auto-scroll lags behind the cursor and a card dropped near
            the edge lands in the wrong place. Dragging gets instant scrolling,
            a thumb gets the smooth one.
          */
          draggingId == null && "scroll-smooth",
        )}
      >
        {cards.length === 0 && !showGap ? (
          <div className="py-6 text-center text-[12px] text-[var(--muted-foreground)]">
            {asActiveClients ? "No active clients yet" : `No opportunities in ${stage.name}`}
          </div>
        ) : (
          cards.map((c) =>
            asActiveClients ? (
              <BoardCard
                key={c.id}
                card={c}
                locationCode={props.locationCode}
                repName={props.repName}
                writesDisabled={props.writesDisabled}
                won
                showMoney={money}
                density={props.density}
              />
            ) : (
              <DraggableCard
                key={c.id}
                card={c}
                locationCode={props.locationCode}
                repName={props.repName}
                writesDisabled={props.writesDisabled}
                onApprove={props.onApprove}
                approving={props.approvingId === c.id}
                rotting={isRotting(c, props.rotDays, props.ruleWarning)}
                snooze={props.snooze?.get(c.id)}
                onSnooze={props.onSnooze}
                snoozing={props.snoozingId === c.id}
                onCreateProposal={props.onCreateProposal}
                won={stage.is_won}
                showMoney={money}
                density={props.density}
                disabled={props.writesDisabled || props.movingId === c.id}
                moving={props.movingId === c.id}
              />
            ),
          )
        )}

        {/* Insertion gap — where the card will land. */}
        {showGap && (
          <div
            aria-hidden
            className="rounded-[10px] border border-dashed border-primary/50 bg-primary/5"
            style={{ height: 96 }}
          />
        )}

        {props.onAddToStage && !props.writesDisabled && !asActiveClients && (
          <button
            type="button"
            onClick={() => props.onAddToStage!(stage)}
            className="flex items-center justify-center gap-1.5 rounded-[10px] py-2 text-[12.5px] font-medium text-[var(--primary)] hover:bg-[var(--hover)]"
          >
            <Plus className="size-3.5" /> Add Opportunity
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ board */

export function PipelineBoard(raw: BoardProps) {
  /* A card another office owns is not drawn at all — no locked stub saying its
     details are withheld. The board, its counts and its totals are about the
     cards this person may open. */
  const cards = React.useMemo(() => raw.cards.filter((c) => c.full_access), [raw.cards]);
  const activeClients = React.useMemo(
    () => raw.activeClients?.filter((c) => c.full_access),
    [raw.activeClients],
  );
  const props = { ...raw, cards, activeClients };
  const ids = React.useMemo(() => cards.map((c) => c.id), [cards]);
  const labelsQ = useQuery({
    queryKey: ["pipeline-card-labels", ids],
    enabled: ids.length > 0,
    queryFn: () => fetchLabelMap("account", ids),
  });
  return (
    <LabelMapContext.Provider value={labelsQ.data ?? {}}>
      <PipelineBoardInner {...props} />
    </LabelMapContext.Provider>
  );
}

function PipelineBoardInner(props: BoardProps) {
  const { stages, cards, view, onToggleFold: toggleFoldProp } = props;
  const [draggingId, setDraggingId] = React.useState<string | null>(null);

  /* Session state on purpose, and not even that -- it resets on every mount.
     See the comment on ActiveClientsTile for why this one does not persist the
     way folded stages do. */
  const [activeClientsExpanded, setActiveClientsExpanded] = React.useState(false);
  const toggleActiveClients = React.useCallback(() => {
    setActiveClientsExpanded((v) => !v);
  }, []);

  // Fold state: the caller's (persisted per user) when given, else this
  // session's. Stage ids, so it survives a filter change re-ordering nothing.
  const [localFolded, setLocalFolded] = React.useState<ReadonlySet<string>>(() => new Set());
  const folded = props.folded ?? localFolded;
  const onToggleFold = React.useCallback(
    (stageId: string) => {
      if (toggleFoldProp) {
        toggleFoldProp(stageId);
        return;
      }
      setLocalFolded((cur) => {
        const next = new Set(cur);
        if (next.has(stageId)) next.delete(stageId);
        else next.add(stageId);
        return next;
      });
    },
    [toggleFoldProp],
  );

  const layout = React.useMemo(
    () =>
      layoutColumns(
        stages.length,
        stages.flatMap((s, i) => (folded.has(s.id) ? [i] : [])),
      ),
    [stages, folded],
  );
  // On a phone the board is one column per screen with nowhere to tuck a
  // strip beside it, so folded end stages stay inline in the scroll strip.
  const isMobile = useIsMobile();

  // Pointer/touch sensors, not the HTML5 drag API — that one paints its own
  // blurred ghost and does nothing at all on a phone. The distance threshold
  // keeps a tap on the card navigating instead of starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const byStage = React.useMemo(() => {
    const m = new Map<string, OpportunityCard[]>();
    for (const s of stages) m.set(s.id, []);
    for (const c of cards) {
      if (!c.stage_id) continue;
      const list = m.get(c.stage_id);
      if (list) list.push(c);
    }
    // Mark: "rank by overdue tasks, closest due date, then age" — said of the
    // Active Clients board, then "pipeline as well". Newest-created first was
    // the old order and told a rep nothing about what was owed.
    for (const list of m.values()) {
      list.sort((a, b) => compareByUrgency(urgencyOf(a), urgencyOf(b)));
    }
    return m;
  }, [stages, cards]);

  const dragging = draggingId ? cards.find((c) => c.id === draggingId) : null;

  const activeClients = props.activeClients ?? [];
  const showTile = props.activeClients != null && !!props.onActivate;

  const onDragStart = (e: DragStartEvent) => setDraggingId(String(e.active.id));
  const onDragEnd = (e: DragEndEvent) => {
    setDraggingId(null);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const card = cards.find((c) => c.id === String(e.active.id));
    if (!card || !card.full_access) return;

    // Winning a client is not a stage move. It sets the account's lifecycle
    // status and starts the client clock, so it goes through its own path.
    if (overId === ACTIVE_CLIENTS_DROP_ID) {
      props.onActivate?.(card);
      return;
    }

    const stage = stages.find((s) => s.id === overId);
    if (stage && card.stage_id !== stage.id) props.onMove(card, stage);
  };

  if (stages.length === 0) {
    return <EmptyLine>This pipeline has no active stages. Add one in Admin → Pipelines.</EmptyLine>;
  }

  if (view === "kanban") {
    return (
      <DndContext
        sensors={sensors}
        collisionDetection={pointerFirst}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDraggingId(null)}
      >
        {/* Two rows side by side: the strip of open and inline-folded columns,
            then the folded end stages tucked against the right edge of the
            page. The edge strips sit outside the strip on purpose: they stay
            put and reachable while it scrolls, and dnd-kit measures them once
            as static drop targets. */}
        <div className={cn("flex flex-1 gap-3", draggingId && "cursor-grabbing")}>
          {/* The sideways scroll belongs to this strip on a phone and to the
              page on a desktop. While the strip owned it everywhere, nothing
              inside could stick to the top of the screen -- see the column
              header above for why. */}
          <div className="flex min-w-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none md:overflow-x-visible">
            {stages.map((s, i) => {
              const col = layout[i]!;
              if (col.placement === "edge" && !isMobile) return null;
              return (
                <React.Fragment key={s.id}>
                  <Column
                    stage={s}
                    cards={byStage.get(s.id) ?? []}
                    props={props}
                    draggingId={draggingId}
                    layout={col}
                    onToggleFold={onToggleFold}
                  />
                  {showTile && props.activeClientsAfterStageId === s.id && (
                    <ActiveClientsTile
                      clients={activeClients}
                      dragging={draggingId != null}
                      draggingId={draggingId}
                      disabled={props.writesDisabled}
                      expanded={activeClientsExpanded}
                      onToggle={toggleActiveClients}
                      props={props}
                    />
                  )}
                </React.Fragment>
              );
            })}
          </div>
          {/* Held against the right edge while the page scrolls sideways under
              it, which is where it sat back when the strip did the scrolling.
              A folded end stage is a drop target, and one you have to go
              looking for is not much of one. The negative margin lets its
              background cover the gap so cards do not show through. */}
          <div className="flex shrink-0 gap-3 md:sticky md:right-0 md:z-20 md:-ml-3 md:bg-[var(--surface)] md:pl-3">
            {!isMobile &&
              stages.map((s, i) => {
                const col = layout[i]!;
                if (col.placement !== "edge") return null;
                return (
                  <div key={s.id} className="flex shrink-0 pb-2">
                    <Column
                      stage={s}
                      cards={byStage.get(s.id) ?? []}
                      props={props}
                      draggingId={draggingId}
                      layout={col}
                      onToggleFold={onToggleFold}
                    />
                  </div>
                );
              })}
            {showTile && props.activeClientsAfterStageId == null && (
              <div className="flex shrink-0 pb-2">
                <ActiveClientsTile
                  clients={activeClients}
                  dragging={draggingId != null}
                  draggingId={draggingId}
                  disabled={props.writesDisabled}
                  expanded={activeClientsExpanded}
                  onToggle={toggleActiveClients}
                  props={props}
                />
              </div>
            )}
          </div>
        </div>
        <DragOverlay dropAnimation={null}>
          {dragging ? (
            <div className="w-[252px]">
              {/* A picture of the card mid-drag: the same snooze strip, no handler. */}
              <BoardCard
                overlay
                card={dragging}
                density={props.density}
                locationCode={props.locationCode}
                repName={props.repName}
                writesDisabled={props.writesDisabled}
                rotting={isRotting(dragging, props.rotDays, props.ruleWarning)}
                snooze={props.snooze?.get(dragging.id)}
              />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    );
  }

  if (view === "grid") {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {cards.map((c) => (
          <div key={c.id} className="flex flex-col gap-1">
            <div className="flex items-center px-0.5">
              <StageBadge stage={stages.find((s) => s.id === c.stage_id)} />
            </div>
            <BoardCard
              card={c}
              locationCode={props.locationCode}
              repName={props.repName}
              writesDisabled={props.writesDisabled}
              onApprove={props.onApprove}
              approving={props.approvingId === c.id}
              rotting={isRotting(c, props.rotDays, props.ruleWarning)}
              snooze={props.snooze?.get(c.id)}
              onSnooze={props.onSnooze}
              snoozing={props.snoozingId === c.id}
              onCreateProposal={props.onCreateProposal}
              showMoney={props.showMoney !== false}
            />
          </div>
        ))}
      </div>
    );
  }

  return (
    /* The list view is a wide table — it scrolls inside its own box, so the
       page body never gains a horizontal scrollbar on a phone. */
    <div className="overflow-x-auto md:max-h-[75svh] md:overflow-auto rounded-md border">
      <table className="w-full min-w-[640px] text-[13px]">
        <thead className="text-[11px] text-muted-foreground">
          <tr className="[&>th]:px-2 [&>th]:py-1.5 [&>th]:text-left">
            <th>Account</th>
            <th>Stage</th>
            <th>Owner</th>
            <th>Office</th>
            {/* Money rule: no revenue column at all for a role without it. */}
            {props.showMoney !== false ? <th className="text-right">Revenue to date</th> : null}
            <th className="text-right">Age</th>
          </tr>
        </thead>
        <tbody>
          {cards.map((c) => (
            <ListRow key={c.id} card={c} rotting={isRotting(c, props.rotDays, props.ruleWarning)}>
              <td className="max-w-[240px] truncate">
                <Link to="/accounts/$id" params={{ id: c.id }} className="hover:underline">
                  {c.name}
                </Link>
              </td>
              <td>
                <StageBadge stage={stages.find((s) => s.id === c.stage_id)} />
              </td>
              <td>{props.repName(c.assigned_rep)}</td>
              <td>{c.owning_location_code ?? props.locationCode(c.location_id)}</td>
              {props.showMoney !== false ? (
                <td className="text-right tabular-nums">{fmtMoney(c.actual_revenue)}</td>
              ) : null}
              <td className="text-right tabular-nums">{ageLabel(c)}</td>
            </ListRow>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** List view row — whole row navigates, yellow while awaiting sign-off. */
function ListRow({
  card,
  rotting,
  children,
}: {
  card: OpportunityCard;
  rotting?: boolean;
  children: React.ReactNode;
}) {
  const nav = useRowNav(card.full_access ? `/accounts/${card.id}` : null);
  return (
    <tr
      {...(nav ?? {})}
      className={cn(
        "border-t [&>td]:px-2 [&>td]:py-1.5",
        nav && ROW_NAV_CLASS,
        rotting && "rot-card",
        isAwaitingApproval(card.approval_state) && AWAITING_APPROVAL_ROW,
      )}
    >
      {children}
    </tr>
  );
}
