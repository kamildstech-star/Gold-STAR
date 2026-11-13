import { describe, expect, it } from "vitest";

import {
  SIGNATURE_STALE_DAYS,
  countWaitingSignatures,
  isSignatureFlowType,
  treatDocumentStatus,
  type DocumentSignatureFacts,
} from "./document-status";
import type { DocumentStatus } from "./documents";

const NOW = Date.parse("2026-09-02T12:00:00.000Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

/** A contract is a signature-flow type; a COI is not. */
const contract = (over: Partial<DocumentSignatureFacts> = {}): DocumentSignatureFacts => ({
  status: "sent",
  doc_type: "contract",
  sent_at: daysAgo(1),
  ...over,
});
const coi = (over: Partial<DocumentSignatureFacts> = {}): DocumentSignatureFacts => ({
  status: "active",
  doc_type: "coi",
  ...over,
});

const ALL_STATUSES: DocumentStatus[] = [
  "draft",
  "pending_signature",
  "sent",
  "viewed",
  "signed",
  "declined",
  "active",
  "expired",
  "void",
];

describe("treatDocumentStatus — every status on a signature-flow document", () => {
  const expected: Record<DocumentStatus, { key: string; waiting: boolean }> = {
    draft: { key: "draft", waiting: false },
    pending_signature: { key: "unsigned", waiting: true },
    sent: { key: "unsigned", waiting: true },
    viewed: { key: "opened", waiting: true },
    signed: { key: "signed", waiting: false },
    declined: { key: "declined", waiting: false },
    active: { key: "active", waiting: false },
    expired: { key: "expired", waiting: false },
    void: { key: "void", waiting: false },
  };

  for (const status of ALL_STATUSES) {
    it(`maps ${status}`, () => {
      const t = treatDocumentStatus(contract({ status }), NOW);
      expect(t.key).toBe(expected[status].key);
      expect(t.waiting).toBe(expected[status].waiting);
      // Colour is never the only carrier of the state.
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
      expect(t.icon).toBeTruthy();
    });
  }

  it("gives each distinct state its own word, so color is never load-bearing", () => {
    const byKey = new Map<string, string>();
    for (const status of ALL_STATUSES) {
      const t = treatDocumentStatus(contract({ status }), NOW);
      byKey.set(t.key, t.label);
    }
    expect(new Set(byKey.values()).size).toBe(byKey.size);
  });
});

describe("treatDocumentStatus — a non-signature document is never overdue", () => {
  it("leaves an active COI alone", () => {
    const t = treatDocumentStatus(coi(), NOW);
    expect(t.key).toBe("active");
    expect(t.waiting).toBe(false);
    expect(t.className).not.toContain("destructive");
  });

  it("reads a sent COI as delivered, not unsigned", () => {
    const t = treatDocumentStatus(coi({ status: "sent", sent_at: daysAgo(40) }), NOW);
    expect(t.key).toBe("delivered");
    expect(t.label).toBe("Sent");
    expect(t.waiting).toBe(false);
    expect(t.className).not.toContain("destructive");
  });

  it("reads an opened COI as opened, not chased", () => {
    const t = treatDocumentStatus(coi({ status: "viewed", first_viewed_at: daysAgo(3) }), NOW);
    expect(t.key).toBe("delivered");
    expect(t.label).toBe("Opened");
    expect(t.waiting).toBe(false);
  });

  it("still treats an explicit signature request on a COI as waiting", () => {
    // `pending_signature` is only written when a signature was actually asked
    // for, so it outranks the type.
    const t = treatDocumentStatus(coi({ status: "pending_signature", sent_at: daysAgo(2) }), NOW);
    expect(t.key).toBe("unsigned");
    expect(t.waiting).toBe(true);
  });

  it("never counts expired or void as waiting", () => {
    for (const status of ["expired", "void"] as DocumentStatus[]) {
      expect(treatDocumentStatus(coi({ status }), NOW).waiting).toBe(false);
      expect(treatDocumentStatus(contract({ status }), NOW).waiting).toBe(false);
    }
  });
});

describe("opened is derived from the timestamp, not the status", () => {
  // `documents.status` is never advanced to `viewed`; the signing route only
  // stamps `first_viewed_at`. Reading status alone would hide this state.
  it("promotes a sent document with first_viewed_at to opened", () => {
    const t = treatDocumentStatus(
      contract({ status: "sent", sent_at: daysAgo(4), first_viewed_at: daysAgo(3) }),
      NOW,
    );
    expect(t.key).toBe("opened");
    expect(t.label).toBe("Opened");
    expect(t.waiting).toBe(true);
    expect(t.className).toContain("warning");
  });

  it("keeps an unopened document red", () => {
    const t = treatDocumentStatus(
      contract({ status: "pending_signature", sent_at: daysAgo(2) }),
      NOW,
    );
    expect(t.label).toBe("Unsigned");
    expect(t.className).toContain("destructive");
  });
});

describe("age and escalation", () => {
  it("shows today for a document sent this morning", () => {
    expect(treatDocumentStatus(contract({ sent_at: daysAgo(0) }), NOW).age).toBe("today");
  });

  it("shows the day count", () => {
    expect(treatDocumentStatus(contract({ sent_at: daysAgo(3) }), NOW).age).toBe("3d");
  });

  it("escalates from a tint to a solid fill once it goes stale", () => {
    const fresh = treatDocumentStatus(
      contract({ sent_at: daysAgo(SIGNATURE_STALE_DAYS - 1) }),
      NOW,
    );
    const stale = treatDocumentStatus(contract({ sent_at: daysAgo(SIGNATURE_STALE_DAYS) }), NOW);
    expect(fresh.className).toContain("/15");
    expect(fresh.needsAttention).toBe(false);
    expect(stale.className).not.toContain("/15");
    expect(stale.needsAttention).toBe(true);
  });

  it("escalates a dead signing link whatever its age", () => {
    const t = treatDocumentStatus(contract({ sent_at: daysAgo(1), expires_at: daysAgo(0.5) }), NOW);
    expect(t.needsAttention).toBe(true);
    expect(t.description).toContain("signing link has expired");
  });

  it("reports reminders in the description", () => {
    expect(treatDocumentStatus(contract({ reminder_count: 2 }), NOW).description).toContain(
      "2 reminders sent",
    );
    expect(treatDocumentStatus(contract({ reminder_count: 0 }), NOW).description).toContain(
      "No reminder has been sent yet",
    );
  });

  it("falls back to created_at when the row has no sent_at", () => {
    const t = treatDocumentStatus(
      { status: "pending_signature", doc_type: "work_authorization", created_at: daysAgo(5) },
      NOW,
    );
    expect(t.age).toBe("5d");
    expect(t.description).toContain("Awaiting a signature for 5 days");
  });

  it("shows no age when nothing dates the request", () => {
    expect(
      treatDocumentStatus({ status: "pending_signature", doc_type: "contract" }, NOW).age,
    ).toBeNull();
  });
});

describe("declined never reads as still waiting", () => {
  it("is its own state, with the reason", () => {
    const t = treatDocumentStatus(
      contract({ status: "declined", declined_at: daysAgo(1), declined_reason: "Wrong address" }),
      NOW,
    );
    expect(t.key).toBe("declined");
    expect(t.waiting).toBe(false);
    expect(t.needsAttention).toBe(true);
    expect(t.description).toContain("Wrong address");
  });
});

describe("signature-flow types", () => {
  it("covers the agreements and nothing else", () => {
    for (const t of [
      "work_authorization",
      "service_agreement",
      "certificate_of_completion",
      "vendor_agreement",
      "direction_to_pay",
      "non_waiver",
      "contract",
    ] as const) {
      expect(isSignatureFlowType(t)).toBe(true);
    }
    for (const t of [
      "coi",
      "w9",
      "carrier_correspondence",
      "estimate",
      "invoice",
      "certificate",
      "photo_report",
      "job_report",
      "other",
    ] as const) {
      expect(isSignatureFlowType(t)).toBe(false);
    }
  });
});

describe("countWaitingSignatures", () => {
  it("counts only what is genuinely outstanding", () => {
    const docs: DocumentSignatureFacts[] = [
      contract({ status: "sent", sent_at: daysAgo(9) }),
      contract({ status: "viewed", first_viewed_at: daysAgo(1) }),
      contract({ status: "signed" }),
      contract({ status: "declined" }),
      contract({ status: "draft" }),
      coi({ status: "active" }),
      coi({ status: "sent", sent_at: daysAgo(30) }),
    ];
    expect(countWaitingSignatures(docs, NOW)).toBe(2);
  });
});
