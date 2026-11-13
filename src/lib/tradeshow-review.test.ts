/**
 * What the post-show review pass has to be right about.
 *
 * The queue is the only thing standing between a spoken lead and a forgotten
 * one, so the rules it enforces are not cosmetic:
 *
 *  - oldest first, because that is the order he met people in;
 *  - a capture with no recording is still in the queue — the row is the
 *    evidence somebody was met, and losing it is the failure this exists to
 *    prevent;
 *  - skipping moves past a note, it never removes it, and when everything
 *    left has been skipped the queue comes back round rather than claiming to
 *    be empty;
 *  - a reviewed capture leaves the pending set but stays in the count, so
 *    "7 of 23" keeps meaning what it says.
 */
import { describe, expect, it } from "vitest";

import type { LeadMedia } from "@/lib/tradeshow-capture";
import { isVoiceCaptureName, voiceCaptureName } from "@/lib/tradeshow-capture";
import {
  buildReviewQueue,
  pickNextForReview,
  reviewProgress,
  unreviewedAccountIds,
  validateReviewFields,
  type CaptureStateRow,
} from "@/lib/tradeshow-review";
import type { ShowAccount } from "@/lib/tradeshows";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function account(id: string, over: Partial<ShowAccount> = {}): ShowAccount {
  return {
    id,
    name: `Voice note · Sep 9, 2:${id.slice(-2)} PM`,
    status: null,
    stage: null,
    estimated_annual_value: null,
    assigned_rep: "rep-1",
    created_at: "2026-09-09T14:00:00.000Z",
    contact_name: null,
    contact_id: null,
    phone: null,
    email: null,
    ...over,
  };
}

function state(accountId: string, over: Partial<CaptureStateRow> = {}): CaptureStateRow {
  return {
    account_id: accountId,
    tradeshow_id: "show-1",
    needs_review: true,
    badge_raw: null,
    captured_at: "2026-09-09T14:00:00.000Z",
    reviewed_at: null,
    reviewed_by: null,
    created_by: "rep-1",
    created_at: "2026-09-09T14:00:00.000Z",
    updated_at: "2026-09-09T14:00:00.000Z",
    is_demo: false,
    ...over,
  } as CaptureStateRow;
}

const audio = (accountId: string): LeadMedia =>
  ({
    id: `m-${accountId}`,
    account_id: accountId,
    tradeshow_id: "show-1",
    kind: "audio",
    storage_path: `u/${accountId}/voice.webm`,
    duration_seconds: 12,
    waveform_peaks: [0.4, 0.9],
  }) as unknown as LeadMedia;

function queueOf(ids: { id: string; at: string; reviewed?: boolean; withAudio?: boolean }[]) {
  const accounts = ids.map((x) => account(x.id, { created_at: x.at }));
  const states = ids.map((x) =>
    state(x.id, { captured_at: x.at, needs_review: !x.reviewed } as Partial<CaptureStateRow>),
  );
  const media = new Map(
    ids
      .filter((x) => x.withAudio !== false)
      .map((x) => [x.id, { photo: null, audio: audio(x.id), badge: null }]),
  );
  return buildReviewQueue({ accounts, states, media });
}

/* ------------------------------------------------------------------ */

describe("buildReviewQueue", () => {
  it("orders oldest first — the order he met them in", () => {
    const q = queueOf([
      { id: "a-03", at: "2026-09-09T16:00:00.000Z" },
      { id: "a-01", at: "2026-09-09T09:00:00.000Z" },
      { id: "a-02", at: "2026-09-09T12:00:00.000Z" },
    ]);
    expect(q.map((e) => e.accountId)).toEqual(["a-01", "a-02", "a-03"]);
  });

  it("keeps a capture whose recording never uploaded — the row is the evidence", () => {
    const q = buildReviewQueue({
      accounts: [account("a-01")],
      states: [state("a-01")],
      media: new Map(),
    });
    expect(q).toHaveLength(1);
    expect(q[0]!.audio).toBeNull();
    expect(q[0]!.needsReview).toBe(true);
  });

  it("leaves ordinary leads out — only captures have a state row", () => {
    const q = buildReviewQueue({
      accounts: [account("a-01"), account("typed-in", { name: "Falcon Marketing" })],
      states: [state("a-01")],
      media: new Map(),
    });
    expect(q.map((e) => e.accountId)).toEqual(["a-01"]);
  });

  it("does not offer a placeholder name as the company, but a real one prefills", () => {
    const q = buildReviewQueue({
      accounts: [
        account("a-01", { name: "Voice note · Sep 9, 2:14 PM" }),
        account("a-02", { name: "Falcon Marketing", phone: "555-0101" }),
      ],
      states: [state("a-01"), state("a-02")],
      media: new Map(),
    });
    expect(q.find((e) => e.accountId === "a-01")!.prefill.company).toBe("");
    const real = q.find((e) => e.accountId === "a-02")!;
    expect(real.prefill.company).toBe("Falcon Marketing");
    expect(real.prefill.phone).toBe("555-0101");
  });

  it("starts the fields from a badge that decoded to a contact card, never from an attendee id", () => {
    const q = buildReviewQueue({
      accounts: [
        account("a-01", { name: "Voice note · Sep 9, 2:14 PM" }),
        account("a-02", { name: "Voice note · Sep 9, 2:20 PM" }),
      ],
      states: [
        state("a-01", {
          badge_raw: [
            "BEGIN:VCARD",
            "VERSION:3.0",
            "N;CHARSET=utf-8:Lesser;Elly;;;",
            "FN;CHARSET=utf-8:Elly Lesser",
            "ORG;CHARSET=utf-8:Fairmont Insurance Brokers",
            "EMAIL;INTERNET:elesser@fairmontins.com",
            "TEL;WORK,VOICE:+1 718-906-0452",
            "END:VCARD",
          ].join("\r\n"),
        }),
        state("a-02", { badge_raw: "H3NHH2Q4M5H" }),
      ],
      media: new Map(),
    });
    expect(q.find((e) => e.accountId === "a-01")!.prefill).toEqual({
      name: "Elly Lesser",
      company: "Fairmont Insurance Brokers",
      phone: "+1 718-906-0452",
      email: "elesser@fairmontins.com",
      notes: "",
    });
    const opaque = q.find((e) => e.accountId === "a-02")!;
    expect(opaque.prefill).toEqual({ name: "", company: "", phone: "", email: "", notes: "" });
    expect(opaque.badgeRaw).toBe("H3NHH2Q4M5H");
  });

  it("does not offer the person's own name back as the company", () => {
    // A booth capture typed with just "Dana" is an account called Dana.
    const q = buildReviewQueue({
      accounts: [
        account("a-01", { name: "Dana Ortiz", contact_name: "Dana Ortiz" }),
        account("a-02", { name: "Card photo · Sep 9, 2:14 PM" }),
      ],
      states: [state("a-01"), state("a-02")],
      media: new Map(),
    });
    const dana = q.find((e) => e.accountId === "a-01")!;
    expect(dana.prefill.name).toBe("Dana Ortiz");
    expect(dana.prefill.company).toBe("");
    expect(q.find((e) => e.accountId === "a-02")!.prefill.company).toBe("");
  });

  it("carries the raw badge value through untouched, trimmed only", () => {
    const q = buildReviewQueue({
      accounts: [account("a-01")],
      states: [state("a-01", { badge_raw: "  V1;ATT=99123;FALCON  " } as Partial<CaptureStateRow>)],
      media: new Map(),
    });
    expect(q[0]!.badgeRaw).toBe("V1;ATT=99123;FALCON");
  });

  it("sorts stably when two captures share a timestamp", () => {
    const q = queueOf([
      { id: "a-02", at: "2026-09-09T09:00:00.000Z" },
      { id: "a-01", at: "2026-09-09T09:00:00.000Z" },
    ]);
    expect(q.map((e) => e.accountId)).toEqual(["a-01", "a-02"]);
  });
});

describe("reviewProgress", () => {
  it("counts reviewed against everything captured, not against what is left", () => {
    const q = queueOf([
      { id: "a-01", at: "2026-09-09T09:00:00.000Z", reviewed: true },
      { id: "a-02", at: "2026-09-09T10:00:00.000Z" },
      { id: "a-03", at: "2026-09-09T11:00:00.000Z" },
    ]);
    expect(reviewProgress(q)).toMatchObject({
      reviewed: 1,
      total: 3,
      remaining: 2,
      label: "1 of 3 reviewed",
    });
  });

  it("says so when a show has captured nothing", () => {
    expect(reviewProgress([])).toMatchObject({ total: 0, label: "Nothing captured yet" });
  });
});

describe("pickNextForReview", () => {
  const q = () =>
    queueOf([
      { id: "a-01", at: "2026-09-09T09:00:00.000Z" },
      { id: "a-02", at: "2026-09-09T10:00:00.000Z" },
      { id: "a-03", at: "2026-09-09T11:00:00.000Z" },
    ]);

  it("opens the oldest unreviewed capture first", () => {
    expect(pickNextForReview(q())!.accountId).toBe("a-01");
  });

  it("moves to the following note after one is saved", () => {
    const entries = q();
    entries[0]!.needsReview = false;
    expect(pickNextForReview(entries, { after: "a-01" })!.accountId).toBe("a-02");
  });

  it("steps past a skipped note without removing it from the queue", () => {
    const entries = q();
    const next = pickNextForReview(entries, { after: "a-01", skipped: new Set(["a-02"]) });
    expect(next!.accountId).toBe("a-03");
    expect(entries.map((e) => e.accountId)).toContain("a-02");
  });

  it("comes back round to the skipped ones rather than declaring the queue done", () => {
    const entries = q();
    const skipped = new Set(["a-01", "a-02", "a-03"]);
    expect(pickNextForReview(entries, { after: "a-03", skipped })!.accountId).toBe("a-01");
  });

  it("wraps to the top when the last capture is the one just saved", () => {
    const entries = q();
    entries[2]!.needsReview = false;
    expect(pickNextForReview(entries, { after: "a-03" })!.accountId).toBe("a-01");
  });

  it("returns null only when nothing is left unreviewed", () => {
    const entries = q().map((e) => ({ ...e, needsReview: false }));
    expect(pickNextForReview(entries)).toBeNull();
  });
});

describe("unreviewedAccountIds", () => {
  it("flags exactly the captures nobody has written up", () => {
    const ids = unreviewedAccountIds([
      state("a-01"),
      state("a-02", { needs_review: false } as Partial<CaptureStateRow>),
    ]);
    expect([...ids]).toEqual(["a-01"]);
  });
});

describe("validateReviewFields", () => {
  const base = { name: "", company: "", phone: "", email: "", notes: "", leadSourceId: null };

  it("needs somebody to call the lead", () => {
    expect(validateReviewFields(base)).toBe("Add a name or a company.");
  });

  it("takes a name with no number — a voice note is not always a business card", () => {
    expect(validateReviewFields({ ...base, name: "Mark" })).toBeNull();
    expect(validateReviewFields({ ...base, company: "Falcon Marketing" })).toBeNull();
  });

  it("still refuses an email that is not one", () => {
    expect(validateReviewFields({ ...base, name: "Mark", email: "falcon.com" })).toMatch(/email/);
  });
});

describe("the placeholder a quick capture gets", () => {
  it("names itself by the time it was taken and is recognized as a placeholder", () => {
    const name = voiceCaptureName("2026-09-09T14:14:00.000Z");
    expect(name.startsWith("Voice note · ")).toBe(true);
    expect(isVoiceCaptureName(name)).toBe(true);
  });

  it("recognizes a card-only capture's placeholder too", () => {
    expect(isVoiceCaptureName("Card photo · Sep 9, 2:14 PM")).toBe(true);
  });

  it("does not mistake a real company for one", () => {
    expect(isVoiceCaptureName("Falcon Marketing")).toBe(false);
    expect(isVoiceCaptureName("Voice Notes Ltd")).toBe(false);
    expect(isVoiceCaptureName("Card Photo Studios")).toBe(false);
  });

  it("falls back rather than producing an Invalid Date on a broken timestamp", () => {
    expect(voiceCaptureName("not-a-date")).toBe("Voice note");
  });
});
