import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  PROOF_ACCEPT,
  PROOF_BUCKET,
  proofFileProblem,
  proofKindFor,
  proofPath,
  proofState,
} from "./touchpoint-proof";

const MIGRATION = readFileSync(
  "supabase/migrations/20261110190000_followup_proof_rule.sql",
  "utf8",
);
const START = "2026-11-06T09:00:00.000Z";
const touch = (over: Partial<Parameters<typeof proofState>[0]> = {}) => ({
  is_self_reported: true,
  counts_toward_cadence: false,
  proof_kind: null,
  meeting_held: null,
  is_auto_reply: false,
  created_at: "2026-11-07T10:00:00.000Z",
  ...over,
});

describe("the proof bucket", () => {
  it("is the one the migration creates, with the same file types", () => {
    expect(MIGRATION).toContain(`'${PROOF_BUCKET}'`);
    for (const mime of PROOF_ACCEPT.split(",")) expect(MIGRATION).toContain(`'${mime}'`);
  });

  it("keeps every file under the account's folder, which the policy reads", () => {
    const p = proofPath("acc-1", "Thank you note (1).JPG", "r1");
    expect(p).toBe("acc-1/r1-Thank-you-note-1-.JPG");
    expect(proofPath("acc-1", "////", "r2")).toBe("acc-1/r2-proof");
  });

  it("files a photo as a photo and a PDF as a file", () => {
    expect(proofKindFor({ type: "image/jpeg" })).toBe("photo");
    expect(proofKindFor({ type: "application/pdf" })).toBe("file");
  });

  it("refuses other types and anything over 15 MB", () => {
    expect(proofFileProblem({ type: "text/plain", size: 10 })).toMatch(/photo or a PDF/);
    expect(proofFileProblem({ type: "image/png", size: 16 * 1024 * 1024 })).toMatch(/15 MB/);
    expect(proofFileProblem({ type: "image/png", size: 1000 })).toBeNull();
  });
});

describe("what a touch shows", () => {
  it("a hand-logged touch that counted is accepted but unverified", () => {
    expect(proofState(touch({ counts_toward_cadence: true, proof_kind: "photo" }), START)).toBe(
      "unverified",
    );
  });

  it("a booth form the client filled in is not the rep's word, so carries no mark", () => {
    expect(
      proofState(touch({ counts_toward_cadence: true, proof_kind: "form" }), START),
    ).toBeNull();
  });

  it("a button click with nothing attached is an attempt that proof can still turn", () => {
    expect(proofState(touch(), START)).toBe("needs_proof");
  });

  it("is silent for a captured touch, a meeting not held, and anything from before the rule", () => {
    expect(proofState(touch({ is_self_reported: false }), START)).toBeNull();
    expect(proofState(touch({ meeting_held: false }), START)).toBeNull();
    expect(proofState(touch({ created_at: "2026-10-01T00:00:00.000Z" }), START)).toBeNull();
    expect(proofState(touch(), null)).toBeNull();
  });
});
