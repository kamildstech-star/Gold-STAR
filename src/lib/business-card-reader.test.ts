import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { emptyFields, type CardRead } from "./business-card";

/* ------------------------------------------------------------------ */
/* Mocks: no camera, no canvas, no gateway in a unit test              */
/* ------------------------------------------------------------------ */

const decodeQrFromPhoto = vi.fn<(b: Blob) => Promise<string | null>>();
const cardImageDataUrl = vi.fn<(b: Blob) => Promise<string | null>>();
const readBusinessCard = vi.fn();

vi.mock("./business-card-photo", () => ({
  decodeQrFromPhoto: (b: Blob) => decodeQrFromPhoto(b),
  cardImageDataUrl: (b: Blob) => cardImageDataUrl(b),
}));
vi.mock("./business-card.functions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./business-card.functions")>()),
  readBusinessCard: (arg: unknown) => readBusinessCard(arg),
}));

const { readCard, fillLeadFromCard, qrReadPart } = await import("./business-card-reader");

const VCARD =
  "BEGIN:VCARD\nVERSION:3.0\nN:Lesser;Elly;;;\nFN:Elly Lesser\nORG:Fairmont Insurance Brokers\nEMAIL;INTERNET:elesser@fairmontins.com\nTEL;WORK,VOICE:+1 718-906-0452\nEND:VCARD";

const photo = new Blob(["not really an image"], { type: "image/webp" });

function ocrOk(fields: Partial<CardRead["fields"]>, uncertain: string[] = []) {
  return {
    ok: true,
    fields: { ...emptyFields(), ...fields },
    confidence: "high",
    uncertain,
    ocrText: "printed text",
  };
}

beforeEach(() => {
  decodeQrFromPhoto.mockReset();
  cardImageDataUrl.mockReset();
  readBusinessCard.mockReset();
  decodeQrFromPhoto.mockResolvedValue(null);
  cardImageDataUrl.mockResolvedValue("data:image/webp;base64,AAAA");
});

/* ------------------------------------------------------------------ */
/* readCard                                                            */
/* ------------------------------------------------------------------ */

describe("readCard", () => {
  it("with a QR in the photo and OCR online: QR fields win, OCR fills the rest", async () => {
    decodeQrFromPhoto.mockResolvedValue(VCARD);
    readBusinessCard.mockResolvedValue(
      ocrOk({
        name: "Elly Lessor",
        title: "Account Executive",
        website: "https://fairmontins.com",
      }),
    );

    const read = await readCard(photo, { offline: false });

    expect(read.source).toBe("both");
    expect(read.fields.name).toBe("Elly Lesser");
    expect(read.fields.phone).toBe("(718) 906-0452");
    expect(read.fields.title).toBe("Account Executive");
    expect(read.fields.website).toBe("https://fairmontins.com");
    expect(read.raw.qr).toBe(VCARD);
    expect(read.raw.ocrText).toBe("printed text");
    expect(read.pending).toBe(false);
    expect(readBusinessCard).toHaveBeenCalledWith({
      data: { image_data_url: "data:image/webp;base64,AAAA" },
    });
  });

  it("a code the live scanner already read is used and the photo is not searched", async () => {
    readBusinessCard.mockResolvedValue(ocrOk({}));
    const read = await readCard(photo, { qrRaw: VCARD, offline: false });
    expect(decodeQrFromPhoto).not.toHaveBeenCalled();
    expect(read.source).toBe("qr");
    expect(read.fields.email).toBe("elesser@fairmontins.com");
  });

  it("offline: the QR half runs, the OCR half is pending, and nothing goes over the wire", async () => {
    decodeQrFromPhoto.mockResolvedValue(VCARD);
    const read = await readCard(photo, { offline: true });
    expect(read.source).toBe("qr");
    expect(read.pending).toBe(true);
    expect(read.fields.name).toBe("Elly Lesser");
    expect(cardImageDataUrl).not.toHaveBeenCalled();
    expect(readBusinessCard).not.toHaveBeenCalled();
  });

  it("offline with no code: nothing read, pending for the queue", async () => {
    const read = await readCard(photo, { offline: true });
    expect(read.source).toBe("none");
    expect(read.pending).toBe(true);
    expect(read.raw).toEqual({});
  });

  it("ocr: false skips the model and is not pending", async () => {
    const read = await readCard(photo, { ocr: false, offline: false });
    expect(read.pending).toBe(false);
    expect(readBusinessCard).not.toHaveBeenCalled();
  });

  it("a card with no code and a good OCR read is 'ocr'", async () => {
    readBusinessCard.mockResolvedValue(
      ocrOk({ name: "Elly Lesser", phone: "(718) 906-0452" }, ["phone"]),
    );
    const read = await readCard(photo, { offline: false });
    expect(read.source).toBe("ocr");
    expect(read.uncertain).toEqual(["phone"]);
    expect(read.raw.qr).toBeUndefined();
  });

  it("a retryable server refusal (budget, gateway down) leaves the read pending", async () => {
    readBusinessCard.mockResolvedValue({ ok: false, retryable: true, error: "wait" });
    const read = await readCard(photo, { offline: false });
    expect(read.source).toBe("none");
    expect(read.pending).toBe(true);
  });

  it("a non-retryable refusal (the model returned prose) is final", async () => {
    readBusinessCard.mockResolvedValue({ ok: false, retryable: false, error: "could not read" });
    const read = await readCard(photo, { offline: false });
    expect(read.pending).toBe(false);
  });

  it("a request that never reaches the server is pending", async () => {
    readBusinessCard.mockRejectedValue(new TypeError("Failed to fetch"));
    const read = await readCard(photo, { offline: false });
    expect(read.pending).toBe(true);
  });

  it("a photo the browser cannot shrink is not sent and not pending", async () => {
    cardImageDataUrl.mockResolvedValue(null);
    const read = await readCard(photo, { offline: false });
    expect(readBusinessCard).not.toHaveBeenCalled();
    expect(read.pending).toBe(false);
  });

  it("the QR read is not undone by a server refusal", async () => {
    decodeQrFromPhoto.mockResolvedValue("https://www.linkedin.com/in/ellylesser");
    readBusinessCard.mockResolvedValue({ ok: false, retryable: true, error: "wait" });
    const read = await readCard(photo, { offline: false });
    expect(read.fields.website).toBe("https://www.linkedin.com/in/ellylesser");
    expect(read.pending).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* qrReadPart — the one badge parser, normalised like the OCR half     */
/* ------------------------------------------------------------------ */

describe("qrReadPart", () => {
  it("normalizes the vCard's fields the same way the OCR half is", () => {
    const part = qrReadPart(VCARD)!;
    expect(part.fields.name).toBe("Elly Lesser");
    expect(part.fields.phone).toBe("(718) 906-0452");
    expect(part.fields.email).toBe("elesser@fairmontins.com");
    expect(part.fields.title).toBeNull();
    expect(part.confidence).toBe("high");
    expect(part.uncertain).toEqual([]);
    expect(part.raw).toBe(VCARD);
  });

  it("flags a field the code carried but the normalizer refused", () => {
    const part = qrReadPart("BEGIN:VCARD\nFN:E L\nEMAIL:not-an-email\nEND:VCARD")!;
    expect(part.fields.email).toBeNull();
    expect(part.uncertain).toEqual(["email"]);
    expect(part.confidence).toBe("medium");
  });

  it("keeps a bare URL as the website, at medium confidence", () => {
    const part = qrReadPart("https://www.linkedin.com/in/ellylesser")!;
    expect(part.fields.website).toBe("https://www.linkedin.com/in/ellylesser");
    expect(part.fields.name).toBeNull();
    expect(part.confidence).toBe("medium");
  });

  it("is low confidence with no fields for a badge number", () => {
    const part = qrReadPart("H3NHH2Q4M5H")!;
    expect(Object.values(part.fields).every((v) => v === null)).toBe(true);
    expect(part.confidence).toBe("low");
    expect(part.raw).toBe("H3NHH2Q4M5H");
  });

  it("is null for an empty payload", () => {
    expect(qrReadPart("")).toBeNull();
    expect(qrReadPart("   ")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* fillLeadFromCard                                                    */
/* ------------------------------------------------------------------ */

function read(fields: Partial<CardRead["fields"]>): CardRead {
  return {
    source: "ocr",
    fields: { ...emptyFields(), ...fields },
    raw: {},
    confidence: "high",
    uncertain: [],
    pending: false,
  };
}

describe("fillLeadFromCard", () => {
  const blank = { name: "", company: "", phone: "", email: "", notes: "" };

  it("fills empty typed fields and puts the rest in notes", () => {
    const { details, filled } = fillLeadFromCard(
      blank,
      read({
        name: "Elly Lesser",
        company: "Fairmont Insurance Brokers",
        phone: "(718) 906-0452",
        email: "elesser@fairmontins.com",
        title: "Account Executive",
        website: "https://fairmontins.com",
      }),
    );
    expect(details).toEqual({
      name: "Elly Lesser",
      company: "Fairmont Insurance Brokers",
      phone: "(718) 906-0452",
      email: "elesser@fairmontins.com",
      notes: "Account Executive\nhttps://fairmontins.com",
    });
    expect(filled).toEqual(["name", "company", "phone", "email", "title", "website"]);
  });

  it("never overwrites what the rep typed", () => {
    const { details, filled } = fillLeadFromCard(
      { ...blank, name: "Elly L.", notes: "met at booth 12" },
      read({ name: "Elly Lesser", phone: "(718) 906-0452" }),
    );
    expect(details.name).toBe("Elly L.");
    expect(details.phone).toBe("(718) 906-0452");
    expect(details.notes).toBe("met at booth 12");
    expect(filled).toEqual(["phone"]);
  });

  it("does not add a note line that is already there", () => {
    const { details, filled } = fillLeadFromCard(
      { ...blank, notes: "Account Executive" },
      read({ title: "Account Executive" }),
    );
    expect(details.notes).toBe("Account Executive");
    expect(filled).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The server function's guards, asserted on its source               */
/* ------------------------------------------------------------------ */

const SOURCE = readFileSync(join(__dirname, "business-card.functions.ts"), "utf8").replace(
  /\r\n/g,
  "\n",
);

describe("readBusinessCard server function", () => {
  it("is authenticated", () => {
    const chain = SOURCE.match(
      /createServerFn\(\{ method: "POST" \}\)\s*\.middleware\(\[([^\]]*)\]\)/,
    );
    expect(chain?.[1]).toContain("requireSupabaseAuth");
  });

  it("spends the per-user budget, keyed by user id, failing closed", () => {
    const call = SOURCE.match(
      /consumeLimit\(\s*"([^"]+)",\s*([^,]+),\s*RATE_LIMITS\.(\w+),\s*"(\w+)"/,
    );
    expect(call?.[1]).toBe("business-card-read");
    expect(call?.[2]).toBe("context.userId");
    expect(call?.[3]).toBe("businessCardRead");
    expect(call?.[4]).toBe("closed");
  });

  it("checks the budget before the gateway is imported", () => {
    expect(SOURCE.indexOf("consumeLimit(")).toBeLessThan(SOURCE.indexOf('import("./ai.server")'));
  });

  it("runs the reply through the validator and never returns it raw", () => {
    expect(SOURCE).toMatch(/parseCardModelOutput\(raw\)/);
    const returned = SOURCE.match(/return \{\s*ok: true,([\s\S]*?)\};/);
    expect(returned?.[1]).toContain("parsed.fields");
    expect(returned?.[1]).not.toContain("raw");
  });
});

describe("readBusinessCardInput", () => {
  it("accepts a small WebP data URL and refuses the rest", async () => {
    const { readBusinessCardInput } = await import("./business-card.functions");
    const b64 = "A".repeat(80);
    expect(
      readBusinessCardInput.safeParse({ image_data_url: `data:image/webp;base64,${b64}` }).success,
    ).toBe(true);
    expect(
      readBusinessCardInput.safeParse({ image_data_url: `data:image/jpeg;base64,${b64}==` })
        .success,
    ).toBe(true);
    expect(
      readBusinessCardInput.safeParse({ image_data_url: `data:image/gif;base64,${b64}` }).success,
    ).toBe(false);
    expect(
      readBusinessCardInput.safeParse({ image_data_url: `data:text/html;base64,${b64}` }).success,
    ).toBe(false);
    expect(
      readBusinessCardInput.safeParse({ image_data_url: `https://example.com/card.png` }).success,
    ).toBe(false);
    expect(
      readBusinessCardInput.safeParse({
        image_data_url: `data:image/png;base64,${"A".repeat(5 * 1024 * 1024)}`,
      }).success,
    ).toBe(false);
  });
});
