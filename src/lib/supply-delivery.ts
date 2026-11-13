/**
 * What was ordered, what turned up, and what is still coming.
 *
 * David, 17 Sep, walking the supplies queue: "we should have a place where we
 * can put in exactly what was delivered — meaning if I ordered five rolls and
 * they only delivered four rolls, it's still gonna show as one is pending...
 * and then potentially they should let me know somehow that there's still
 * something pending."
 *
 * A delivery used to be all-or-nothing: one press stocked every line at the
 * quantity ORDERED and closed the request. An order four rolls short went into
 * inventory as five and read as complete — the shelf count and the paperwork
 * were both wrong, and nobody was told.
 *
 * Pure. What a manager types on a Tuesday afternoon decides what the shelf says
 * for the next month, so the arithmetic is testable without a database.
 */

import type { SupplyRequestFull } from "@/lib/supplies";

/** One line of an order, as the delivery screen sees it. */
export type DeliveryLine = {
  lineId: string;
  itemId: string | null;
  label: string;
  unit: string | null;
  ordered: number;
  delivered: number;
  /** Still to come. Never negative — an over-delivery is not a debt. */
  outstanding: number;
};

const num = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};

/**
 * How much of this line has arrived.
 *
 * Read through a narrow cast: `delivered_quantity` lands with 20260918170000
 * and the generated types lag a migration applied by hand. No column reads as
 * nothing delivered, which is the honest answer on a database that has not
 * had it — the order simply shows everything outstanding rather than crashing.
 */
export function lineDelivered(line: object): number {
  return num((line as { delivered_quantity?: number | null }).delivered_quantity);
}

export function deliveryLines(request: SupplyRequestFull): DeliveryLine[] {
  return (request.supply_request_lines ?? []).map((l) => {
    const ordered = num(l.quantity);
    const delivered = lineDelivered(l);
    return {
      lineId: l.id,
      itemId: l.item_id,
      label: l.supply_items?.name ?? l.other_label ?? "Item",
      unit: l.unit ?? l.supply_items?.unit ?? null,
      ordered,
      delivered,
      outstanding: Math.max(0, ordered - delivered),
    };
  });
}

export type DeliveryProgress = {
  /** Every line has arrived in full. Only then is the order really delivered. */
  complete: boolean;
  /** Nothing has arrived at all. */
  untouched: boolean;
  outstandingLines: number;
  outstandingUnits: number;
  /** "1 roll of Duct Tape still to come" — what the requester is told. */
  summary: string;
};

/**
 * Where the order stands.
 *
 * `complete` is the gate on the status change. An order that is four of five
 * delivered stays PENDING DELIVERY — David's "it's still gonna show as one is
 * pending" — because calling it delivered is the falsehood he objected to.
 */
export function deliveryProgress(lines: readonly DeliveryLine[]): DeliveryProgress {
  const short = lines.filter((l) => l.outstanding > 0);
  const outstandingUnits = short.reduce((sum, l) => sum + l.outstanding, 0);
  const complete = lines.length > 0 && short.length === 0;
  const untouched = lines.every((l) => l.delivered === 0);

  const phrase = (l: DeliveryLine) =>
    `${trim(l.outstanding)}${l.unit ? ` ${l.unit}` : ""} of ${l.label}`;
  const summary =
    short.length === 0
      ? "Everything on this order has arrived."
      : short.length <= 2
        ? `${short.map(phrase).join(" and ")} still to come.`
        : `${short.length} items still to come, ${trim(outstandingUnits)} units in total.`;

  return { complete, untouched, outstandingLines: short.length, outstandingUnits, summary };
}

/** 2 rather than 2.00, 2.5 rather than 2.50 — a count people read aloud. */
function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

/**
 * What to add to the shelf for one line, given what the office just typed.
 *
 * THE DELTA, not the total. This is what replaces the unique index the
 * migration drops: stocking the difference means re-submitting the same
 * numbers moves nothing, and a correction downward takes stock back off rather
 * than being refused. A blank box is not a zero — it is "unchanged" — so an
 * absent entry yields no movement at all.
 */
export function deliveryDelta(line: DeliveryLine, typed: number | null | undefined): number {
  if (typed == null) return 0;
  const next = Math.max(0, num(typed));
  return next - line.delivered;
}

/** The whole submission: what each line becomes, and what moves. */
export type DeliveryEntry = { line: DeliveryLine; delivered: number; delta: number };

export function planDelivery(
  lines: readonly DeliveryLine[],
  typed: Record<string, number | null | undefined>,
): DeliveryEntry[] {
  return lines.map((line) => {
    const raw = typed[line.lineId];
    const delivered = raw == null ? line.delivered : Math.max(0, num(raw));
    return { line, delivered, delta: delivered - line.delivered };
  });
}

/**
 * What the requester is told when part of their order lands.
 *
 * Only when something is genuinely outstanding: a completed delivery is
 * already announced by the status change, and two notifications for one event
 * is how people learn to ignore them.
 */
export function pendingNotice(progress: DeliveryProgress): string | null {
  return progress.complete ? null : progress.summary;
}
