/**
 * The life of a supply order, and who may move it along.
 *
 * David, 16 Sep, described the chain he wants: somebody asks for supplies, a
 * manager approves it, the requester sees it approved, it sits as pending
 * delivery, and when the boxes turn up they are marked delivered and the stock
 * enters inventory.
 *
 * Every state in that sentence already existed in `supply_request_status` —
 * requested, approved, ordered, delivered, denied. What did not exist was
 * anywhere saying which move is legal from which state, or which of the two
 * people in the room may make it, so the rules lived scattered across the
 * screen as disabled buttons. Here they are, once, in a form that can be
 * tested without a database.
 *
 * "Pending delivery" is `ordered`. The database enum is not changed for a
 * wording preference: the label is what the user reads.
 */

import type { SupplyStatus } from "@/lib/supplies";

/** Who is looking at the order. */
export type SupplyActor = {
  userId: string;
  /** Can approve, deny, order and receive at this order's location. */
  isManager: boolean;
};

export type SupplyOrder = {
  id: string;
  requester_id: string;
  status: SupplyStatus;
};

/** What the user reads, which is not always what the column says. */
export const SUPPLY_STAGE_LABEL: Record<SupplyStatus, string> = {
  requested: "Awaiting approval",
  approved: "Approved",
  ordered: "Pending delivery",
  delivered: "Delivered",
  denied: "Denied",
};

/** One line telling whoever is looking what happens next. */
export const SUPPLY_STAGE_HINT: Record<SupplyStatus, string> = {
  requested: "A manager at this location has to approve it before anything is ordered.",
  approved: "Approved. It can be placed with a supplier and marked as on order.",
  ordered: "On order. Mark it delivered when the items arrive and they go into stock.",
  delivered: "Delivered. The items are in this location's inventory.",
  denied: "Denied. Nothing was ordered.",
};

/**
 * The order the stages are shown in, so a progress trail reads left to right.
 * `denied` is not on it — it is where an order stops, not a step through.
 */
export const SUPPLY_STAGE_FLOW: SupplyStatus[] = ["requested", "approved", "ordered", "delivered"];

export type SupplyTransition = {
  to: SupplyStatus;
  /** What the button says. */
  label: string;
  /** Only a manager may do it. */
  managerOnly: boolean;
  /** True when the move puts stock on the shelf. */
  stocksInventory?: boolean;
};

/**
 * Where an order can go from where it is.
 *
 * Deliberately a forward-only chain. Un-approving an order that has already
 * been placed with a supplier is not a state change, it is a conversation, and
 * a button that silently rewinds the history of a purchase is how an audit
 * trail stops being one.
 */
const TRANSITIONS: Record<SupplyStatus, SupplyTransition[]> = {
  requested: [
    { to: "approved", label: "Approve", managerOnly: true },
    { to: "denied", label: "Deny", managerOnly: true },
  ],
  approved: [{ to: "ordered", label: "Mark as ordered", managerOnly: true }],
  ordered: [{ to: "delivered", label: "Mark delivered", managerOnly: true, stocksInventory: true }],
  delivered: [],
  denied: [],
};

/** Every move that exists from this state, before anyone is considered. */
export function transitionsFrom(status: SupplyStatus): SupplyTransition[] {
  return TRANSITIONS[status] ?? [];
}

/** The moves this particular person may make on this particular order. */
export function availableTransitions(order: SupplyOrder, actor: SupplyActor): SupplyTransition[] {
  return transitionsFrom(order.status).filter((t) => !t.managerOnly || actor.isManager);
}

export type TransitionCheck = { allowed: boolean; reason: string | null };

/**
 * May this person move this order to this state, and if not, why not.
 *
 * The reason matters: a requester staring at a greyed-out Approve button needs
 * to be told it is the manager's to press, not left guessing whether the app
 * is broken.
 */
export function canTransition(
  order: SupplyOrder,
  actor: SupplyActor,
  to: SupplyStatus,
): TransitionCheck {
  const move = transitionsFrom(order.status).find((t) => t.to === to);
  if (!move) {
    return {
      allowed: false,
      reason: `An order that is ${SUPPLY_STAGE_LABEL[order.status].toLowerCase()} cannot go to ${SUPPLY_STAGE_LABEL[to].toLowerCase()}.`,
    };
  }
  if (move.managerOnly && !actor.isManager) {
    return {
      allowed: false,
      // Approving your own request is the one thing this whole step exists to
      // prevent, so it is named rather than left to a generic refusal.
      reason:
        order.requester_id === actor.userId
          ? "You raised this request, so a manager at this location has to approve it."
          : "Only a manager at this location can do this.",
    };
  }
  return { allowed: true, reason: null };
}

/** Does moving to this state put the items on the shelf? */
export function stocksInventory(from: SupplyStatus, to: SupplyStatus): boolean {
  return !!transitionsFrom(from).find((t) => t.to === to)?.stocksInventory;
}

/** May the requester still withdraw it? Only while nobody has acted. */
export function canCancel(order: SupplyOrder, actor: SupplyActor): boolean {
  if (order.status !== "requested") return false;
  return order.requester_id === actor.userId || actor.isManager;
}

/** How far along the trail this order is, for a progress line. */
export function stageIndex(status: SupplyStatus): number {
  return SUPPLY_STAGE_FLOW.indexOf(status);
}

/* ------------------------------------------------------------------ */
/* Vendor email                                                        */
/* ------------------------------------------------------------------ */

/**
 * Whether approving an order also composes the supplier's purchase order.
 *
 * It shipped OFF: David left it open, and an approval that quietly sends a
 * purchase order to a third party is not something to switch on by guessing.
 * The decision came back on 18 Sep — switch it on — so it is on.
 *
 * "Composes" is the exact word. Nothing is SENT by the app: outbound delivery
 * is still blocked on Chaim approving the email backend, and the approver opens
 * the composed draft in their own mail client. The whole of that lives in
 * `src/lib/vendor-order-email.ts`, and the single function that changes the day
 * a real sender exists is `deliverVendorOrder` in it.
 *
 * The stubs that used to sit here — sendVendorOrderEmail and
 * maybeEmailVendorOnApproval — are gone rather than left beside the real thing:
 * two functions with the same name and different behaviour is how the wrong one
 * gets called.
 */
export const VENDOR_EMAIL_ON_APPROVAL = true;
