import { describe, expect, it } from "vitest";

import {
  availableTransitions,
  canCancel,
  canTransition,
  stageIndex,
  stocksInventory,
  transitionsFrom,
  SUPPLY_STAGE_FLOW,
  SUPPLY_STAGE_LABEL,
  VENDOR_EMAIL_ON_APPROVAL,
  type SupplyOrder,
} from "@/lib/supply-workflow";

/**
 * The life of a supply order, and who may move it along.
 *
 * David, 16 Sep: somebody asks for supplies, a manager approves it, the
 * requester sees it approved, it sits as pending delivery, and when the boxes
 * turn up they are marked delivered and the stock enters inventory.
 *
 * The permission half is the part worth testing hardest. "A requester cannot
 * approve their own request" is the one rule the approval step exists for, and
 * it is the kind of rule that gets lost the next time somebody rearranges the
 * buttons on the screen.
 */

const REQUESTER = "user-requester";
const MANAGER = "user-manager";

const order = (status: SupplyOrder["status"], requester = REQUESTER): SupplyOrder => ({
  id: "req-1",
  requester_id: requester,
  status,
});

const asRequester = { userId: REQUESTER, isManager: false };
const asColleague = { userId: "user-other", isManager: false };
const asManager = { userId: MANAGER, isManager: true };

describe("stage labels", () => {
  it("calls the `ordered` state Pending delivery, which is what David asked to read", () => {
    // The database enum is not renamed for a wording preference: the label is
    // the thing the user sees.
    expect(SUPPLY_STAGE_LABEL.ordered).toBe("Pending delivery");
  });

  it("walks requested → approved → pending delivery → delivered, with denied off the trail", () => {
    expect(SUPPLY_STAGE_FLOW).toEqual(["requested", "approved", "ordered", "delivered"]);
    expect(stageIndex("requested")).toBe(0);
    expect(stageIndex("delivered")).toBe(3);
    // Denied is where an order stops, not a step through it.
    expect(stageIndex("denied")).toBe(-1);
  });
});

describe("transitions — the chain itself", () => {
  it("offers approve and deny from requested, and nothing else", () => {
    expect(transitionsFrom("requested").map((t) => t.to)).toEqual(["approved", "denied"]);
  });

  it("offers only the next step from approved and from pending delivery", () => {
    expect(transitionsFrom("approved").map((t) => t.to)).toEqual(["ordered"]);
    expect(transitionsFrom("ordered").map((t) => t.to)).toEqual(["delivered"]);
  });

  it("is a dead end once delivered or denied", () => {
    expect(transitionsFrom("delivered")).toEqual([]);
    expect(transitionsFrom("denied")).toEqual([]);
  });

  it("refuses to skip the middle of the chain", () => {
    const check = canTransition(order("requested"), asManager, "delivered");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("cannot go to");
  });

  it("refuses to rewind an order that has already been placed", () => {
    // Un-approving a purchase already with a supplier is a conversation, not a
    // state change, and a button that silently rewinds it destroys the trail.
    expect(canTransition(order("ordered"), asManager, "approved").allowed).toBe(false);
    expect(canTransition(order("delivered"), asManager, "ordered").allowed).toBe(false);
  });
});

describe("transitions — who may make them", () => {
  it("lets a manager approve", () => {
    expect(canTransition(order("requested"), asManager, "approved")).toEqual({
      allowed: true,
      reason: null,
    });
  });

  it("stops a requester approving their own request, and says why in those words", () => {
    const check = canTransition(order("requested"), asRequester, "approved");
    expect(check.allowed).toBe(false);
    expect(check.reason).toContain("You raised this request");
  });

  it("stops any non-manager approving somebody else's, with the general reason", () => {
    const check = canTransition(order("requested"), asColleague, "approved");
    expect(check.allowed).toBe(false);
    expect(check.reason).toBe("Only a manager at this location can do this.");
  });

  it("offers a non-manager no buttons at all on an open request", () => {
    // A greyed-out row of manager actions on a crew member's screen is noise.
    expect(availableTransitions(order("requested"), asRequester)).toEqual([]);
    expect(availableTransitions(order("approved"), asRequester)).toEqual([]);
    expect(availableTransitions(order("ordered"), asRequester)).toEqual([]);
  });

  it("offers a manager exactly the legal next steps", () => {
    expect(availableTransitions(order("requested"), asManager).map((t) => t.label)).toEqual([
      "Approve",
      "Deny",
    ]);
    expect(availableTransitions(order("ordered"), asManager).map((t) => t.label)).toEqual([
      "Mark delivered",
    ]);
  });
});

describe("delivery into inventory", () => {
  it("is the one move that stocks the shelf", () => {
    expect(stocksInventory("ordered", "delivered")).toBe(true);
  });

  it("is not triggered by approving or ordering", () => {
    expect(stocksInventory("requested", "approved")).toBe(false);
    expect(stocksInventory("approved", "ordered")).toBe(false);
    expect(stocksInventory("requested", "denied")).toBe(false);
  });
});

describe("withdrawing a request", () => {
  it("lets the requester pull it back while nobody has acted", () => {
    expect(canCancel(order("requested"), asRequester)).toBe(true);
  });

  it("stops once a manager has approved it", () => {
    expect(canCancel(order("approved"), asRequester)).toBe(false);
    expect(canCancel(order("ordered"), asRequester)).toBe(false);
  });

  it("is not something a colleague can do to somebody else's request", () => {
    expect(canCancel(order("requested"), asColleague)).toBe(false);
  });

  it("lets a manager clear an open request from the queue", () => {
    expect(canCancel(order("requested"), asManager)).toBe(true);
  });
});

describe("vendor email on approval", () => {
  it("is on — the decision came back and reversed the default", () => {
    /*
     * It shipped false: David left it open and an approval that quietly sends a
     * purchase order to a third party is not something to switch on by
     * guessing. The decision came back on 18 Sep, so it is on.
     *
     * "Composes", not "sends". Delivery is still blocked on Chaim's email
     * backend; the approver opens the composed draft in their own client. The
     * one function that changes when a real sender exists is
     * deliverVendorOrder in src/lib/vendor-order-email.ts, and its own tests
     * cover the composing.
     */
    expect(VENDOR_EMAIL_ON_APPROVAL).toBe(true);
  });
});
