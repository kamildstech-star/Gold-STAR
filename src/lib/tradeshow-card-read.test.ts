/**
 * The booth sequence, run without a DOM: photo, read in flight, typing, a
 * badge, Save before the read is back. `readCard` is injected as a promise
 * the test controls, so "the fields arrive after Save" is literally that.
 */
import { describe, expect, it, vi } from "vitest";

import { emptyFields, type CardRead } from "@/lib/business-card";
import { fillLeadFromCard } from "@/lib/business-card-reader";
import {
  CARD_READ_TEXT,
  applyBadgeFields,
  applyCardRead,
  badgeRawToStore,
  cardReadLabel,
  cardReadOutcome,
  cardReadSummary,
  editDetails,
  startCardRead,
  takeBackFields,
  type CardReadState,
  type FieldState,
} from "@/lib/tradeshow-card-read";
import { EMPTY_LEAD_DETAILS } from "@/lib/tradeshow-capture";

const photo = new Blob(["card"], { type: "image/webp" });

const EMPTY: FieldState = { details: EMPTY_LEAD_DETAILS, filledBy: {}, uncertain: {} };

function aRead(
  over: Partial<Omit<CardRead, "fields">> & { fields?: Partial<CardRead["fields"]> } = {},
): CardRead {
  return {
    source: "ocr",
    confidence: "high",
    uncertain: [],
    pending: false,
    raw: {},
    ...over,
    fields: { ...emptyFields(), ...(over.fields ?? {}) },
  };
}

const FAIRMONT = aRead({
  source: "both",
  raw: { qr: "BEGIN:VCARD\nFN:Elly Lesser\nEND:VCARD", ocrText: "Elly Lesser" },
  fields: {
    name: "Elly Lesser",
    company: "Fairmont Insurance Brokers",
    phone: "(718) 906-0452",
    email: "elesser@fairmontins.com",
    title: "Account Executive",
  },
  uncertain: ["phone"],
});

const BADGE = {
  name: "Elly Lesser",
  company: "Fairmont Insurance",
  title: "",
  email: "elly@fairmont.example",
  phone: "+1 718-906-0452",
  website: "",
  address: "",
};

/** A reader the test settles by hand. */
function deferredReader() {
  let resolve!: (r: CardRead) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<CardRead>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const reader = vi.fn(() => promise);
  return { reader, resolve, reject };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/* ------------------------------------------------------------------ */
/* The sequence                                                        */
/* ------------------------------------------------------------------ */

describe("a read that comes back before Save", () => {
  it("fills the empty fields, marks them from the card, flags the uncertain one, leaves typing alone", async () => {
    const { reader, resolve } = deferredReader();
    let state: FieldState = { ...EMPTY, details: { ...EMPTY_LEAD_DETAILS, name: "Elly L." } };
    const outcomes: CardReadState[] = [];

    startCardRead(photo, {
      offline: false,
      reader,
      stillWanted: () => true,
      onOutcome: (outcome, read) => {
        outcomes.push(outcome);
        if (read) state = applyCardRead(state, read);
      },
    });
    expect(reader).toHaveBeenCalledWith(photo, { offline: false });
    expect(outcomes).toEqual([]);

    resolve(FAIRMONT);
    await tick();

    expect(outcomes).toEqual([{ status: "read", read: FAIRMONT }]);
    expect(state.details).toEqual({
      name: "Elly L.",
      company: "Fairmont Insurance Brokers",
      phone: "(718) 906-0452",
      email: "elesser@fairmontins.com",
      notes: "Account Executive",
    });
    expect(state.filledBy).toEqual({
      company: "card",
      phone: "card",
      email: "card",
      notes: "card",
    });
    expect(state.uncertain).toEqual({ phone: true });
    expect(cardReadLabel(outcomes[0]!)).toBe(
      "Read off the card: Elly Lesser · Fairmont Insurance Brokers · (718) 906-0452. Check the marked fields.",
    );
  });
});

describe("a read that comes back after Save", () => {
  it("never lands on the next person's form; Save's handle gets it for the saved lead", async () => {
    const { reader, resolve } = deferredReader();
    let screen: FieldState = EMPTY;
    let wanted = true;
    const onOutcome = vi.fn();

    const inflight = startCardRead(photo, {
      offline: false,
      reader,
      stillWanted: () => wanted,
      onOutcome,
    });

    // The rep types a company and presses Save with the read still out.
    screen = { ...screen, details: { ...screen.details, company: "Fairmont (typed)" } };
    const saved = { ...screen.details };
    wanted = false; // Save cleared the screen for the next person
    screen = EMPTY;

    resolve(FAIRMONT);
    const read = await inflight.promise;

    expect(onOutcome).not.toHaveBeenCalled();
    expect(screen).toEqual(EMPTY);
    // What `applyLateCardRead` writes onto the saved lead: only its empties.
    const { details, filled } = fillLeadFromCard(saved, read!);
    expect(details.company).toBe("Fairmont (typed)");
    expect(details.name).toBe("Elly Lesser");
    expect(details.phone).toBe("(718) 906-0452");
    expect(filled).toEqual(["name", "phone", "email", "title"]);
  });

  it("a read that failed after Save gives Save nothing to write", async () => {
    const { reader, reject } = deferredReader();
    const inflight = startCardRead(photo, {
      offline: false,
      reader,
      stillWanted: () => false,
      onOutcome: vi.fn(),
    });
    reject(new TypeError("Failed to fetch"));
    await expect(inflight.promise).resolves.toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Precedence: typed > badge > card                                    */
/* ------------------------------------------------------------------ */

describe("who wins a field", () => {
  it("the badge overwrites what the card read, but not what was typed", () => {
    let state: FieldState = { ...EMPTY, details: { ...EMPTY_LEAD_DETAILS, company: "Typed Co" } };
    state = applyCardRead(state, FAIRMONT);
    expect(state.details.phone).toBe("(718) 906-0452");
    expect(state.uncertain).toEqual({ phone: true });

    state = applyBadgeFields(state, BADGE);
    expect(state.details).toEqual({
      name: "Elly Lesser",
      company: "Typed Co",
      phone: "+1 718-906-0452",
      email: "elly@fairmont.example",
      notes: "Account Executive",
    });
    expect(state.filledBy).toEqual({
      name: "badge",
      phone: "badge",
      email: "badge",
      notes: "card",
    });
    // The badge's number is exact; the card's doubt about its own is gone with it.
    expect(state.uncertain).toEqual({});
  });

  it("the card never touches a field the badge filled", () => {
    let state = applyBadgeFields(EMPTY, BADGE);
    state = applyCardRead(state, FAIRMONT);
    expect(state.details.company).toBe("Fairmont Insurance");
    expect(state.details.phone).toBe("+1 718-906-0452");
    expect(state.filledBy).toEqual({
      name: "badge",
      company: "badge",
      phone: "badge",
      email: "badge",
      notes: "card",
    });
    expect(state.uncertain).toEqual({});
  });

  it("a blank the card flagged is marked too, so the rep glances at the card for it", () => {
    const read = aRead({ fields: { name: "Elly Lesser" }, uncertain: ["email"] });
    const state = applyCardRead(EMPTY, read);
    expect(state.details.email).toBe("");
    expect(state.uncertain).toEqual({ email: true });
  });
});

describe("typing over a filled field", () => {
  it("makes it the rep's: the mark and the doubt go, and a badge scanned after leaves it alone", () => {
    let state = applyCardRead(EMPTY, FAIRMONT);
    state = editDetails(state, { ...state.details, phone: "(718) 906-0453" });
    expect(state.filledBy.phone).toBeUndefined();
    expect(state.uncertain).toEqual({});
    expect(state.filledBy.email).toBe("card");
    state = applyBadgeFields(state, BADGE);
    expect(state.details.phone).toBe("(718) 906-0453");
    expect(state.details.email).toBe("elly@fairmont.example");
  });
});

describe("taking a source back", () => {
  it("removing the photo empties the card's fields and no others; notes stay", () => {
    let state: FieldState = { ...EMPTY, details: { ...EMPTY_LEAD_DETAILS, company: "Typed Co" } };
    state = applyCardRead(state, FAIRMONT);
    state = applyBadgeFields(state, { ...BADGE, name: "", phone: "", company: "" });
    state = takeBackFields(state, "card");
    expect(state.details).toEqual({
      name: "",
      company: "Typed Co",
      phone: "",
      email: "elly@fairmont.example",
      notes: "Account Executive",
    });
    expect(state.filledBy).toEqual({ email: "badge" });
    expect(state.uncertain).toEqual({});
  });
});

/* ------------------------------------------------------------------ */
/* Offline and failure                                                 */
/* ------------------------------------------------------------------ */

describe("offline", () => {
  it("is pending, says so, and the QR half's fields still land", async () => {
    const qrOnly = aRead({
      source: "qr",
      pending: true,
      raw: { qr: "BEGIN:VCARD\nFN:Elly Lesser\nEND:VCARD" },
      fields: { name: "Elly Lesser", company: "Fairmont Insurance Brokers" },
    });
    const reader = vi.fn(async () => qrOnly);
    let state = EMPTY;
    let outcome: CardReadState | null = null;
    startCardRead(photo, {
      offline: true,
      reader,
      stillWanted: () => true,
      onOutcome: (o, read) => {
        outcome = o;
        if (read) state = applyCardRead(state, read);
      },
    });
    await tick();
    expect(reader).toHaveBeenCalledWith(photo, { offline: true });
    expect(outcome).toEqual({ status: "pending", read: qrOnly });
    expect(cardReadLabel(outcome)).toBe(
      "Will read when online — its QR code gave Elly Lesser · Fairmont Insurance Brokers",
    );
    expect(state.details.name).toBe("Elly Lesser");
    expect(state.filledBy).toEqual({ name: "card", company: "card" });
  });

  it("with no code on the card, nothing else changes", () => {
    const none = aRead({ source: "none", pending: true });
    const outcome = cardReadOutcome(none, { offline: true });
    expect(outcome).toEqual({ status: "pending", read: none });
    expect(cardReadLabel(outcome)).toBe(CARD_READ_TEXT.pending);
    expect(applyCardRead(EMPTY, none)).toEqual(EMPTY);
  });
});

describe("failure", () => {
  it("a refused read online (budget spent, gateway down) is a failure, not a wait", () => {
    const refused = aRead({ source: "none", pending: true });
    const outcome = cardReadOutcome(refused, { offline: false });
    expect(outcome.status).toBe("failed");
    expect(cardReadLabel(outcome)).toBe("Couldn't read — write it up after the show");
  });

  it("a model that found nothing, and a reader that threw, read the same to the rep", async () => {
    expect(cardReadOutcome(aRead({ source: "none" }), { offline: false }).status).toBe("failed");
    const reader = vi.fn(async () => {
      throw new Error("boom");
    });
    const outcomes: CardReadState[] = [];
    const inflight = startCardRead(photo, {
      offline: false,
      reader,
      stillWanted: () => true,
      onOutcome: (o) => outcomes.push(o),
    });
    await expect(inflight.promise).resolves.toBeNull();
    expect(outcomes).toEqual([{ status: "failed", read: null }]);
  });

  it("the QR half of a refused read is not thrown away", () => {
    const partial = aRead({ source: "qr", pending: true, fields: { name: "Elly Lesser" } });
    const outcome = cardReadOutcome(partial, { offline: false });
    expect(outcome.status).toBe("read");
    expect(cardReadSummary(partial)).toBe("Elly Lesser");
  });
});

describe("what goes on the capture as badgeRaw", () => {
  it("is the badge if one was scanned, else the card's own code, else nothing", () => {
    expect(badgeRawToStore("H3NHH2Q4M5H", FAIRMONT)).toBe("H3NHH2Q4M5H");
    expect(badgeRawToStore(null, FAIRMONT)).toBe("BEGIN:VCARD\nFN:Elly Lesser\nEND:VCARD");
    expect(badgeRawToStore("  ", aRead())).toBeNull();
    expect(badgeRawToStore(null, null)).toBeNull();
  });
});
