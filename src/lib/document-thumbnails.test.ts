import { describe, expect, it } from "vitest";

import {
  IMAGE_THUMB_MAX_BYTES,
  PDF_THUMB_MAX_BYTES,
  THUMB_MAX_EDGE,
  documentTypeCaption,
  fitWithin,
  isAlreadyStored,
  thumbnailSource,
  thumbnailUrl,
} from "./document-thumbnails";
import { documentFileUrl, documentThumbPath } from "./documents";

const ID = "0d40dca9-febf-424b-8379-a552b0cd6879";
const stored = (name: string, extra: Partial<Parameters<typeof thumbnailSource>[0]> = {}) => ({
  id: ID,
  name,
  storage_path: `loc/job/${name}`,
  ...extra,
});

describe("thumbnailSource", () => {
  it("draws an image from itself and a PDF from its first page", () => {
    expect(thumbnailSource(stored("kitchen.jpg"))).toBe("image");
    expect(thumbnailSource(stored("IMG_0042.HEIC"))).toBe("image");
    expect(thumbnailSource(stored("report.pdf"))).toBe("pdf");
  });

  it("reads the type from the filename when the stored mime is useless", () => {
    // The live photo report row: a dotless name, typed only by its mime.
    expect(
      thumbnailSource(stored("Photographs — GS-2026-09006 (2)", { mime: "application/pdf" })),
    ).toBe("pdf");
    expect(thumbnailSource(stored("scan.PDF", { mime: "application/octet-stream" }))).toBe("pdf");
  });

  it("gives a typed icon to everything with no picture in it", () => {
    expect(thumbnailSource(stored("LEVITTOWN Levittown~SApartments.ESX"))).toBeNull();
    expect(thumbnailSource(stored("Champion_Health_Care_Locations.xlsx"))).toBeNull();
    expect(thumbnailSource(stored("notes.txt"))).toBeNull();
    // SVG is live markup from an untrusted upload, never decoded as a picture.
    expect(thumbnailSource(stored("logo.svg"))).toBeNull();
  });

  it("never thumbnails a document with no stored file — a draft can still change", () => {
    expect(
      thumbnailSource({
        id: ID,
        name: "CONTRACT FOR SERVICES — GS-2026-09006",
        storage_path: null,
      }),
    ).toBeNull();
  });

  it("will not ask a phone to decode a file over the cap", () => {
    expect(thumbnailSource(stored("huge.jpg", { size_bytes: IMAGE_THUMB_MAX_BYTES }))).toBe(
      "image",
    );
    expect(
      thumbnailSource(stored("huge.jpg", { size_bytes: IMAGE_THUMB_MAX_BYTES + 1 })),
    ).toBeNull();
    expect(thumbnailSource(stored("huge.pdf", { size_bytes: PDF_THUMB_MAX_BYTES + 1 }))).toBeNull();
    // An unknown size is not a reason to refuse; the file route says no if it must.
    expect(thumbnailSource(stored("unsized.pdf", { size_bytes: null }))).toBe("pdf");
  });
});

describe("fitWithin", () => {
  it("scales the longest edge down to the cap and keeps the aspect", () => {
    // US Letter at 72dpi, the viewport pdf.js reports at scale 1.
    expect(fitWithin(612, 792, THUMB_MAX_EDGE)).toEqual({
      width: 396,
      height: 512,
      scale: 512 / 792,
    });
    expect(fitWithin(4032, 3024, 512)).toEqual({ width: 512, height: 384, scale: 512 / 4032 });
  });

  it("never enlarges a small picture", () => {
    expect(fitWithin(200, 100, 512)).toEqual({ width: 200, height: 100, scale: 1 });
  });

  it("survives a degenerate size", () => {
    expect(fitWithin(0, 0, 512)).toEqual({ width: 1, height: 1, scale: 1 });
  });
});

describe("documentTypeCaption", () => {
  it("names the kind in words, from the extension first", () => {
    expect(documentTypeCaption("LEVITTOWN Levittown~SApartments.ESX")).toBe("Xactimate estimate");
    expect(documentTypeCaption("Champion_Health_Care_Locations.xlsx")).toBe("Spreadsheet");
    expect(documentTypeCaption("rates.csv")).toBe("Spreadsheet");
    expect(documentTypeCaption("letter.docx")).toBe("Word document");
    expect(documentTypeCaption("site.zip")).toBe("Archive");
  });

  it("falls back to the mime, then the extension, then just File", () => {
    expect(documentTypeCaption("Photographs — GS-2026-09006 (2)", "application/pdf")).toBe("PDF");
    expect(documentTypeCaption("kitchen.jpg")).toBe("Image");
    expect(documentTypeCaption("plan.dwg")).toBe("DWG file");
    expect(documentTypeCaption("CONTRACT FOR SERVICES — GS-2026-09006")).toBe("File");
  });
});

describe("paths and urls", () => {
  it("keeps the thumbnail in the document's own sidecar namespace", () => {
    expect(documentThumbPath(ID)).toBe(`${ID}/thumb.webp`);
  });

  it("reads the thumbnail through the same file route as the document", () => {
    expect(thumbnailUrl(ID)).toBe(`/api/documents/${ID}/file?variant=thumb`);
    expect(documentFileUrl(ID)).toBe(`/api/documents/${ID}/file`);
    expect(documentFileUrl(ID, { download: true })).toBe(
      `/api/documents/${ID}/file?disposition=attachment`,
    );
  });
});

describe("isAlreadyStored", () => {
  it("treats a 409 or a duplicate message as the thumbnail already being there", () => {
    expect(isAlreadyStored({ statusCode: "409", message: "The resource already exists" })).toBe(
      true,
    );
    expect(isAlreadyStored({ status: 409 })).toBe(true);
    expect(isAlreadyStored({ message: "Duplicate" })).toBe(true);
  });

  it("does not swallow a real refusal", () => {
    expect(
      isAlreadyStored({ statusCode: "403", message: "new row violates row-level security" }),
    ).toBe(false);
    expect(isAlreadyStored(null)).toBe(false);
  });
});
