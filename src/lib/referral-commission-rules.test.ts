import { readFileSync } from "node:fs";

import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import { BLANK_RULE_DRAFT, overlapMessage, ruleProblem } from "./referral-commission-rules";

/**
 * The admin form refuses what the table's CHECKs refuse, in a sentence an
 * admin can act on, before the database has to.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20261007224100_referral_commission_rules.sql",
  "utf8",
).replace(/\r\n/g, "\n");

const payee = { type: "account" as const, id: "acct" };

describe("a rule draft", () => {
  it("needs a payee and a value", () => {
    expect(ruleProblem(BLANK_RULE_DRAFT)).toMatch(/company or person/);
    expect(ruleProblem({ ...BLANK_RULE_DRAFT, payee })).toMatch(/percentage/);
    expect(ruleProblem({ ...BLANK_RULE_DRAFT, payee, kind: "flat" })).toMatch(/flat fee/);
  });

  it("a percentage stays within 0–100; a flat fee may be any positive amount", () => {
    expect(ruleProblem({ ...BLANK_RULE_DRAFT, payee, value: 101 })).toMatch(/between 0 and 100/);
    expect(ruleProblem({ ...BLANK_RULE_DRAFT, payee, value: -1 })).not.toBeNull();
    expect(ruleProblem({ ...BLANK_RULE_DRAFT, payee, value: 12.5 })).toBeNull();
    expect(ruleProblem({ ...BLANK_RULE_DRAFT, payee, kind: "flat", value: 1500 })).toBeNull();
  });

  it("refuses a window that ends before it starts", () => {
    expect(
      ruleProblem({
        ...BLANK_RULE_DRAFT,
        payee,
        value: 10,
        effective_from: "2026-10-01",
        effective_to: "2026-09-01",
      }),
    ).toMatch(/ends before/);
  });

  it("mirrors the table's own checks", () => {
    const value = MIGRATION.match(
      /CONSTRAINT referral_commission_rule_value_sane\s+CHECK \(([^;]*?)\),?\n/,
    );
    expect(value?.[1]).toContain("value >= 0");
    expect(value?.[1]).toContain("value <= 100");
    expect(MIGRATION).toMatch(/CHECK \(kind IN \('percent', 'flat'\)\)/);
  });
});

describe("an overlapping deal", () => {
  it("reads as the admin's problem, not a constraint name", () => {
    expect(overlapMessage({ code: "23P01", message: "x" })).toMatch(/already a rule/);
    expect(overlapMessage({ code: "42501", message: "denied" })).toBeNull();
  });
});
