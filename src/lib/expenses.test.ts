import { describe, expect, it } from "vitest";

import {
  localDateStr,
  monthStartLocal,
  requestOutcomeMessage,
  summarise,
  type Expense,
} from "./expenses";

describe("requestOutcomeMessage", () => {
  // tg_expense_request_route sets 'auto_approved' under the threshold, never
  // 'approved'. The old check on "approved" told every under-limit rep their
  // request had gone to the Sales Head while the badge said Auto-approved.
  it("tells the rep an auto-approved request went through", () => {
    expect(requestOutcomeMessage("auto_approved", 50)).toMatch(/approved automatically/);
    expect(requestOutcomeMessage("auto_approved", 50)).toContain("$50.00");
  });

  it("treats a manager-approved row the same way", () => {
    expect(requestOutcomeMessage("approved", 50)).toMatch(/approved automatically/);
  });

  it("says a pending request is with the Sales Head", () => {
    expect(requestOutcomeMessage("pending", 50)).toMatch(/Sales Head/);
  });
});

describe("local calendar dates", () => {
  it("uses the browser's own date, not UTC", () => {
    // 23:30 local on the 1st. In any zone west of UTC toISOString() would have
    // said the 2nd; east of UTC an early-morning stamp would have said the 31st.
    const late = new Date(2026, 8, 1, 23, 30);
    expect(localDateStr(late)).toBe("2026-09-01");
    const early = new Date(2026, 8, 1, 0, 30);
    expect(localDateStr(early)).toBe("2026-09-01");
  });

  it("starts the month on the local 1st", () => {
    expect(monthStartLocal(new Date(2026, 8, 30, 23, 59))).toBe("2026-09-01");
    expect(monthStartLocal(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});

describe("summarise", () => {
  const row = (over: Partial<Expense>): Expense =>
    ({
      amount: 10,
      kind: "company_card",
      reimbursed: false,
      ...over,
    }) as Expense;

  it("only counts unreimbursed reimbursements as owed", () => {
    const s = summarise([
      row({ amount: 10, kind: "reimbursement" }),
      row({ amount: 5, kind: "reimbursement", reimbursed: true }),
      row({ amount: 20, kind: "gas_card" }),
    ]);
    expect(s.total).toBe(35);
    expect(s.unreimbursed).toBe(10);
    expect(s.byKind.get("reimbursement")).toBe(15);
  });
});
