import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  PHOTO_STAMP_DEFAULTS,
  buildPhotoPdf,
  normalizePhotoStamps,
  photoCard,
  type PhotoPdfItem,
  type PhotoStamps,
} from "@/lib/photo-pdf";

/**
 * This file exists because a PDF builder that only satisfies the type checker
 * is a PDF builder nobody has opened. Every case below embeds real image bytes
 * — a genuine JPEG and the app's own PNGs — and reads the finished document
 * back with a parser, because "it compiled" and "the adjuster can open it" are
 * different claims.
 */

/** A real 1x1 baseline JPEG. Small, but a decoder accepts it as one. */
const JPEG_1X1 = Uint8Array.from(
  Buffer.from(
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a" +
      "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy" +
      "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA" +
      "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA" +
      "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3" +
      "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm" +
      "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA" +
      "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx" +
      "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK" +
      "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3" +
      "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD3+iii" +
      "gD//2Q==",
    "base64",
  ),
);

/** The parser's own answer to "does this open", not our opinion of the bytes. */
async function reopen(bytes: Uint8Array) {
  const { PDFDocument } = await import("pdf-lib");
  return PDFDocument.load(bytes);
}

/**
 * The words actually on the pages.
 *
 * Content streams come out Flate-compressed, so grepping the raw file for a
 * string finds nothing and an assertion that something is *absent* passes for
 * the wrong reason. Every case that checks what is or is not printed goes
 * through here, and `it("prints the job number")` is the control that proves
 * this reads real text.
 */
async function pageText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
    } catch {
      // An image stream. Not text, and not something to fail a text read over.
    }
  }
  // pdf-lib writes show-text operands as hex strings, so the words are only
  // readable once those are decoded back.
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
    (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join(""),
  );
}

function card(title: string | null, details: string[] = []) {
  return { title, details };
}

const BASE = {
  jobNumber: "GS-24-0912",
  address: "18 Ocean Parkway, Brooklyn NY",
  customerName: "R. Yadelman",
  preparedBy: "Field crew",
  preparedAtIso: "2026-09-02T14:30:00.000Z",
  perPage: 2 as const,
};

describe("stamp choices", () => {
  it("defaults to hiding coordinates, labels and staff names", () => {
    expect(PHOTO_STAMP_DEFAULTS).toEqual({
      caption: true,
      room: true,
      taken_at: true,
      gps: false,
      tags: false,
      uploader: false,
    });
  });

  it("resolves an unknown or absent key to its default, never to on", () => {
    expect(normalizePhotoStamps({ gps: "yes", nonsense: true })).toEqual(PHOTO_STAMP_DEFAULTS);
    expect(normalizePhotoStamps(null).gps).toBe(false);
    expect(normalizePhotoStamps(undefined).caption).toBe(true);
  });

  it("keeps an explicit false", () => {
    expect(normalizePhotoStamps({ caption: false, taken_at: false })).toMatchObject({
      caption: false,
      taken_at: false,
      room: true,
    });
  });
});

describe("what gets printed on a picture", () => {
  const src = {
    caption: "Ceiling collapse over the stairwell",
    room: "Upstairs hallway",
    takenAtIso: "2026-08-30T09:15:00.000Z",
    lat: 40.61234,
    lon: -73.97531,
    tags: ["Cat 3", "Reinspect"],
    uploader: "Danny Ortiz",
  };

  it("prints only what is switched on", () => {
    const all: PhotoStamps = {
      caption: true,
      room: true,
      taken_at: true,
      gps: true,
      tags: true,
      uploader: true,
    };
    const out = photoCard(src, all);
    expect(out.title).toBe(src.caption);
    expect(out.details.join(" ")).toContain("Upstairs hallway");
    expect(out.details.join(" ")).toContain("40.612340");
    expect(out.details.join(" ")).toContain("Danny Ortiz");
    expect(out.details.join(" ")).toContain("Cat 3");
  });

  it("leaks nothing when every switch is off", () => {
    const none = normalizePhotoStamps({
      caption: false,
      room: false,
      taken_at: false,
      gps: false,
      tags: false,
      uploader: false,
    });
    expect(photoCard(src, none)).toEqual({ title: null, details: [] });
  });

  it("omits coordinates under the default choices even though the photo has them", () => {
    const out = photoCard(src, PHOTO_STAMP_DEFAULTS);
    const printed = [out.title, ...out.details].join(" ");
    expect(printed).not.toContain("40.6");
    expect(printed).not.toContain("-73.9");
    expect(printed).not.toContain("Danny Ortiz");
    expect(printed).not.toContain("Cat 3");
  });

  it("drops a caption that is only whitespace rather than printing a blank line", () => {
    expect(photoCard({ ...src, caption: "   " }, PHOTO_STAMP_DEFAULTS).title).toBeNull();
  });

  it("survives a photo with no metadata at all", () => {
    const bare = {
      caption: null,
      room: null,
      takenAtIso: null,
      lat: null,
      lon: null,
      tags: [],
      uploader: null,
    };
    expect(photoCard(bare, PHOTO_STAMP_DEFAULTS)).toEqual({ title: null, details: [] });
  });

  it("ignores an unparseable capture date instead of printing Invalid Date", () => {
    const out = photoCard({ ...src, takenAtIso: "not a date" }, PHOTO_STAMP_DEFAULTS);
    expect(out.details.join(" ")).not.toMatch(/invalid/i);
  });
});

describe("the generated PDF", () => {
  it("opens, and holds one page per two photographs", async () => {
    const items: PhotoPdfItem[] = Array.from({ length: 5 }, (_, i) => ({
      bytes: JPEG_1X1,
      width: 1600,
      height: 1200,
      card: card(`Photograph ${i + 1}`, ["Kitchen", "30 August 2026"]),
    }));

    const bytes = await buildPhotoPdf({ ...BASE, items, skipped: [] });

    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await reopen(bytes);
    // Five pictures, two to a page, plus the cover block sharing page one.
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getTitle()).toContain("GS-24-0912");
  });

  it("embeds PNG bytes as well as JPEG, so a screenshot is not refused", async () => {
    const png = new Uint8Array(await readFile("public/gold-star-logo.png"));
    const bytes = await buildPhotoPdf({
      ...BASE,
      perPage: 1,
      items: [
        { bytes: png, width: 1200, height: 1200, card: card("Moisture map") },
        { bytes: JPEG_1X1, width: 1600, height: 1200, card: card("Living room") },
      ],
      skipped: [],
    });
    const doc = await reopen(bytes);
    expect(doc.getPageCount()).toBe(2);
    // DCTDecode is the JPEG filter, so the JPEG went in as a JPEG. The image
    // XObject count is three rather than two because the PNG has an alpha
    // channel and pdf-lib writes its soft mask as an image of its own.
    const body = new TextDecoder("latin1").decode(bytes);
    expect(body.match(/DCTDecode/g)).toHaveLength(1);
    expect((body.match(/\/Subtype \/Image/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(await pageText(bytes)).toContain("Moisture map");
  });

  it("prints the photographs it could not include, by name", async () => {
    const bytes = await buildPhotoPdf({
      ...BASE,
      items: [{ bytes: JPEG_1X1, width: 1600, height: 1200, card: card("Front elevation") }],
      skipped: [
        { name: "IMG_4417.HEIC", reason: "This browser cannot open HEIC photos." },
        { name: "IMG_4418.HEIC", reason: "This browser cannot open HEIC photos." },
      ],
    });
    const doc = await reopen(bytes);
    // The cover page, then a page that says what is missing from it.
    expect(doc.getPageCount()).toBe(2);
    const text = await pageText(bytes);
    expect(text).toContain("NOT INCLUDED IN THIS PDF");
    expect(text).toContain("IMG_4417.HEIC");
    expect(text).toContain("IMG_4418.HEIC");
  });

  it("refuses bytes it cannot embed instead of writing a broken page", async () => {
    await expect(
      buildPhotoPdf({
        ...BASE,
        items: [
          {
            bytes: new Uint8Array([0x52, 0x49, 0x46, 0x46]),
            width: 100,
            height: 100,
            card: card("webp"),
          },
        ],
        skipped: [],
      }),
    ).rejects.toThrow(/JPEG and PNG/);
  });

  it("accepts a view onto a larger buffer, which is how Node hands over a file", async () => {
    // pdf-lib reads from `bytes.buffer` and ignores the view's offset, so a
    // Buffer sliced out of a pool parses from the wrong bytes unless copied.
    const pool = new Uint8Array(JPEG_1X1.byteLength + 64);
    pool.set(JPEG_1X1, 64);
    const view = pool.subarray(64);
    const bytes = await buildPhotoPdf({
      ...BASE,
      items: [{ bytes: view, width: 1600, height: 1200, card: card("Offset view") }],
      skipped: [],
    });
    expect((await reopen(bytes)).getPageCount()).toBe(1);
  });

  it("does not print a caption the sender switched off", async () => {
    const secret = "ZZQQXX-crew-name-that-must-not-appear";
    const bytes = await buildPhotoPdf({
      ...BASE,
      items: [
        {
          bytes: JPEG_1X1,
          width: 1600,
          height: 1200,
          card: photoCard(
            {
              caption: secret,
              room: null,
              takenAtIso: null,
              lat: 40.1,
              lon: -73.1,
              tags: [],
              uploader: secret,
            },
            normalizePhotoStamps({ caption: false }),
          ),
        },
      ],
      skipped: [],
    });
    const text = await pageText(bytes);
    // The control: this read really does see the page text.
    expect(text).toContain("GS-24-0912");
    expect(text).not.toContain(secret);
  });
});
