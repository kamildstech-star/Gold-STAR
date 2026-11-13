import { afterEach, describe, expect, it, vi } from "vitest";

import { TICKET_FILE_MAX_BYTES, TICKET_IMAGE_MAX_EDGE } from "./field-ticket-extract";
import {
  TICKET_IMAGE_FALLBACK_EDGE,
  blobToDataUrl,
  canvasEncode,
  ticketFileDataUrl,
  type TicketImageEncoder,
} from "./field-ticket-photo";

const photo = (type: string, name = "ticket.jpg", bytes = 2048) =>
  new File([new Uint8Array(bytes)], name, { type });

/** An encoder that always hands back the given blob, and records what it was asked. */
function encoderReturning(...blobs: Blob[]) {
  const calls: Array<{ maxEdge: number; quality: number }> = [];
  const encode: TicketImageEncoder = async (_file, maxEdge, quality) => {
    calls.push({ maxEdge, quality });
    return blobs[Math.min(calls.length - 1, blobs.length - 1)]!;
  };
  return { encode, calls };
}

describe("ticketFileDataUrl — a picture", () => {
  it("sends the encoded picture under its own type", async () => {
    const { encode, calls } = encoderReturning(
      new Blob([new Uint8Array(500)], { type: "image/jpeg" }),
    );
    const out = await ticketFileDataUrl(photo("image/jpeg"), encode);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.mime).toBe("image/jpeg");
    expect(out.dataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(calls).toEqual([{ maxEdge: TICKET_IMAGE_MAX_EDGE, quality: 0.85 }]);
  });

  it("never labels a PNG as WebP — the label is what the bytes are", async () => {
    // The old path asked for WebP, got Safari's PNG fallback, and sent it as
    // "image/webp".
    const { encode } = encoderReturning(new Blob([new Uint8Array(500)], { type: "image/png" }));
    const out = await ticketFileDataUrl(photo("image/jpeg"), encode);
    expect(out.ok && out.mime).toBe("image/png");
    expect(out.ok && out.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("shrinks once more before calling a photo too big", async () => {
    const big = new Blob([new Uint8Array(TICKET_FILE_MAX_BYTES + 1)], { type: "image/jpeg" });
    const small = new Blob([new Uint8Array(1000)], { type: "image/jpeg" });
    const { encode, calls } = encoderReturning(big, small);
    const out = await ticketFileDataUrl(photo("image/jpeg"), encode);
    expect(out.ok).toBe(true);
    expect(calls.map((c) => c.maxEdge)).toEqual([
      TICKET_IMAGE_MAX_EDGE,
      TICKET_IMAGE_FALLBACK_EDGE,
    ]);
  });

  it("says too big, by name, when even the smaller one is over", async () => {
    const big = new Blob([new Uint8Array(TICKET_FILE_MAX_BYTES + 1)], { type: "image/jpeg" });
    const { encode } = encoderReturning(big);
    const out = await ticketFileDataUrl(photo("image/jpeg"), encode);
    expect(out).toMatchObject({ ok: false, reason: "file_too_big", mime: "image/jpeg" });
  });

  it("sends an undecodable JPEG as it came, since the model takes it as it is", async () => {
    const encode: TicketImageEncoder = async () => {
      throw new Error("no canvas");
    };
    const out = await ticketFileDataUrl(photo("image/jpeg"), encode);
    expect(out.ok && out.mime).toBe("image/jpeg");
  });

  it("calls a picture nothing here can open unusable, and says what it was", async () => {
    const encode: TicketImageEncoder = async () => {
      throw new Error("decode failed");
    };
    const out = await ticketFileDataUrl(photo("image/heic", "IMG_0042.HEIC"), encode);
    expect(out).toMatchObject({ ok: false, reason: "file_unusable", mime: "image/heic" });
  });

  it("refuses an encoder result the model would not take", async () => {
    const { encode } = encoderReturning(new Blob([new Uint8Array(10)], { type: "image/gif" }));
    const out = await ticketFileDataUrl(photo("image/jpeg"), encode);
    expect(out).toMatchObject({ ok: false, reason: "file_unusable" });
  });
});

describe("ticketFileDataUrl — a PDF", () => {
  it("is sent as it is, never through the canvas", async () => {
    const encode = vi.fn();
    const out = await ticketFileDataUrl(photo("application/pdf", "ticket.pdf"), encode);
    expect(encode).not.toHaveBeenCalled();
    expect(out.ok && out.mime).toBe("application/pdf");
  });

  it("is labeled a PDF even when the picker gave it no type", async () => {
    // FileReader would have written data:application/octet-stream, which the
    // server's schema refuses.
    const out = await ticketFileDataUrl(photo("", "Field ticket.PDF"));
    expect(out.ok && out.dataUrl.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  it("is too big over the cap, by name", async () => {
    const out = await ticketFileDataUrl(
      photo("application/pdf", "scan.pdf", TICKET_FILE_MAX_BYTES + 1),
    );
    expect(out).toMatchObject({ ok: false, reason: "file_too_big" });
  });
});

describe("blobToDataUrl", () => {
  it("is plain base64 of the bytes, under the prefix it is given", async () => {
    const url = await blobToDataUrl(new Blob(["hello"], { type: "text/plain" }), "image/png");
    expect(url).toBe(`data:image/png;base64,${btoa("hello")}`);
  });

  it("survives a file bigger than one chunk", async () => {
    const bytes = new Uint8Array(100_000).map((_, i) => i % 251);
    const url = await blobToDataUrl(new Blob([bytes]), "application/pdf");
    const back = Uint8Array.from(atob(url.split(",")[1]!), (c) => c.charCodeAt(0));
    expect(back).toEqual(bytes);
  });
});

/* ------------------------------------------------------------------ */
/* The canvas encoder, against a browser that cannot write WebP        */
/* ------------------------------------------------------------------ */

describe("canvasEncode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function fakeBrowser(writes: (type: string) => string) {
    const asked: string[] = [];
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ fillStyle: "", fillRect: () => {}, drawImage: () => {} }),
      toBlob: (cb: (b: Blob | null) => void, type: string) => {
        asked.push(type);
        cb(new Blob([new Uint8Array(100)], { type: writes(type) }));
      },
    };
    vi.stubGlobal("createImageBitmap", async () => ({
      width: 4032,
      height: 3024,
      close: () => {},
    }));
    vi.stubGlobal("document", { createElement: () => canvas });
    return { canvas, asked };
  }

  it("falls back to JPEG where the browser hands back PNG for WebP, as Safari does", async () => {
    const { asked } = fakeBrowser((type) => (type === "image/webp" ? "image/png" : type));
    const blob = await canvasEncode(new Blob(), TICKET_IMAGE_MAX_EDGE, 0.85);
    expect(blob.type).toBe("image/jpeg");
    expect(asked).toEqual(["image/webp", "image/jpeg"]);
  });

  it("keeps WebP where the browser writes it", async () => {
    const { asked } = fakeBrowser((type) => type);
    const blob = await canvasEncode(new Blob(), TICKET_IMAGE_MAX_EDGE, 0.85);
    expect(blob.type).toBe("image/webp");
    expect(asked).toEqual(["image/webp"]);
  });

  it("draws the sheet at the long-edge cap, keeping its shape", async () => {
    const { canvas } = fakeBrowser((type) => type);
    await canvasEncode(new Blob(), TICKET_IMAGE_MAX_EDGE, 0.85);
    expect(canvas.width).toBe(2200);
    expect(canvas.height).toBe(1650);
  });
});
