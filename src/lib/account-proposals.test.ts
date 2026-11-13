import { describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

import {
  PROPOSAL_STATUSES,
  PROPOSAL_TRANSITIONS,
  canTransition,
  isEditable,
  lineTotal,
  mergeDataForAccount,
  parseLineDrafts,
  pricingTable,
  proposalStageMove,
  proposalTotals,
  renderProposalBody,
  stageMoveSentence,
  type ProposalStage,
} from "./account-proposals";

/**
 * Mark: "Is there a way to make something in the pipeline a proposal?" The
 * database decides the money, the lifecycle and where the card goes
 * (migration 20261012200000, proven in supabase/tests/account-proposals.pglite.mjs).
 * These pin the dialog's copies of the same rules to the same cases, so what
 * the rep is shown before pressing a button is what the database then does.
 */

describe("the money", () => {
  it("a line is quantity x unit price, to the cent — the generated column's arithmetic", () => {
    expect(lineTotal(2, 150.5)).toBe(301);
    // unit_price is numeric(14,2): 33.333 is stored as 33.33 before multiplying.
    expect(lineTotal(3, 33.333)).toBe(99.99);
    expect(lineTotal(1.5, 19.99)).toBe(29.99); // 29.985 rounds half away from zero
    expect(lineTotal(0.1, 0.2)).toBe(0.02);
    expect(lineTotal(1, 0)).toBe(0);
  });

  it("subtotal and total are the sum of the lines (the fixture's 400.99)", () => {
    const totals = proposalTotals([
      { description: "Monthly moisture survey", quantity: 2, unit_price: 150.5 },
      { description: "Emergency call-out retainer", quantity: 3, unit_price: 33.333 },
    ]);
    expect(totals).toEqual({ subtotal: 400.99, total: 400.99 });
  });

  it("adds in cents, so a long list never drifts by a fraction of a cent", () => {
    const lines = Array.from({ length: 30 }, () => ({
      description: "x",
      quantity: 1,
      unit_price: 0.1,
    }));
    expect(proposalTotals(lines).total).toBe(3);
  });

  it("reads typed lines, skipping the empty spare row and saying what is wrong", () => {
    const { lines, errors } = parseLineDrafts([
      { key: "a", description: "Survey", quantity: "2", unitPrice: "$1,250.00" },
      { key: "b", description: "", quantity: "1", unitPrice: "" },
      { key: "c", description: "No price", quantity: "0", unitPrice: "-4" },
      { key: "d", description: "", quantity: "1", unitPrice: "40" },
    ]);
    expect(lines).toEqual([{ description: "Survey", quantity: 2, unit_price: 1250 }]);
    expect(errors).toEqual([
      "Line 3: the quantity must be more than zero.",
      "Line 3: the unit price must be zero or more.",
      "Line 4 needs a description.",
    ]);
  });
});

describe("the lifecycle", () => {
  it("draft -> sent -> signed | declined | expired, and nothing else", () => {
    expect(canTransition("draft", "sent")).toBe(true);
    for (const to of ["signed", "declined", "expired"] as const) {
      expect(canTransition("sent", to)).toBe(true);
      expect(canTransition("draft", to)).toBe(false);
    }
    expect(canTransition("sent", "draft")).toBe(false);
    for (const end of ["signed", "declined", "expired"] as const) {
      expect(PROPOSAL_TRANSITIONS[end]).toEqual([]);
      for (const to of PROPOSAL_STATUSES) expect(canTransition(end, to)).toBe(false);
    }
  });

  it("only a draft is edited", () => {
    expect(PROPOSAL_STATUSES.filter(isEditable)).toEqual(["draft"]);
  });
});

/* The Prospecting pipeline after the migration, and the Relationship one. */
const st = (
  pipeline: string,
  key: string,
  name: string,
  sort: number,
  flags: Partial<ProposalStage> = {},
): ProposalStage => ({
  id: `${pipeline}:${key}`,
  pipeline_id: pipeline,
  key,
  name,
  sort_order: sort,
  is_won: false,
  is_lost: false,
  is_active: true,
  ...flags,
});
const PROSPECTING = [
  st("p", "ready", "Ready", 30),
  st("p", "active_outreach", "Active Outreach", 40),
  st("p", "conversation_established", "Conversation Established", 50),
  st("p", "proposal_sent", "Proposal sent", 60),
  st("p", "active_client", "Active Client", 70, { is_won: true }),
  st("p", "no_service_needed", "No Service Needed", 80, { is_lost: true }),
  st("p", "goasted", "GOASTED", 90, { is_lost: true }),
];
const RELATIONSHIP = [
  st("r", "meeting_held", "Meeting held", 50),
  st("r", "proposal_sent", "Proposal sent", 60),
  st("r", "vendor_onboarding", "Vendor onboarding", 70),
  st("r", "active", "Active", 80, { is_won: true }),
  st("r", "lost", "Lost", 110, { is_lost: true }),
];
const NO_WON = [
  st("n", "open", "Open", 10),
  st("n", "proposal_sent", "Proposal sent", 20),
  st("n", "kickoff", "Kickoff", 30),
  st("n", "dropped", "Dropped", 40, { is_lost: true }),
];
const ALL = [...PROSPECTING, ...RELATIONSHIP, ...NO_WON];

describe("where the card goes", () => {
  it("sent moves an earlier card to Proposal sent", () => {
    for (const from of ["p:ready", "p:active_outreach", "p:conversation_established"]) {
      const move = proposalStageMove(ALL, from, "sent");
      expect(move.kind === "move" && move.stage.id).toBe("p:proposal_sent");
    }
    const rel = proposalStageMove(ALL, "r:meeting_held", "sent");
    expect(rel.kind === "move" && rel.stage.id).toBe("r:proposal_sent");
  });

  it("never backwards: at, past, won or lost stays put and says why", () => {
    expect(proposalStageMove(ALL, "p:proposal_sent", "sent")).toEqual({
      kind: "stay",
      reason: "Not moved: already at Proposal sent.",
    });
    expect(proposalStageMove(ALL, "p:active_client", "sent")).toEqual({
      kind: "stay",
      reason: "Not moved: already at Active Client.",
    });
    expect(proposalStageMove(ALL, "p:goasted", "sent").kind).toBe("stay");
    expect(proposalStageMove(ALL, "p:no_service_needed", "signed").kind).toBe("stay");
    expect(proposalStageMove(ALL, "r:vendor_onboarding", "sent").kind).toBe("stay");
  });

  it("signed goes to the won stage, Active Client first", () => {
    const p = proposalStageMove(ALL, "p:proposal_sent", "signed");
    expect(p.kind === "move" && p.stage.key).toBe("active_client");
    // Even straight from Conversation Established (a paper signature).
    const early = proposalStageMove(ALL, "p:conversation_established", "signed");
    expect(early.kind === "move" && early.stage.key).toBe("active_client");
    const r = proposalStageMove(ALL, "r:proposal_sent", "signed");
    expect(r.kind === "move" && r.stage.key).toBe("active");
  });

  it("a pipeline with no won stage wins into the stage after Proposal sent", () => {
    const n = proposalStageMove(ALL, "n:proposal_sent", "signed");
    expect(n.kind === "move" && n.stage.key).toBe("kickoff");
  });

  it("declined never moves the card", () => {
    expect(proposalStageMove(ALL, "p:proposal_sent", "declined")).toEqual({
      kind: "stay",
      reason: "Declined — the card stays where it is.",
    });
  });

  it("a pipeline without the stage, or a card with no stage, stays", () => {
    const bare = [st("b", "open", "Open", 10), st("b", "done", "Done", 20, { is_won: true })];
    expect(proposalStageMove(bare, "b:open", "sent")).toEqual({
      kind: "stay",
      reason: "Not moved: this pipeline has no Proposal sent stage.",
    });
    expect(proposalStageMove(ALL, null, "sent").kind).toBe("stay");
  });

  it("an inactive Proposal sent stage counts as no stage", () => {
    const off = PROSPECTING.map((s) =>
      s.key === "proposal_sent" ? { ...s, is_active: false } : s,
    );
    expect(proposalStageMove(off, "p:active_outreach", "sent").kind).toBe("stay");
  });

  it("says it in one plain line", () => {
    expect(stageMoveSentence(proposalStageMove(ALL, "p:ready", "sent"), "Sending")).toBe(
      "Sending moves this card to Proposal sent.",
    );
    expect(stageMoveSentence(proposalStageMove(ALL, "p:active_client", "sent"), "Sending")).toBe(
      "Sending leaves the card where it is — already at Active Client.",
    );
  });
});

describe("the document body", () => {
  const lines = [
    { description: "Monthly moisture survey", quantity: 2, unit_price: 150.5 },
    { description: "Retainer", quantity: 1, unit_price: 99.99 },
  ];
  const base = mergeDataForAccount(
    { name: "Flatbush Co-op", address_line1: "1 Main St", city: "Brooklyn", state: "NY" },
    { full_name: "Dana Whitfield", email: "dana@example.test", phone: null },
  );

  it("prints every line and the total", () => {
    expect(pricingTable(lines)).toBe(
      [
        "Monthly moisture survey — 2 x $150.50 = $301.00",
        "Retainer — 1 x $99.99 = $99.99",
        "",
        "Total: $400.99",
      ].join("\n"),
    );
  });

  it("fills the template's keys and puts the pricing where it asked", () => {
    const body = renderProposalBody(
      "Prepared for {{customer.name}} at {{account.name}}.\n\n{{proposal.table}}\n\nThank you.",
      { title: "Annual agreement", notes: null, terms: null },
      lines,
      base,
    );
    expect(body).toContain("Prepared for Dana Whitfield at Flatbush Co-op.");
    expect(body).toContain("Total: $400.99\n\nThank you.");
    expect(body).not.toContain("{{");
    expect(body.match(/Total:/g)).toHaveLength(1);
  });

  it("appends the pricing when the template has no place for it, then notes and terms", () => {
    const body = renderProposalBody(
      "Scope of work for {{proposal.title}}.",
      { title: "Annual agreement", notes: "Starts in May.", terms: "Net 30." },
      lines,
      base,
    );
    expect(body.indexOf("Scope of work for Annual agreement.")).toBe(0);
    expect(body.indexOf("Pricing")).toBeGreaterThan(0);
    expect(body.indexOf("Notes\n\nStarts in May.")).toBeGreaterThan(body.indexOf("Total:"));
    expect(body.indexOf("Terms\n\nNet 30.")).toBeGreaterThan(body.indexOf("Notes"));
  });

  it("with no template, the title and the pricing", () => {
    const body = renderProposalBody(
      null,
      { title: "Annual agreement", notes: "", terms: null },
      lines,
      base,
    );
    expect(body.startsWith("Annual agreement\n\nPricing\n\n")).toBe(true);
    expect(body).not.toContain("Notes");
  });
});
