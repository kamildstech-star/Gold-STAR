import { describe, expect, it } from "vitest";

import {
  JOB_REPLY_TARGETS,
  coerceModelValues,
  coerceReplyDate,
  coerceReplyPhone,
  extractReplyFields,
  mailHtmlToText,
  matchTarget,
  normalizeSubject,
  pickInfoRequest,
  questionTargets,
  replyLines,
  stripQuotedReply,
  type InfoRequestCandidate,
} from "./info-reply";

/*
 * Mark, 13 Oct: the customer's answer to "send an email for info" must come
 * back as values for the job's own fields, not as a task. These pin the
 * reading: which lines are the customer's, which field each answer belongs
 * to, and how a written value becomes a stored one.
 */

const RECEIVED = new Date("2026-10-13T15:00:00Z");

const QUESTIONS = questionTargets([
  { id: "q-power", prompt: "Is the power on?", answer_type: "yes_no" },
  { id: "q-water", prompt: "Standing water?", answer_type: "yes_no" },
  { id: "q-occupied", prompt: "Occupied?", answer_type: "yes_no" },
  { id: "q-units", prompt: "Units affected", answer_type: "text" },
  {
    id: "q-property",
    prompt: "Type of property",
    answer_type: "choice",
    choices: ["Single family", "Multi family", "Commercial"],
  },
  { id: "q-carrier", prompt: "Was the carrier contacted?", answer_type: "yes_no" },
  { id: "q-source", prompt: "How did you hear about us?", answer_type: "reported_source" },
]);
const TARGETS = [...JOB_REPLY_TARGETS, ...QUESTIONS];

const SENT = [
  "Hi Jane,",
  "To get your claim moving we need a few details:",
  "Date of loss:",
  "Is the power on?",
  "Policy #:",
  "Best phone number:",
  "Thanks, Gold Star Restoration",
].join("\n");

describe("reading a reply into job fields", () => {
  it("maps 'Label: value' answers onto job columns, contact methods and questions", () => {
    const reply = [
      "Hi, here you go.",
      "Date of loss: 10/3",
      "Power on: Yes",
      "Policy # HO-55821-A",
      "Claim number - 0042117",
      "Phone: 732.555.0142",
      "Insurance company: State Farm",
      "Type of property: single family home",
      "Units affected: 2",
      "Standing water? No",
    ].join("\n");
    const out = extractReplyFields(replyLines(reply, SENT), TARGETS, RECEIVED);
    expect(out.fields).toEqual({
      loss_date: "2026-10-03",
      claim_number: "0042117",
      customer_phone: "(732) 555-0142",
      insurance_carrier: "State Farm",
    });
    expect(out.answers).toEqual({
      "q-power": { bool: true },
      "q-property": { text: "Single family" },
      "q-units": { text: "2" },
      "q-water": { bool: false },
    });
  });

  it("reads inline answers under our own questions and ignores the lines we wrote", () => {
    const reply = [
      "See answers below",
      "",
      "From: Gold Star Restoration",
      "Sent: Monday, October 12, 2026 9:14 AM",
      "Subject: Request for information",
      "> Hi Jane,",
      "> To get your claim moving we need a few details:",
      "> Date of loss: October 3rd",
      "> Is the power on?",
      "> no",
      "> Policy #:",
      "> Best phone number:",
    ].join("\n");
    const lines = replyLines(reply, SENT);
    expect(lines).not.toContain("Hi Jane,");
    expect(lines.some((l) => /^Sent:/.test(l))).toBe(false);
    const out = extractReplyFields(lines, TARGETS, RECEIVED);
    expect(out.fields).toEqual({ loss_date: "2026-10-03" });
    // "Is the power on?" alone is our line and is dropped, so the bare "no"
    // under it has no label to belong to — never guessed.
    expect(out.answers).toEqual({});
  });

  it("pairs a question alone on its line with the answer on the next", () => {
    const out = extractReplyFields(
      ["Was the carrier contacted?", "Yes, on Friday", "Date of loss:", "9/30/2026"],
      TARGETS,
      RECEIVED,
    );
    expect(out.answers["q-carrier"]).toEqual({ bool: true });
    expect(out.fields["loss_date"]).toBe("2026-09-30");
  });

  it("accepts a plain sentence only when the label is exact", () => {
    const out = extractReplyFields(
      ["My policy number is HO-1234.", "The house is a mess", "The deductible was $1,000"],
      TARGETS,
      RECEIVED,
    );
    expect(out.fields).toEqual({ policy_number: "HO-1234", deductible: "1000" });
  });

  it("drops a value that does not read as its kind instead of guessing", () => {
    const out = extractReplyFields(
      ["Date of loss: last week sometime", "Power on: not sure", "Phone: call my husband"],
      TARGETS,
      RECEIVED,
    );
    expect(out).toEqual({ fields: {}, answers: {} });
  });

  it("keeps the first answer for a field (the newest thing written)", () => {
    const out = extractReplyFields(["Claim #: 111", "Claim #: 222"], TARGETS, RECEIVED);
    expect(out.fields["claim_number"]).toBe("111");
  });

  it("never offers the source question, which writes to the job record", () => {
    expect(QUESTIONS.map((q) => q.id)).not.toContain("q-source");
  });
});

describe("labels", () => {
  it("prefers the exact spelling and the longer partial match", () => {
    expect(matchTarget("Adjuster phone", TARGETS)?.id).toBe("adjuster_phone");
    expect(matchTarget("Phone", TARGETS)?.id).toBe("customer_phone");
    expect(matchTarget("Policy holder", TARGETS)?.id).toBe("customer_name");
    expect(matchTarget("Policy No.", TARGETS)?.id).toBe("policy_number");
    expect(matchTarget("Carrier contacted", TARGETS)?.id).toBe("q-carrier");
    expect(matchTarget("Favorite color", TARGETS)).toBeNull();
  });
});

describe("values", () => {
  it("reads US dates and never puts a yearless loss in the future", () => {
    expect(coerceReplyDate("10/3", RECEIVED)).toBe("2026-10-03");
    expect(coerceReplyDate("12/24", RECEIVED)).toBe("2025-12-24");
    expect(coerceReplyDate("10/03/26", RECEIVED)).toBe("2026-10-03");
    expect(coerceReplyDate("Oct 3rd, 2026", RECEIVED)).toBe("2026-10-03");
    expect(coerceReplyDate("Saturday, October 3", RECEIVED)).toBe("2026-10-03");
    expect(coerceReplyDate("3 Oct", RECEIVED)).toBe("2026-10-03");
    expect(coerceReplyDate("2026-10-03", RECEIVED)).toBe("2026-10-03");
    expect(coerceReplyDate("2/30", RECEIVED)).toBeNull();
    expect(coerceReplyDate("yesterday", RECEIVED)).toBeNull();
  });

  it("prints phone numbers the way the office types them", () => {
    expect(coerceReplyPhone("+1 (732) 555-0142")).toBe("(732) 555-0142");
    expect(coerceReplyPhone("7325550142 ext 12")).toBe("(732) 555-0142 x12");
    expect(coerceReplyPhone("555-0142")).toBeNull();
  });

  it("runs the model's values through the same coercion and drops unknown ids", () => {
    const out = coerceModelValues(
      {
        loss_date: "Oct 3",
        "q:q-power": true,
        made_up: "x",
        claim_number: 12345,
        policy_number: "",
      },
      TARGETS,
      RECEIVED,
    );
    expect(out).toEqual({
      fields: { loss_date: "2026-10-03", claim_number: "12345" },
      answers: { "q-power": { bool: true } },
    });
    expect(coerceModelValues("not an object", TARGETS, RECEIVED)).toEqual({
      fields: {},
      answers: {},
    });
  });
});

describe("text", () => {
  it("turns a mail body into lines and keeps only the new part for the snippet", () => {
    const text = mailHtmlToText(
      "<div>Date of loss: 10/3<br>Power on: yes</div><p>Thanks &amp; regards</p><div>On Mon, Oct 12, 2026 at 9:14 AM Gold Star wrote:</div><blockquote>old</blockquote>",
    );
    expect(text).toContain("Thanks & regards");
    expect(stripQuotedReply(text)).toBe("Date of loss: 10/3\nPower on: yes\nThanks & regards");
  });
});

describe("which request a reply answers", () => {
  const older: InfoRequestCandidate = {
    requestId: "r-old",
    jobId: "j-1",
    jobNumber: "GS-1001",
    createdAt: "2026-10-01T10:00:00Z",
    sentSubjects: ["Request for information — 12 Main St"],
  };
  const newer: InfoRequestCandidate = {
    requestId: "r-new",
    jobId: "j-2",
    jobNumber: "GS-1002",
    createdAt: "2026-10-10T10:00:00Z",
    sentSubjects: ["Request for information — 40 Oak Ave"],
  };

  it("threads on the subject, ignoring RE:/FW: prefixes and punctuation", () => {
    expect(normalizeSubject("RE: Fw: Request for information — 12 Main St")).toBe(
      "request for information 12 main st",
    );
    expect(
      pickInfoRequest({ subject: "RE: Request for information - 12 Main St", text: "" }, [
        older,
        newer,
      ])?.requestId,
    ).toBe("r-old");
  });

  it("falls back to the job number named in the reply", () => {
    expect(
      pickInfoRequest({ subject: "Details", text: "This is for job GS-1002." }, [older, newer])
        ?.requestId,
    ).toBe("r-new");
    // Part of a longer number is not a mention.
    expect(
      pickInfoRequest({ subject: "Details", text: "Ref GS-10021" }, [older, newer]),
    ).toBeNull();
  });

  it("is not a reply to any request when neither matches", () => {
    expect(pickInfoRequest({ subject: "Lunch?", text: "Are you free" }, [older, newer])).toBeNull();
  });
});
