import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  AUTO_PAY_STAGE_KEYS,
  creditLine,
  creditRequiresApproval,
  payoutCreditNote,
} from "./job-credit";

/**
 * Melly: "If the account was in Ready or Active Outreach, the manager
 * approves or declines. If it was in Conversation Established or already a
 * client, it pays automatically." One rule, held in the database snapshot
 * function and mirrored here; the first test pins the two together.
 */
const MIGRATION = readFileSync(
  "supabase/migrations/20261110180000_job_credit_at_arrival.sql",
  "utf8",
);

describe("which stages pay automatically", () => {
  it("the database snapshot names exactly the stages this module does", () => {
    const m = MIGRATION.match(/stage_key NOT IN \(([^)]*)\)/);
    expect(m).not.toBeNull();
    const keys = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(keys).toEqual([...AUTO_PAY_STAGE_KEYS].sort());
  });

  it("Ready and Active Outreach need the manager; Conversation Established and a client do not", () => {
    expect(creditRequiresApproval("ready")).toBe(true);
    expect(creditRequiresApproval("active_outreach")).toBe(true);
    expect(creditRequiresApproval("conversation_established")).toBe(false);
    expect(creditRequiresApproval("active_client")).toBe(false);
  });

  it("an unknown or missing stage is never paid without a look", () => {
    expect(creditRequiresApproval(null)).toBe(true);
    expect(creditRequiresApproval("goasted")).toBe(true);
  });
});

describe("the credit line", () => {
  it("says where the account was and what follows", () => {
    expect(
      creditLine({ credit_stage_key: "active_outreach", credit_requires_approval: true }),
    ).toBe("Account was in Active Outreach when the job arrived · manager approves or declines");
    expect(creditLine({ credit_stage_key: "active_client", credit_requires_approval: false })).toBe(
      "Account was an active client when the job arrived · pays automatically",
    );
  });
});

describe("the note beside a payout", () => {
  it("is silent for a payout with no snapshot (jobs from before the rule)", () => {
    expect(payoutCreditNote({ status: "pending", jobs: { credit_stage_key: null } })).toBeNull();
    expect(payoutCreditNote({ status: "pending" })).toBeNull();
  });
  it("says a pending payout is waiting on the manager, and why", () => {
    const n = payoutCreditNote({
      status: "pending",
      jobs: { credit_stage_key: "ready", credit_requires_approval: true },
    });
    expect(n?.tone).toBe("warning");
    expect(n?.text).toContain("Ready");
  });
  it("marks the engine's own approval apart from a person's", () => {
    const auto = payoutCreditNote({
      status: "approved",
      approved_by: null,
      jobs: { credit_stage_key: "conversation_established", credit_requires_approval: false },
    });
    expect(auto?.text).toMatch(/^Auto-approved/);
    const person = payoutCreditNote({
      status: "approved",
      approved_by: "user-1",
      jobs: { credit_stage_key: "ready", credit_requires_approval: true },
    });
    expect(person).toBeNull();
  });
  it("names a declined payout", () => {
    expect(payoutCreditNote({ status: "void", jobs: { credit_stage_key: "ready" } })?.text).toBe(
      "Declined by the manager",
    );
  });
});
