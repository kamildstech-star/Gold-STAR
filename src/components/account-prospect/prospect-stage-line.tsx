/**
 * The thin stage line on the prospect layout.
 *
 * One hairline rail runs across the numbered path; every stage is a small
 * marker on it and only the current stage is bubbled up, with its name and
 * the days spent there. Nothing else competes for the eye.
 *
 * Mark: "the colors here in the pipeline aren't exciting." Every stage is now
 * drawn in its own tone (`stageTone`, by key — the same colour the board's
 * column and the Timeline's stage rows use): the road travelled is a gradient
 * through the stages it passed, the current stage is a solid pill in its
 * colour with a soft halo, and the road ahead is those colours faded
 * (`railTone`). Colour is never the only signal — every marker keeps its
 * name, and the current one says so with `aria-current`.
 *
 * Mark, with a screenshot of this rail: "add a drag feature to this" and
 * "when you move it on that progress line without the kanban view it needs
 * the pop up too." So the current-stage pill is draggable along the rail, and
 * a drop — like a click, which has always worked — asks
 * `stageMoveIntent` what that destination means. That is the same function
 * the kanban board asks, which is the point: the No Service Needed and
 * Active Clients popups belonged to the board route, and a second copy of the
 * branch that chooses between them would eventually disagree with the first
 * about whether a client was won or a company forgotten for a year.
 *
 * Nothing here writes to `accounts`. Each of the three popups performs its
 * own write — `markNoService` and `activateClient` move the stage themselves,
 * and the stage-path `MoveDialog` does the plain and lost moves with the
 * stashed-note triggers the record has always fired. Writing the stage here
 * first and then opening a popup would move the record twice.
 *
 * The close-out stages — No Service Needed, Ghosted — are drawn after the
 * forward steps, the way the full record's chevron path ends with them, but
 * set apart: a hairline gap, a dashed line, and markers faded in their own
 * tones (slate, rose) until hovered. They are drop targets like any other step.
 */
import { useMemo, useState, type ReactNode } from "react";
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
} from "@dnd-kit/core";
import { useQuery } from "@tanstack/react-query";

import { ActivateClientDialog, type ActivateTarget } from "@/components/activate-client-dialog";
import { NoServiceDialog, type NoServiceTarget } from "@/components/no-service-dialog";
import { GhostDialog, type GhostTarget } from "@/components/ghost-dialog";
import { MoveDialog as StageMoveDialog } from "@/components/stage-path";
import { useWritesDisabled } from "@/components/app-context";
import { fetchLabelMap } from "@/lib/labels";
import { fetchStages, type PipelineStage } from "@/lib/pipeline";
import { pointerFirst } from "@/lib/pipeline-drop-target";
import { stageMoveIntent } from "@/lib/stage-move-intent";
import { stageGradient, stageTone, type StageTone } from "@/lib/stage-tone";
import { cn } from "@/lib/utils";

import {
  CLOSE_OUT_TRACK,
  RAIL_TONE,
  closeOutTone,
  daysInStage,
  partitionStages,
  railFill,
  railSpan,
  railTone,
  stageState,
} from "@/components/account-prospect/prospect-view-helpers";

type Target = { id: string; name: string; isLost: boolean; key: string };

/** Nothing else on the page drags, so one fixed id is enough. */
const PILL_DRAG_ID = "prospect-stage-pill";

/*
  The forward steps as a chevron path — the same shape the full record's stage
  path draws, so both layouts read a deal's progress the same way. Done steps
  are green, the current one solid green with its days, the road ahead grey.
*/
const CHEVRON_FIRST =
  "rounded-l-lg pl-3 [clip-path:polygon(0_0,calc(100%_-_10px)_0,100%_50%,calc(100%_-_10px)_100%,0_100%)]";
const CHEVRON =
  "pl-5 [clip-path:polygon(0_0,calc(100%_-_10px)_0,100%_50%,calc(100%_-_10px)_100%,0_100%,10px_50%)]";

export function ProspectStageLine({
  accountId,
  accountName,
  accountType,
  whatTheyDo,
  pipelineId,
  currentStageId,
  changedAt,
  onMoved,
  className,
}: {
  accountId: string;
  /** Named in the popups: "No service needed — Brooklyn Facilities". */
  accountName: string;
  /** Falls back to deciding the onboarding questions when nobody labelled it. */
  accountType?: string | null;
  whatTheyDo?: string[] | null;
  pipelineId: string | null;
  currentStageId: string | null;
  changedAt: string | null;
  onMoved: () => void;
  className?: string;
}) {
  const writes = useWritesDisabled();
  const [target, setTarget] = useState<Target | null>(null);
  const [noService, setNoService] = useState<NoServiceTarget | null>(null);
  const [ghosting, setGhosting] = useState<GhostTarget | null>(null);
  const [winning, setWinning] = useState<ActivateTarget | null>(null);
  const [dragging, setDragging] = useState(false);

  // Same query key as StagePath so both read one cached stage list.
  const stagesQuery = useQuery({
    queryKey: ["stage-path", pipelineId],
    queryFn: () => fetchStages(pipelineId!),
    enabled: !!pipelineId,
  });

  /** The rail is the road to the win; lost stages are outcomes beside it. */
  const { steps, outcomes } = useMemo(
    () => partitionStages(stagesQuery.data ?? []),
    [stagesQuery.data],
  );
  const currentIndex = steps.findIndex((s) => s.id === currentStageId);
  const closedOut = outcomes.find((s) => s.id === currentStageId) ?? null;
  const outcomeSpan = railSpan(outcomes.length);

  /*
   * A category label put on the account by hand decides which onboarding
   * questions the activation popup asks; the account's type is only the
   * fallback. Fetched up front rather than when the popup opens, because by
   * then the answer is needed to draw the questions — and only when this
   * pipeline actually has a won stage to drag onto.
   */
  const hasWonStage = steps.some((s) => s.is_won);
  const labelsQuery = useQuery({
    queryKey: ["record-label-names", "account", accountId],
    queryFn: () => fetchLabelMap("account", [accountId]),
    enabled: hasWonStage,
    staleTime: 5 * 60_000,
  });

  const days = useMemo(() => daysInStage(changedAt), [changedAt]);
  const span = railSpan(steps.length);
  const fill = railFill(currentIndex, steps.length);
  /* The whole road in its colours (drawn faded), and the travelled part of it. */
  const trackGradient = stageGradient(steps.map((s) => s.key));
  const passedGradient = stageGradient(steps.slice(0, currentIndex + 1).map((s) => s.key));

  // Pointer/touch sensors, and the same thresholds as the board so a drag on
  // the rail and a drag on a card feel like the same gesture. The 6px keeps a
  // tap on the pill from becoming a drag; the 180ms hold is what makes this
  // usable on a phone, where the page itself scrolls under the finger.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 8 } }),
  );

  if (!pipelineId || steps.length === 0) return null;

  /**
   * A click on a marker and a drop on one do exactly the same thing: ask what
   * this destination means, then open whichever popup owns it.
   */
  const pick = (s: PipelineStage) => {
    if (writes.disabled) return;
    if (s.id === currentStageId) return;
    switch (stageMoveIntent({ kind: "stage", stage: s })) {
      case "no_service":
        setNoService({ id: accountId, name: accountName });
        return;
      case "ghost":
        setGhosting({ id: accountId, name: accountName });
        return;
      case "activate":
        setWinning({
          id: accountId,
          name: accountName,
          account_type: accountType ?? null,
          what_they_do: whatTheyDo ?? null,
          labels: (labelsQuery.data?.[accountId] ?? []).map((l) => l.name),
        });
        return;
      case "lost_reason":
      case "move":
        // The record's own move dialog: it asks for the written reason a lost
        // stage needs and fires the stashed-note triggers on the way through.
        setTarget({
          id: s.id,
          name: s.name,
          isLost: Boolean(s.is_lost),
          key: (s.key as string) ?? "",
        });
        return;
    }
  };

  const onDragEnd = (e: DragEndEvent) => {
    setDragging(false);
    const overId = e.over?.id ? String(e.over.id) : null;
    if (!overId) return;
    const stage = [...steps, ...outcomes].find((s) => s.id === overId);
    if (stage) pick(stage);
  };

  const dayLabel = days != null ? `${days} day${days === 1 ? "" : "s"}` : null;

  /**
   * The bubbled-up current stage — the forward pill, or the close-out one —
   * filled in its tone with that tone's own text colour. The halo is a static
   * box-shadow in the same tone (no animation, so nothing for reduced motion
   * to switch off); the background-coloured ring keeps it lifted off the rail.
   */
  const pillBody = (s: PipelineStage, tone: StageTone, extra?: string | false) => (
    <span
      aria-current="step"
      data-stage-tone={tone.name}
      className={cn(
        "flex h-[30px] max-w-full items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold ring-4 ring-background",
        "shadow-[0_0_0_7px_color-mix(in_oklab,var(--pill-glow)_20%,transparent),0_6px_16px_-6px_var(--pill-glow)]",
        tone.fill,
        extra,
      )}
      style={{ ["--pill-glow" as string]: tone.color }}
    >
      <span className="truncate">{s.name}</span>
      {dayLabel && (
        <span className="shrink-0 whitespace-nowrap text-[11.5px] font-medium opacity-85">
          · {dayLabel}
        </span>
      )}
    </span>
  );

  /**
   * The pill is the thing you drag. It is the only draggable on the rail —
   * the markers are where it can go, not things that move themselves.
   */
  const currentPill = (s: PipelineStage, tone: StageTone) => (
    <DraggablePill
      disabled={writes.disabled}
      title={
        writes.disabled
          ? (writes.reason ?? "Read only")
          : dayLabel
            ? `Current stage — ${dayLabel} · drag to move`
            : "Current stage — drag to move"
      }
    >
      {pillBody(s, tone, !writes.disabled && "cursor-grab active:cursor-grabbing")}
    </DraggablePill>
  );

  /**
   * A marker with its name under it. The whole column is the drop target, not
   * the 10px dot: a horizontal rail is a small enough thing to aim at already,
   * and `pointerFirst` collision only asks which target the pointer is inside.
   */
  const marker = (s: PipelineStage, tone: { dot: string; label: string }) => (
    <StageDropTarget stage={s} disabled={writes.disabled} dragging={dragging}>
      <button
        type="button"
        disabled={writes.disabled}
        onClick={() => pick(s)}
        title={writes.disabled ? (writes.reason ?? "Read only") : `Move to ${s.name}`}
        className="group flex w-full min-w-0 flex-col items-center gap-1 disabled:cursor-not-allowed"
      >
        <span className="flex h-[30px] items-center">
          <span
            className={cn(
              "block size-2.5 rounded-full ring-4 ring-background transition",
              tone.dot,
            )}
          />
        </span>
        <span
          className={cn(
            "max-w-full truncate px-1 text-[11.5px] leading-tight transition",
            tone.label,
          )}
        >
          {s.name}
        </span>
      </button>
    </StageDropTarget>
  );

  /** The current step as a solid chevron: its name and the days spent there. */
  const chevronBody = (s: PipelineStage, shape: string, extra?: string | false) => (
    <span
      aria-current="step"
      data-stage-tone={stageTone(s.key).name}
      className={cn(
        "flex min-h-11 w-full min-w-0 flex-col justify-center bg-success py-1.5 pr-3 text-[12.5px] font-bold leading-tight text-success-foreground",
        shape,
        extra,
      )}
    >
      <span className="truncate">{s.name}</span>
      {dayLabel && (
        <span className="truncate text-[11px] font-medium opacity-90">Current · {dayLabel}</span>
      )}
    </span>
  );

  const currentStage = steps.find((s) => s.id === currentStageId) ?? closedOut ?? null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerFirst}
      onDragStart={() => setDragging(true)}
      onDragEnd={onDragEnd}
      onDragCancel={() => setDragging(false)}
    >
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 px-4 pb-3 pt-1 sm:px-6",
          className,
        )}
      >
        <ol
          className="flex min-w-0 flex-[999_1_36rem] gap-[3px] overflow-x-auto pb-0.5"
          aria-label="Pipeline stage"
          data-stage-rail
        >
          {steps.map((s, i) => {
            const state = stageState(i, currentIndex);
            const shape = i === 0 ? CHEVRON_FIRST : CHEVRON;
            return (
              <li key={s.id} className="flex min-w-[7.5rem] flex-1">
                {state === "current" ? (
                  <DraggablePill
                    fill
                    disabled={writes.disabled}
                    title={
                      writes.disabled
                        ? (writes.reason ?? "Read only")
                        : dayLabel
                          ? `Current stage — ${dayLabel} · drag to move`
                          : "Current stage — drag to move"
                    }
                  >
                    {chevronBody(
                      s,
                      shape,
                      !writes.disabled && "cursor-grab active:cursor-grabbing",
                    )}
                  </DraggablePill>
                ) : (
                  <StageDropTarget stage={s} disabled={writes.disabled} dragging={dragging}>
                    <button
                      type="button"
                      disabled={writes.disabled}
                      onClick={() => pick(s)}
                      title={writes.disabled ? (writes.reason ?? "Read only") : `Move to ${s.name}`}
                      className={cn(
                        "flex min-h-11 w-full min-w-0 items-center py-1.5 pr-3 text-left text-[12.5px] font-medium transition disabled:cursor-not-allowed",
                        shape,
                        state === "done"
                          ? "bg-success/85 text-success-foreground hover:bg-success"
                          : "bg-muted text-muted-foreground hover:bg-hover hover:text-foreground",
                      )}
                    >
                      <span className="truncate">{s.name}</span>
                    </button>
                  </StageDropTarget>
                )}
              </li>
            );
          })}
        </ol>

        {/*
          The close-outs: set apart from the road to the win, as quiet dashed
          buttons, so they are stages a rep can move to but never read as the
          next step. The current one, if the deal is closed out, is solid.
        */}
        {outcomes.length > 0 && (
          <div className="flex shrink-0 items-center gap-2" aria-label="Close-out stages">
            <span className="mr-1 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.06em] text-muted-foreground">
              Close out
            </span>
            {outcomes.map((s) =>
              closedOut?.id === s.id ? (
                <span key={s.id} className="flex">
                  {currentPill(s, stageTone(s.key))}
                </span>
              ) : (
                <StageDropTarget
                  key={s.id}
                  stage={s}
                  disabled={writes.disabled}
                  dragging={dragging}
                  fit
                >
                  <button
                    type="button"
                    disabled={writes.disabled}
                    onClick={() => pick(s)}
                    title={writes.disabled ? (writes.reason ?? "Read only") : `Move to ${s.name}`}
                    className="min-h-9 whitespace-nowrap rounded-lg border border-dashed border-input px-3 text-[12.5px] font-medium text-muted-foreground transition hover:bg-hover hover:text-foreground disabled:cursor-not-allowed"
                  >
                    {s.name}
                  </button>
                </StageDropTarget>
              ),
            )}
          </div>
        )}
      </div>

      {/*
        The pill travels under the finger; the rail keeps its own shape. Outside
        the rail's flex row on purpose, the way the board keeps its overlay
        outside the column strip — the overlay is positioned by dnd-kit and has
        no business being measured as a child of the row.
      */}
      <DragOverlay dropAnimation={null}>
        {dragging && currentStage
          ? pillBody(currentStage, stageTone(currentStage.key), "cursor-grabbing")
          : null}
      </DragOverlay>

      {/*
        The three popups a move can land in. Which one is not decided here —
        `stageMoveIntent` decides, and the kanban board asks it the same way.
      */}
      <StageMoveDialog
        accountId={accountId}
        kind="prospecting"
        target={target}
        onClose={() => setTarget(null)}
        onMoved={onMoved}
      />
      <NoServiceDialog
        target={noService}
        onOpenChange={(v) => !v && setNoService(null)}
        onDone={onMoved}
      />
      <GhostDialog
        target={ghosting}
        onOpenChange={(v) => !v && setGhosting(null)}
        onDone={onMoved}
      />
      <ActivateClientDialog
        target={winning}
        onOpenChange={(v) => !v && setWinning(null)}
        onDone={onMoved}
      />
    </DndContext>
  );
}

/** The current-stage pill, made draggable. At rest it looks unchanged. */
function DraggablePill({
  disabled,
  title,
  children,
  fill = false,
}: {
  disabled: boolean;
  title: string;
  children: ReactNode;
  /** Take the whole slot — the rail's chevron, not a free-standing pill. */
  fill?: boolean;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: PILL_DRAG_ID,
    disabled,
  });
  return (
    <span
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      title={title}
      // While it is in the overlay the original stays in place but hollow, so
      // the rail does not reflow and the columns stay where they were aimed at.
      className={cn("flex max-w-full touch-none", fill && "w-full", isDragging && "opacity-30")}
    >
      {children}
    </span>
  );
}

/**
 * One stage's column as a drop target. It highlights while the pointer is
 * inside it, the way the board's columns do — on a rail this thin, the
 * highlight is the only thing telling a rep which stage they are about to
 * pick.
 */
function StageDropTarget({
  stage,
  disabled,
  dragging,
  fit = false,
  children,
}: {
  stage: PipelineStage;
  disabled: boolean;
  dragging: boolean;
  /**
   * Size to the button, never narrower (the close-outs). As a squeezable,
   * centred box the button spilled out of it and over the "Close out" label
   * (4 Nov: 134px button in a 104px box).
   */
  fit?: boolean;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled });
  return (
    <div
      ref={setNodeRef}
      data-over={isOver || undefined}
      // The Timeline's stage-change rows scroll to the stage they landed on.
      data-stage-id={stage.id}
      className={cn(
        "flex justify-center rounded-lg py-0.5 transition",
        fit ? "shrink-0" : "w-full min-w-0",
        dragging && !isOver && "bg-primary/5",
        isOver && "bg-primary/15 ring-2 ring-primary",
      )}
    >
      {children}
    </div>
  );
}
