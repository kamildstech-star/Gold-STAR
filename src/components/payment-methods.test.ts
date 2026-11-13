import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PAYMENT_METHODS } from "@/lib/add-payment";

/**
 * Mark, 2026-09-09: "add zelle".
 *
 * The method column is free text, so this list is only what the office is
 * offered without typing. Zelle was missing, which meant recording one as
 * "Other..." and typing the word every time -- and free text typed repeatedly
 * is how a column ends up holding "Zelle", "zelle" and "ZELLE".
 */
/*
 * The list moved to lib/add-payment.ts with the Add payment dialog
 * (2026-10-07); the panel and the correction dialog both take it from there.
 */
const methods = (): string[] => [...PAYMENT_METHODS];
const PANEL = readFileSync("src/components/job-billing-panel.tsx", "utf8");

describe("the payment methods offered when recording a payment", () => {
  it("offers Zelle", () => {
    expect(methods()).toContain("Zelle");
  });

  it("keeps every method that was already there", () => {
    // Adding one must not quietly drop another.
    for (const m of ["Check", "ACH / wire", "Credit card", "Cash", "Carrier direct deposit"]) {
      expect(methods(), m).toContain(m);
    }
  });

  it("puts Zelle with the other bank transfer", () => {
    // Same question being answered: money moved bank to bank.
    const list = methods();
    expect(list.indexOf("Zelle")).toBe(list.indexOf("ACH / wire") + 1);
  });

  it("lists each method once", () => {
    const list = methods();
    expect(new Set(list).size).toBe(list.length);
  });

  it("adds JobNimbus's Money order and Finance, keeping our words for the rest", () => {
    // Mark, 2026-10-07: the JobNimbus list was None, Cash, Credit Card,
    // Check, Money Order, Bank Wire, Finance. Bank Wire is our "ACH / wire".
    expect(methods()).toContain("Money order");
    expect(methods()).toContain("Finance");
    expect(methods()).not.toContain("Bank Wire");
  });

  it("is the one list: the panel defines none of its own", () => {
    expect(PANEL).not.toMatch(/const PAYMENT_METHODS = \[/);
    expect(PANEL).toMatch(/methods=\{PAYMENT_METHODS\}/);
  });
});
