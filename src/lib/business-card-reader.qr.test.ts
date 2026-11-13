/**
 * The QR half of `readCard`, end to end and for real: the MFO Summit vCard
 * Mark scanned is encoded into a PNG, the PNG goes in as the card photo, and
 * the pixels come back out as fields through `decodeQrFromPhoto` (jsqr) and
 * the one badge parser. No network, no model — this is the half that works
 * in a hall with no signal.
 *
 * Node has no canvas, so the two browser calls `decodeQrFromPhoto` makes are
 * stood in for with a PNG decoder: `createImageBitmap` reads the file's
 * pixels, and `OffscreenCanvas` hands them straight back from `getImageData`.
 * The QR is drawn at its natural size, below the 1600px cap, so the canvas
 * copy is 1:1 and nothing is resampled. jsqr itself is the real thing.
 *
 * The text half (`readBusinessCard`, Gemini through the Lovable gateway) is
 * not run here: it needs `LOVABLE_API_KEY` and spends the per-user budget.
 * It is mocked in `business-card-reader.test.ts` instead.
 */
import { PNG } from "pngjs";
import QRCode from "qrcode";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { readCard } from "@/lib/business-card-reader";

/** MFO Summit — verbatim, as the badge encodes it. */
const MFO_SUMMIT = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "N;CHARSET=utf-8:Lesser;Elly;;;",
  "FN;CHARSET=utf-8:Elly Lesser",
  "ORG;CHARSET=utf-8:Fairmont Insurance Brokers",
  "EMAIL;INTERNET:elesser@fairmontins.com",
  "TEL;WORK,VOICE:+1 718-906-0452",
  "ADR;WORK;POSTAL;CHARSET=utf-8:;;;;;;",
  "END:VCARD",
].join("\r\n");

/** ARRA / PowWow Events — the attendee id. */
const POWWOW = "H3NHH2Q4M5H";

type Bitmap = { width: number; height: number; data: Uint8ClampedArray; close(): void };

async function qrPng(text: string): Promise<Blob> {
  const buf = await QRCode.toBuffer(text, { type: "png", scale: 6, margin: 4 });
  return new Blob([new Uint8Array(buf)], { type: "image/png" });
}

beforeAll(() => {
  vi.stubGlobal("createImageBitmap", async (blob: Blob): Promise<Bitmap> => {
    const png = PNG.sync.read(Buffer.from(await blob.arrayBuffer()));
    return {
      width: png.width,
      height: png.height,
      data: new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength),
      close() {},
    };
  });
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      private drawn: Bitmap | null = null;
      constructor(
        public width: number,
        public height: number,
      ) {}
      getContext() {
        return {
          drawImage: (bitmap: Bitmap, _x: number, _y: number, w: number, h: number) => {
            if (w !== bitmap.width || h !== bitmap.height) {
              throw new Error("this stand-in canvas does not resample");
            }
            this.drawn = bitmap;
          },
          getImageData: (_x: number, _y: number, w: number, h: number) => ({
            width: w,
            height: h,
            data: this.drawn!.data,
          }),
        };
      }
    },
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("readCard on a PNG of the QR code, for real", () => {
  it("reads the MFO Summit vCard off the pixels into normalized fields", async () => {
    const read = await readCard(await qrPng(MFO_SUMMIT), { ocr: false });
    expect(read.source).toBe("qr");
    expect(read.fields).toEqual({
      name: "Elly Lesser",
      company: "Fairmont Insurance Brokers",
      title: null,
      email: "elesser@fairmontins.com",
      phone: "(718) 906-0452",
      website: null,
      address: null,
    });
    expect(read.raw.qr).toBe(MFO_SUMMIT);
    expect(read.confidence).toBe("high");
    expect(read.uncertain).toEqual([]);
    expect(read.pending).toBe(false);
  });

  it("offline, the same photo gives the same fields and waits for the text pass", async () => {
    const read = await readCard(await qrPng(MFO_SUMMIT), { offline: true });
    expect(read.source).toBe("qr");
    expect(read.fields.name).toBe("Elly Lesser");
    expect(read.fields.phone).toBe("(718) 906-0452");
    expect(read.pending).toBe(true);
  });

  it("keeps the PowWow attendee id verbatim and invents no fields from it", async () => {
    const read = await readCard(await qrPng(POWWOW), { ocr: false });
    expect(read.source).toBe("none");
    expect(read.raw.qr).toBe(POWWOW);
    expect(Object.values(read.fields).every((v) => v === null)).toBe(true);
    expect(read.confidence).toBe("low");
  });

  it("a photo with no code in it has no QR half", async () => {
    const png = new PNG({ width: 120, height: 80 });
    png.data.fill(200);
    const blob = new Blob([new Uint8Array(PNG.sync.write(png))], { type: "image/png" });
    const read = await readCard(blob, { ocr: false });
    expect(read.source).toBe("none");
    expect(read.raw.qr).toBeUndefined();
  });
});
