import { beforeEach, describe, expect, it, vi } from "vitest";

const writes = vi.hoisted(() => ({
  job: vi.fn(async () => ({ ok: true, queued: false })),
  answers: vi.fn(async () => undefined),
  contacts: vi.fn(async () => undefined),
}));
vi.mock("@/lib/job-update", () => ({ updateJobFieldsQueued: writes.job }));
vi.mock("@/lib/intake-questions", () => ({ saveJobIntakeAnswers: writes.answers }));
vi.mock("@/lib/job-contact-methods", () => ({ insertJobContactMethods: writes.contacts }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), success: vi.fn() } }));

import {
  bubbleText,
  buildSuggestionRows,
  heldBackFieldIds,
  submissionStatusAfter,
  type SuggestionContext,
  type SuggestionSubmission,
} from "./info-suggestions";
import { applySuggestionItems } from "./info-suggestions-apply";

/*
 * The review panel's rows: each proposal against what the job holds, and
 * Apply going through the job's normal write paths — never a direct table
 * write of its own.
 */

const SUB: SuggestionSubmission = {
  id: "sub-1",
  submitted_by_name: "Jane Smith",
  submitted_by_email: "jane@example.com",
  created_at: "2026-10-13T15:00:00Z",
  status: "pending",
  source: "email_reply",
  source_excerpt: "Date of loss: 10/3",
  fields: {
    loss_date: "2026-10-03",
    claim_number: "0042117",
    policy_number: "HO-1",
    customer_phone: "(732) 555-0142",
    customer_email: "jane@example.com",
    site_address: "12 Main St",
    site_lat: "40.1",
    job_number: "HACKED",
    deductible: "1000",
  },
  answers: { "q-power": { bool: true }, "q-units": { text: "2" } },
};

const ctx = (over: Partial<SuggestionContext> = {}): SuggestionContext => ({
  job: {
    id: "job-1",
    loss_date: null,
    claim_number: "0042117",
    policy_number: "HO-OLD",
    address: "12 Main Street",
  },
  answers: { "q-units": { answer_text: "1", answer_bool: null, answer_date: null } },
  questions: [
    { id: "q-power", prompt: "Is the power on?", answer_type: "yes_no" },
    { id: "q-units", prompt: "Units affected", answer_type: "text" },
  ],
  contactValues: { phone: ["732-555-0142"], email: [] },
  lossTypeLabel: (id) => `label:${id}`,
  canSee: () => true,
  ...over,
});

describe("suggestion rows", () => {
  it("offers what is new, says what it replaces, and skips what the job already holds", () => {
    const rows = buildSuggestionRows(SUB, ctx());
    const byField = Object.fromEntries(rows.map((r) => [r.fieldId, r]));

    // Already on the job: no row.
    expect(byField["f:claim_number"]).toBeUndefined();
    expect(byField["f:customer_phone"]).toBeUndefined(); // same digits as the contact's
    // Geo parts and fields behind a confirmation are never one-click writes.
    expect(byField["f:site_lat"]).toBeUndefined();
    expect(byField["f:job_number"]).toBeUndefined();

    expect(byField["f:loss_date"]).toMatchObject({
      target: { type: "job", column: "loss_date" },
      currentText: "—",
      overwrites: false,
      status: "pending",
    });
    expect(byField["f:policy_number"]).toMatchObject({
      currentText: "HO-OLD",
      proposedText: "HO-1",
      overwrites: true,
    });
    expect(byField["f:customer_email"]).toMatchObject({
      target: { type: "contact", kind: "email" },
      overwrites: false,
    });
    expect(byField["f:site_address"]).toMatchObject({ target: { type: "advisory" } });
    expect(byField["a:q-power"]).toMatchObject({
      target: { type: "answer", questionId: "q-power" },
      proposedText: "Yes",
      currentText: "—",
    });
    expect(byField["a:q-units"]).toMatchObject({
      currentText: "1",
      proposedText: "2",
      overwrites: true,
    });
  });

  it("hides a field this person may not see (money without cost access)", () => {
    const rows = buildSuggestionRows(SUB, ctx({ canSee: (c) => c !== "deductible" }));
    expect(rows.find((r) => r.fieldId === "f:deductible")).toBeUndefined();
  });

  it("carries decisions already made and closes the submission when none are pending", () => {
    const rows = buildSuggestionRows(
      { ...SUB, field_review: { "f:loss_date": { status: "applied", value: "2026-10-03" } } },
      ctx(),
    );
    expect(rows.find((r) => r.fieldId === "f:loss_date")?.status).toBe("applied");
    expect(submissionStatusAfter(rows)).toBe("pending");
    expect(submissionStatusAfter([{ status: "applied" }, { status: "dismissed" }])).toBe("applied");
    expect(submissionStatusAfter([{ status: "dismissed" }])).toBe("dismissed");
  });

  it("words the bubble the way Mark asked for it", () => {
    expect(bubbleText([SUB], 4)).toBe("New info from Jane Smith — 4 fields to review");
    expect(bubbleText([SUB, { submitted_by_name: null, submitted_by_email: "pa@x.com" }], 1)).toBe(
      "New info from Jane Smith and 1 more — 1 field to review",
    );
  });
});

describe("Apply", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes job columns as one patch through updateJobFieldsQueued, answers and contacts through theirs", async () => {
    const rows = buildSuggestionRows(SUB, ctx());
    const pick = (f: string) => rows.find((r) => r.fieldId === f)!;
    const touched = await applySuggestionItems({
      jobId: "job-1",
      userId: "user-1",
      items: [
        { row: pick("f:loss_date"), value: "2026-10-03" },
        { row: pick("f:policy_number"), value: "HO-1" },
        { row: pick("f:deductible"), value: "1000" },
        { row: pick("a:q-power"), value: "true" },
        { row: pick("f:customer_email"), value: "jane@example.com" },
      ],
    });
    expect(writes.job).toHaveBeenCalledTimes(1);
    expect(writes.job).toHaveBeenCalledWith(
      "job-1",
      { loss_date: "2026-10-03", policy_number: "HO-1", deductible: 1000 },
      "Recipient details",
    );
    expect(writes.answers).toHaveBeenCalledWith(
      "job-1",
      {
        "q-power": {
          question_id: "q-power",
          answer_text: null,
          answer_bool: true,
          answer_date: null,
        },
      },
      "user-1",
      { source: "recipient" },
    );
    expect(writes.contacts).toHaveBeenCalledWith("job-1", [
      { kind: "email", value: "jane@example.com" },
    ]);
    expect(touched).toEqual({ job: true, answers: true, contacts: true });
  });

  it("applies an edited value, and links a confirmed carrier only when the job has none", async () => {
    const rows = buildSuggestionRows(
      { ...SUB, fields: { insurance_carrier: "State Farm" }, answers: {} },
      ctx(),
    );
    await applySuggestionItems({
      jobId: "job-1",
      userId: null,
      carrierAccountId: "acct-sf",
      jobHasCarrierAccount: false,
      items: [{ row: rows[0]!, value: "State Farm Fire & Casualty" }],
    });
    expect(writes.job).toHaveBeenCalledWith(
      "job-1",
      { insurance_carrier: "State Farm Fire & Casualty", insurance_carrier_account_id: "acct-sf" },
      "Recipient details",
    );
    expect(writes.answers).not.toHaveBeenCalled();
    expect(writes.contacts).not.toHaveBeenCalled();
  });

  it("refuses to call a lost job write applied", async () => {
    writes.job.mockResolvedValueOnce({ ok: false, queued: false });
    const rows = buildSuggestionRows(SUB, ctx());
    await expect(
      applySuggestionItems({
        jobId: "job-1",
        userId: null,
        items: [{ row: rows.find((r) => r.fieldId === "f:loss_date")!, value: "2026-10-03" }],
      }),
    ).rejects.toThrow("could not be saved");
  });
});

/*
 * David, 13 Oct: a reply with several items — approve ONE and the others must
 * stay alive. Each decision is stored per field; the reply stays pending while
 * anything is undecided, including items this reviewer is not shown.
 */
describe("partial approval of a multi-item reply", () => {
  it("approving one item leaves the others pending", () => {
    const rows = buildSuggestionRows(SUB, ctx());
    const pendingBefore = rows.filter((r) => r.status === "pending").length;
    expect(pendingBefore).toBeGreaterThan(1);
    const after = rows.map((r, i) => (i === 0 ? { ...r, status: "applied" as const } : r));
    expect(submissionStatusAfter(after)).toBe("pending");
    expect(after.filter((r) => r.status === "pending")).toHaveLength(pendingBefore - 1);
  });

  it("an approved item is remembered, so the rest come back after a reload", () => {
    const first = buildSuggestionRows(SUB, ctx())[0]!;
    const reloaded = buildSuggestionRows(
      { ...SUB, field_review: { [first.fieldId]: { status: "applied", value: first.proposed } } },
      ctx(),
    );
    expect(reloaded.find((r) => r.fieldId === first.fieldId)?.status).toBe("applied");
    expect(reloaded.filter((r) => r.status === "pending").length).toBeGreaterThan(0);
  });

  it("deciding every item THIS person sees does not close items hidden from them", () => {
    const limited = ctx({ canSee: (c) => c !== "deductible" });
    const rows = buildSuggestionRows(SUB, limited).map((r) => ({
      ...r,
      status: "applied" as const,
    }));
    const held = heldBackFieldIds(SUB, limited);
    expect(held).toEqual(["f:deductible"]);
    expect(submissionStatusAfter(rows, held)).toBe("pending");
  });

  it("closes once the hidden item is decided by someone who can see it", () => {
    const limited = ctx({ canSee: (c) => c !== "deductible" });
    const decided = {
      ...SUB,
      field_review: { "f:deductible": { status: "applied" as const, value: "1000" } },
    };
    expect(heldBackFieldIds(decided, limited)).toEqual([]);
  });

  it("does not hold a reply open for a value the job already has, or one no one is offered", () => {
    const limited = ctx({ canSee: (c) => c !== "deductible" && c !== "claim_number" });
    // claim_number already matches the job; job_number is behind a confirmation.
    expect(heldBackFieldIds(SUB, limited)).toEqual(["f:deductible"]);
  });
});
