import * as React from "react";
import {
  DndContext,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";

import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { stageBadgeStyle, type JobStage } from "@/lib/job-stages";
import { fmtMoney, type JobLossType } from "@/lib/jobs";
import { useLossTypes, usePaymentTypes } from "@/lib/loss-categories";

export type JobCard = {
  id: string;
  job_number: string;
  job_name: string | null;
  customer_name: string | null;
  address: string;
  locality: string | null;
  region: string | null;
  loss_type: JobLossType | null;
  loss_type_id: string | null;
  job_type: string | null;
  stage_id: string | null;
  estimated_amount: number | null;
};

type Props = {
  stages: JobStage[];
  cards: JobCard[];
  onOpen: (id: string) => void;
  onMove: (card: JobCard, stage: JobStage) => void;
  movingId: string | null;
  writesDisabled: boolean;
  showMoney: boolean;
};

function Card({
  card,
  onOpen,
  showMoney,
  disabled,
  moving,
}: {
  card: JobCard;
  onOpen: (id: string) => void;
  showMoney: boolean;
  disabled: boolean;
  moving: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: card.id,
    disabled,
  });
  const lossTypes = useLossTypes();
  const paymentTypes = usePaymentTypes();
  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen(card.id);
      }}
      style={
        transform ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` } : undefined
      }
      className={cn(
        "cursor-pointer rounded-xl border bg-card p-3 text-left shadow-[0_1px_2px_color-mix(in_oklab,var(--foreground)_5%,transparent)] transition-all hover:-translate-y-px hover:border-primary/40 hover:shadow-md",
        (isDragging || moving) && "opacity-50",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">{card.job_number}</span>
        <span className={cn("pill", lossTypes.badge(card.loss_type_id))}>
          {lossTypes.label(card.loss_type_id)}
        </span>
      </div>
      <p className="mt-1 truncate text-[13px] font-semibold">
        {card.job_name ?? card.customer_name ?? "Untitled job"}
      </p>
      <p className="truncate text-xs text-muted-foreground">
        {[card.address, card.locality, card.region].filter(Boolean).join(", ") || "No address"}
      </p>
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {/* Cash and insurance work is managed differently — visible without opening the record. */}
        <span className={cn("pill", paymentTypes.tone(card.job_type))}>
          {paymentTypes.label(card.job_type)}
        </span>
        {showMoney && card.estimated_amount != null && (
          <span className="text-xs font-medium tabular-nums">
            {fmtMoney(card.estimated_amount)}
          </span>
        )}
      </div>
    </div>
  );
}

function Column({ stage, props }: { stage: JobStage; props: Props }) {
  const { setNodeRef, isOver } = useDroppable({ id: stage.id, disabled: props.writesDisabled });
  const cards = props.cards.filter((c) => c.stage_id === stage.id);
  return (
    /*
     * On a phone a column takes most of the viewport and snaps, so one stage is
     * ever fully in view; the column is height-capped there so its cards scroll
     * under a header that stays put. Desktop keeps the original fixed 272px
     * column that grows with its content.
     */
    <div className="flex max-h-[70svh] w-[85vw] max-w-[300px] shrink-0 snap-start flex-col md:max-h-none md:w-[272px] md:max-w-none">
      <div
        className="flex shrink-0 items-center justify-between gap-2 rounded-t-xl border border-b-0 bg-card px-3 py-2"
        style={{ borderTop: `3px solid ${stage.color || "var(--primary)"}` }}
      >
        <span className="flex items-center gap-1.5 text-[12px] font-semibold">{stage.name}</span>
        <span className="rounded-full bg-muted px-1.5 text-[11px] font-semibold tabular-nums text-muted-foreground">
          {cards.length}
        </span>
      </div>
      <div
        ref={setNodeRef}
        className={cn(
          "flex min-h-[160px] flex-1 flex-col gap-2 overflow-y-auto rounded-b-xl border border-t-0 bg-muted/40 p-2 md:overflow-y-visible",
          isOver && "bg-accent/60",
        )}
      >
        {cards.map((c) => (
          <Card
            key={c.id}
            card={c}
            onOpen={props.onOpen}
            showMoney={props.showMoney}
            disabled={props.writesDisabled}
            moving={props.movingId === c.id}
          />
        ))}
        {cards.length === 0 && (
          <p className="px-1 py-2 text-[11px] text-muted-foreground">No jobs</p>
        )}
      </div>
    </div>
  );
}

/** Jobs on the same board machinery as the sales pipeline — stages are admin-editable. */
export function JobBoard(props: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 180, tolerance: 6 } }),
  );

  const onDragEnd = (e: DragEndEvent) => {
    const stage = props.stages.find((s) => s.id === e.over?.id);
    const card = props.cards.find((c) => c.id === e.active.id);
    if (!stage || !card || card.stage_id === stage.id) return;
    props.onMove(card, stage);
  };

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      {/* The sideways scroll belongs here, never to the page body. */}
      <div className="flex snap-x snap-mandatory gap-2 overflow-x-auto p-3 md:snap-none">
        {props.stages.map((s) => (
          <Column key={s.id} stage={s} props={props} />
        ))}
      </div>
    </DndContext>
  );
}

/** Small badge used in tables and detail headers. */
export function StageBadge({ stage }: { stage: JobStage | undefined | null }) {
  if (!stage) return <span className="text-muted-foreground">—</span>;
  return (
    <Badge variant="outline" style={stageBadgeStyle(stage.color)} className="font-medium">
      {stage.name}
    </Badge>
  );
}
