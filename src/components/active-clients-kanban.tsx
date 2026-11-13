import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  TouchSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, rectSortingStrategy, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "@tanstack/react-router";
import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { DEFAULT_CARD_DENSITY, type CardDensity } from "@/lib/card-density";
import { daysSince, fetchStages } from "@/lib/pipeline";
import { compareByUrgency, type UrgencyCard } from "@/lib/card-urgency";
import { FARMING_PIPELINE_ID } from "@/lib/sales-pipeline";
import {
  applyClientHealthStage,
  healthMoveRefusal,
  healthStageId,
  missingHealthStageMessage,
} from "@/lib/client-health-move";
import { ACTIVE_CLIENTS_FOLD_SCOPE, useFoldedStages } from "@/lib/pipeline-fold";
import { useAppContext, useWritesDisabled } from "@/components/app-context";
// The pipeline's own money formatter, imported rather than copied: it is
// already exported, so borrowing it costs nothing and cannot drift. "$313K" has
// to read identically on both boards or the two headers stop looking related.
import { compactMoney } from "@/components/pipeline-board";
import { ClientCard, ClientLabelsProvider } from "@/components/active-clients-cards";
import { usePrefersReducedMotion } from "@/components/view-switcher";
import { HEALTH_META, type ActiveClientRow, type ClientHealthKey } from "@/lib/active-clients";

/**
 * Active Clients as a board, one column per client-health band.
 *
 * Health is computed from interaction metrics (src/lib/client-health.ts), so
 * a drag is an override and can only make things *worse*: dropping a card on
 * Critical writes the Ghosted stage to `accounts.health_stage_id`; dropping a
 * card that is At Risk because nobody has touched it in 134 days onto Healthy
 * is refused, with the reason — the way back is a touchpoint, not a drag.
 */

const COLUMNS: ClientHealthKey[] = ["healthy", "monitoring", "at_risk", "critical"];

/**
 * What the column ranking needs from a client card — see
 * src/lib/card-urgency.ts.
 *
 * The due date is the card's own next milestone, which is the earliest open
 * task on the account. "Age" is how long the client has gone without a touch,
 * because that is the clock this board is about and the one the card prints
 * ("No touch in 97 days"); when nothing has ever been logged it falls back to
 * how long they have been a client, exactly as the health verdict itself does.
 */
function urgencyOf(row: ActiveClientRow): UrgencyCard {
  return {
    id: row.accountId,
    nextDueAt: row.nextMilestone?.due ?? null,
    ageDays: row.daysSinceTouch ?? daysSince(row.clientSince),
  };
}

const COLUMN_PREFIX = "col:";
const SORT_TRANSITION = { duration: 220, easing: "cubic-bezier(0.25, 1, 0.5, 1)" };

const MUTED = "var(--muted-foreground)";

/**
 * The health colour, as the header band rather than a line above it.
 *
 * Mark, of the pipeline: "These randomly colored lines on top of the board
 * don't really make sense. They should be within the actual board." This board
 * had the same 3px rule floating above each column header, outside the thing it
 * described. The colour now tints the band that already carries the band name
 * and its count, and closes it with a line in the same hue.
 *
 * Same formula as `stageTint` / `stageEdge` in pipeline-board.tsx, deliberately
 * copied rather than shared: those are private to a file another change is
 * currently in, and two lines of color-mix are cheaper than a merge conflict
 * over a helper. The tint stays weak so `--foreground` reads on it in both
 * themes.
 */
function healthTint(color: string): string {
  return `color-mix(in oklab, ${color} 10%, var(--card))`;
}

function healthEdge(color: string): string {
  return `color-mix(in oklab, ${color} 45%, var(--border))`;
}

type MoveVars = { row: ActiveClientRow; to: ClientHealthKey; stageId: string };

/* ------------------------------------------------------------------- card */

function SortableClientCard({
  row,
  money,
  density,
  disabled,
  pending,
  active,
  reduceMotion,
  onQuickView,
}: {
  row: ActiveClientRow;
  money: boolean;
  density: CardDensity;
  disabled: boolean;
  pending: boolean;
  active: boolean;
  reduceMotion: boolean;
  /** Opens Client 360 for this card; the card itself opens the record. */
  onQuickView: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.accountId,
    data: { health: row.health },
    disabled,
    transition: reduceMotion ? null : SORT_TRANSITION,
  });

  // The origin keeps a flat placeholder, never a faded duplicate of the card.
  if (isDragging) {
    return (
      <div
        ref={setNodeRef}
        aria-hidden
        className="rounded-[10px] border border-dashed border-[var(--primary)]/50 bg-[var(--primary)]/5"
        style={{ height: 132 }}
      />
    );
  }

  return (
    <ClientCard
      ref={setNodeRef}
      density={density}
      row={row}
      money={money}
      active={active}
      pending={pending}
      onQuickView={onQuickView}
      className={cn(!disabled && "cursor-grab touch-none active:cursor-grabbing")}
      style={{ transform: CSS.Transform.toString(transform), transition: transition ?? undefined }}
      {...attributes}
      {...listeners}
    />
  );
}

/* ----------------------------------------------------------------- column */

function Column({
  health,
  rows,
  money,
  density,
  writesDisabled,
  movingId,
  selectedId,
  draggingId,
  reduceMotion,
  folded,
  onToggleFold,
  onAddClient,
  onQuickView,
}: {
  health: ClientHealthKey;
  rows: ActiveClientRow[];
  money: boolean;
  density: CardDensity;
  writesDisabled: boolean;
  movingId: string | null;
  selectedId: string | null;
  draggingId: string | null;
  reduceMotion: boolean;
  folded: boolean;
  onToggleFold: () => void;
  /** Only the band a new client can actually land in gets a footer — see below. */
  onAddClient: (() => void) | null;
  onQuickView: (row: ActiveClientRow) => void;
}) {
  const meta = HEALTH_META[health];
  const { setNodeRef, isOver } = useDroppable({
    id: `${COLUMN_PREFIX}${health}`,
    disabled: writesDisabled,
    data: { health },
  });
  const showGap = isOver && draggingId != null && !rows.some((r) => r.accountId === draggingId);
  const ids = React.useMemo(() => rows.map((r) => r.accountId), [rows]);
  // The header's money line. Only the open job's value counts, which is the
  // same number the card prints, so a column total is the sum of its cards.
  const total = rows.reduce((sum, r) => sum + (r.jobValue ?? 0), 0);

  if (folded) {
    /* A folded band is a 52px strip, the same one the pipeline folds a stage
       into: its colour, the count, the name read downwards, and the whole strip
       is the one tap that opens it again. It stays a drop target, so a card can
       be dragged straight onto a band you are not currently looking at.

       Full column height, with the label riding the top of the screen. Mark,
       of the pipeline's strip: "when collapsed it still needs to scroll down
       with you" -- and of this board, "make everything else match". The strip
       was `self-start` before, its own 160px and no taller, which left it an
       unlabelled edge once you had scrolled past its label. The wrapper is
       what dnd-kit measures and it does not stick; dnd-kit locates a droppable
       by adding the scroll to a rect it measured once, so a sticky target that
       had stopped moving would be off by that scroll for the whole drag. */
    return (
      <div
        ref={setNodeRef}
        aria-label={`${meta.label} drop target`}
        /* No header band to tint when the band is all there is, so the strip
           itself carries the colour. It sits on the wrapper rather than the
           button because an inline background beats the button's `hover:`. */
        style={isOver ? undefined : { backgroundColor: healthTint(meta.color) }}
        className={cn(
          "flex w-[52px] shrink-0 snap-start flex-col rounded-xl border border-[var(--border)] bg-card shadow-[0_1px_2px_rgb(16_24_40_/_0.05)]",
          /* Held over a folded band this strip is the only thing saying where
             the card is about to land, and it is 52px wide. The open columns
             get a 1px ring; this has to be unmissable at a fifth of the width. */
          isOver && "border-[var(--primary)] bg-[var(--primary)]/15 ring-2 ring-[var(--primary)]",
        )}
      >
        {/* The button is the whole strip, so the tap that opens it works from
            anywhere down the page; the block inside it is what sticks, and it
            carries the padding so the chevron never sits flush against the
            top edge once pinned there. */}
        <button
          type="button"
          aria-expanded={false}
          aria-label={`Expand ${meta.label}`}
          title={`Expand ${meta.label}`}
          onClick={onToggleFold}
          className="flex flex-1 flex-col items-stretch rounded-xl px-1 text-[var(--foreground)] hover:bg-[var(--hover)]"
        >
          <span className="flex min-h-[160px] flex-col items-center gap-2.5 py-2.5 md:sticky md:top-0">
            <ChevronLeft className="size-4 shrink-0" style={{ color: MUTED }} />
            <span className="min-w-[22px] shrink-0 rounded-full bg-[var(--muted)] px-1.5 py-px text-center text-[11px] font-semibold tabular-nums text-[var(--muted-foreground)]">
              {rows.length}
            </span>
            <span
              className="max-h-[220px] truncate whitespace-nowrap text-[12px] font-semibold"
              style={{ writingMode: "vertical-rl" }}
            >
              {meta.label}
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
        /* A width of its own on desktop, not `flex-1` alone. The page grows to
           the board (see farming.index.tsx), and a column sized by its contents
           makes that growth depend on the longest client name in it — measured
           at 379px a column instead of 268. It still grows to share a wide
           screen.

           On a phone this is the pipeline's carousel: one band nearly fills
           the viewport and snaps into place, and the column is height-capped
           so its cards scroll under a header that stays put. Four columns at
           264px on a 375px screen used to leave a 111px sliver of the next one
           permanently in shot and nothing to stop the scroll between bands. */
        "flex max-h-[70svh] w-[85vw] max-w-[300px] shrink-0 snap-start flex-col rounded-xl border border-[var(--border)] bg-card shadow-[0_1px_2px_rgb(16_24_40_/_0.05)] md:max-h-none md:w-[268px] md:max-w-[420px] md:grow md:basis-auto",
        isOver && "ring-1 ring-[var(--primary)]/40",
      )}
    >
      <div
        /*
         * Mark: "fix this view to have the same changes we did for pipeline as
         * well, so the colors for each card, teh freeze etc."
         *
         * The freeze: the band rides the top of the screen while the cards
         * scroll past under it, exactly as the pipeline's stage headers do. It
         * only resolves because neither the columns strip below nor the page
         * column around it is a scroll container any more — a sticky element
         * sticks to its nearest scrollport, and `overflow` on either of those
         * parks this header in a box that never scrolls vertically. Measured in
         * a reproduction of this container chain: -531px after a 700px scroll
         * before, 0px after.
         */
        className="rounded-t-xl border-b px-3 py-2.5 md:sticky md:top-0 md:z-10"
        style={{
          backgroundColor: healthTint(meta.color),
          borderBottomColor: healthEdge(meta.color),
        }}
      >
        {/*
         * Mark, of this board: "this view was supposed to mimick the pipeline".
         *
         * A pipeline column header says "Active Outreach / $313K · 14" — the
         * name, then what is sitting in it and how much it is worth. This one
         * said the name and a count in a coloured pill, which is a different
         * header that happens to be the same size. Same two lines now, and the
         * pill goes: the band is already tinted its health colour, so the colour
         * was never what the pill was carrying.
         *
         * The total is money, so it obeys the same rule the cards do and is
         * absent for anyone who may not see values.
         */}
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div
              className="truncate text-[13.5px] font-semibold"
              style={{ color: "var(--foreground)" }}
            >
              {meta.label}
            </div>
            <div className="mt-0.5 text-[11.5px] tabular-nums" style={{ color: MUTED }}>
              {money ? `${compactMoney(total)} · ` : ""}
              {rows.length}
            </div>
          </div>
          {/*
           * The chevron the pipeline header has and this one did not.
           *
           * Four fixed bands are not seven configurable stages, and the argument
           * for folding one is weaker — but this board carries a 380px Client
           * 360 panel the pipeline has no counterpart for, and with it docked
           * four columns do not fit a laptop. Folding Healthy, which is usually
           * the biggest and the least urgent, is what gives the three bands you
           * are actually working room to breathe.
           */}
          <button
            type="button"
            aria-expanded={true}
            aria-label={`Collapse ${meta.label}`}
            title={`Collapse ${meta.label}`}
            onClick={onToggleFold}
            className="mt-0.5 shrink-0 rounded text-[var(--muted-foreground)] hover:text-[var(--foreground)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)]"
          >
            <ChevronRight className="size-4" />
          </button>
        </div>
      </div>

      <div className="flex min-h-[120px] flex-1 flex-col gap-2.5 overflow-y-auto rounded-b-xl px-2.5 py-2.5">
        <SortableContext items={ids} strategy={rectSortingStrategy}>
          {rows.length === 0 && !showGap ? (
            <div className="py-8 text-center text-[12px]" style={{ color: MUTED }}>
              No clients in {meta.label}
              {!writesDisabled ? (
                <span className="mt-1 block text-[11.5px] opacity-80">
                  Drag a card here to set it
                </span>
              ) : null}
            </div>
          ) : (
            rows.map((r) => (
              <SortableClientCard
                key={r.accountId}
                row={r}
                money={money}
                density={density}
                disabled={writesDisabled || movingId === r.accountId}
                pending={movingId === r.accountId}
                active={selectedId === r.accountId}
                reduceMotion={reduceMotion}
                onQuickView={() => onQuickView(r)}
              />
            ))
          )}
        </SortableContext>

        {/* Insertion gap — where the card will land. */}
        {showGap ? (
          <div
            aria-hidden
            className="rounded-[10px] border border-dashed border-[var(--primary)]/50 bg-[var(--primary)]/5"
            style={{ height: 132 }}
          />
        ) : null}

        {/*
         * The pipeline's "+ Add Opportunity" footer, in the one band where it
         * can tell the truth.
         *
         * A health band is computed, not filed into, so there is no such thing
         * as adding a client to At Risk — which is why #171 left the footer out
         * altogether. But there is exactly one band a brand-new client lands
         * in: health is days since the last touch against a 90-day watch
         * threshold, so a client created today is Healthy, every time, whatever
         * their account type. So Healthy gets the footer and the other three do
         * not, and it goes where the page's own "+ Add Client" button goes.
         */}
        {onAddClient ? (
          <button
            type="button"
            onClick={onAddClient}
            className="flex items-center justify-center gap-1.5 rounded-[10px] py-2 text-[12.5px] font-medium text-[var(--primary)] hover:bg-[var(--hover)]"
          >
            <Plus className="size-3.5" /> Add Client
          </button>
        ) : null}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ board */

export function ActiveClientsKanban({
  rows,
  money,
  density = DEFAULT_CARD_DENSITY,
  loading,
  selectedId,
  onQuickView,
  /** Query key the board updates optimistically and re-fetches on settle. */
  queryKey = ["active-clients"] as const,
}: {
  rows: ActiveClientRow[];
  money: boolean;
  /** How much of each card to draw. See lib/card-density.ts. */
  density?: CardDensity;
  loading?: boolean;
  selectedId: string | null;
  /** Opens the Client 360 panel for a row; the card itself opens the record. */
  onQuickView: (row: ActiveClientRow) => void;
  queryKey?: readonly unknown[];
}) {
  const qc = useQueryClient();
  const app = useAppContext();
  const navigate = useNavigate();
  const writes = useWritesDisabled();
  const reduceMotion = usePrefersReducedMotion();
  const [draggingId, setDraggingId] = React.useState<string | null>(null);

  /*
   * Which bands are folded to a strip, kept per person in `user_view_prefs`
   * the way the pipeline keeps its folded stages — same hook, its own scope.
   *
   * #171 shipped this as session state, arguing a board that comes back
   * hiding At Risk is a bad surprise. Mark overruled it: "keep the client 360
   * panel, make everything else match." A fold you have to redo every morning
   * is not a preference, and the band is still on screen as a labelled strip
   * with its count on it — a folded band is narrowed, never hidden.
   *
   * Role preview never writes, exactly as the density control does not.
   */
  const { folded, toggle: toggleFold } = useFoldedStages(
    app.userId,
    !writes.disabled,
    ACTIVE_CLIENTS_FOLD_SCOPE,
  );

  // Stage ids for the four health bands — a drop has to write a real stage id.
  const stagesQ = useQuery({
    queryKey: ["farming-health-stages"],
    queryFn: () => fetchStages(FARMING_PIPELINE_ID),
    staleTime: 5 * 60_000,
  });

  const stageIdFor = React.useCallback(
    (health: ClientHealthKey): string | null => healthStageId(stagesQ.data, health),
    [stagesQ.data],
  );

  const move = useMutation({
    mutationFn: ({ row, to, stageId }: MoveVars) =>
      applyClientHealthStage({
        accountId: row.accountId,
        to,
        stageId,
        source: "Active Clients board",
      }),
    onMutate: async ({ row, to }: MoveVars) => {
      await qc.cancelQueries({ queryKey });
      const previous = qc.getQueryData<ActiveClientRow[]>(queryKey);
      qc.setQueryData<ActiveClientRow[]>(queryKey, (old) =>
        (old ?? []).map((r) => (r.accountId === row.accountId ? { ...r, health: to } : r)),
      );
      return { previous };
    },
    onError: (e: Error, _vars, ctx) => {
      // Roll the card back to the column it came from, and say why out loud.
      if (ctx?.previous) qc.setQueryData(queryKey, ctx.previous);
      toast.error(e.message || "Could not change this client's health stage");
    },
    onSuccess: (_d, vars) =>
      toast.success(`${vars.row.name} moved to ${HEALTH_META[vars.to].label}`),
    onSettled: () => void qc.invalidateQueries({ queryKey }),
  });

  // Pointer/touch sensors, never the HTML5 drag API. The distance threshold
  // keeps a tap on a card opening Client 360 instead of starting a drag.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  const byColumn = React.useMemo(() => {
    const m = new Map<ClientHealthKey, ActiveClientRow[]>(COLUMNS.map((k) => [k, []]));
    for (const r of rows) m.get(r.health)?.push(r);
    // Mark: "rank by overdue tasks, closest due date, then age". Alphabetical
    // by name is how the rows arrive, and it buried the client with a task a
    // fortnight past due somewhere in the middle of the Healthy column.
    for (const list of m.values()) {
      list.sort((a, b) => compareByUrgency(urgencyOf(a), urgencyOf(b)));
    }
    return m;
  }, [rows]);

  const labelIds = React.useMemo(() => rows.map((r) => r.accountId), [rows]);

  const dragging = draggingId ? (rows.find((r) => r.accountId === draggingId) ?? null) : null;
  const writesDisabled = writes.disabled || stagesQ.isLoading || move.isPending;

  const onDragStart = (e: DragStartEvent) => setDraggingId(String(e.active.id));

  const onDragEnd = (e: DragEndEvent) => {
    setDraggingId(null);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const row = rows.find((r) => r.accountId === String(e.active.id));
    if (!row) return;

    // The drop target is either a column or another card in one.
    const to = overId.startsWith(COLUMN_PREFIX)
      ? (overId.slice(COLUMN_PREFIX.length) as ClientHealthKey)
      : (rows.find((r) => r.accountId === overId)?.health ?? null);
    if (!to || !COLUMNS.includes(to) || to === row.health) return;

    // The metric band is the floor. Hand moves above it are overrides and are
    // recorded; hand moves below it would hide the very thing the board is
    // for, so they are refused out loud. Client 360 refuses identically.
    const refusal = healthMoveRefusal(row, to);
    if (refusal) {
      toast.info(refusal.title, { description: refusal.description });
      return;
    }

    const stageId = stageIdFor(to);
    if (!stageId) {
      toast.error(missingHealthStageMessage(to));
      return;
    }
    move.mutate({ row, to, stageId });
  };

  if (loading) {
    return (
      <div className="flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none md:overflow-x-visible">
        {COLUMNS.map((k) => (
          <div
            key={k}
            className="h-[320px] w-[85vw] max-w-[300px] shrink-0 snap-start animate-pulse rounded-xl border border-[var(--border)] bg-[var(--muted)]/40 md:w-[268px] md:max-w-[420px] md:grow md:basis-auto"
          />
        ))}
      </div>
    );
  }

  return (
    /* Account labels for every card on screen, fetched once for the board and
       read from context by the card — the pipeline board wraps itself in the
       same way. The board draws without waiting for it. */
    <ClientLabelsProvider ids={labelIds}>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setDraggingId(null)}
      >
        {/*
         * The strip must not own the scroll on desktop, or the sticky column
         * headers above have nowhere to stick: `overflow-x: auto` computes
         * `overflow-y: auto` on the same box, and that box never scrolls
         * vertically. Handing both axes to <main> is what makes the freeze work,
         * and what makes the page hold its heading at the left edge (see the
         * route). A phone keeps the strip and scrolls it sideways as before.
         */}
        <div
          className={cn(
            "flex snap-x snap-mandatory gap-3 overflow-x-auto pb-2 md:snap-none md:overflow-x-visible",
            draggingId && "cursor-grabbing",
          )}
        >
          {COLUMNS.map((k) => (
            <Column
              key={k}
              health={k}
              rows={byColumn.get(k) ?? []}
              money={money}
              density={density}
              writesDisabled={writesDisabled}
              movingId={move.isPending ? (move.variables?.row.accountId ?? null) : null}
              selectedId={selectedId}
              draggingId={draggingId}
              reduceMotion={reduceMotion}
              folded={folded.has(k)}
              onToggleFold={() => toggleFold(k)}
              /* Only Healthy — a new client cannot land anywhere else. */
              onAddClient={
                k === "healthy" && !writes.disabled
                  ? () => void navigate({ to: "/accounts/new" })
                  : null
              }
              onQuickView={onQuickView}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={reduceMotion ? null : undefined}>
          {dragging ? (
            <div className="w-[252px]">
              <ClientCard overlay density={density} row={dragging} money={money} />
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
    </ClientLabelsProvider>
  );
}
