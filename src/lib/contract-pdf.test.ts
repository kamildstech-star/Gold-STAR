import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { buildContractPdf, type ContractInput } from "@/lib/contract-pdf";

/**
 * Point 7 (10 Nov call, "where do we stand on the contracts"): the contract
 * builder had no test of its own. This builds the preview and the signed copy
 * from a fixture and reads the text back. Set CONTRACT_SAMPLE=<path> to keep
 * the signed file.
 */

// 1x1 transparent PNG, standing in for the signature pad.
const DOT =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const INPUT: ContractInput = {
  title: "Work Authorization",
  body: [
    "I authorize Gold Star Restoration to perform emergency water mitigation at 12 Main St.",
    "",
    "Payment is due on receipt of the invoice. Insurance proceeds are assigned to Gold Star Restoration for the work performed.",
  ].join("\n"),
  meta: [
    ["Job", "GS-1001"],
    ["Property", "12 Main St, Brooklyn, NY 11201"],
    ["Customer", "Jane Doe"],
  ],
  brand: {
    companyName: "Gold Star Restoration",
    legalEntityName: "Gold Star Restoration of Brooklyn LLC",
    officeName: "Brooklyn",
    address: "1 Office Rd, Brooklyn, NY",
    phone: "(877) 959-2837",
    email: "office@example.com",
    ein: null,
    logo: null,
    logoMime: null,
  },
  filledFields: [["Best phone", "555-0100"]],
};

async function pageText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(obj).decode());
    } catch {
      // An image stream.
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) =>
    (hex.match(/../g) ?? []).map((b) => String.fromCharCode(parseInt(b, 16))).join(""),
  );
}

describe("contract PDF (point 7, 11 Nov)", () => {
  it("builds the preview with the title, the terms, the job facts and the office's legal entity", async () => {
    const text = await pageText(await buildContractPdf(INPUT));
    expect(text).toContain("WORK AUTHORIZATION");
    expect(text).toContain("emergency water mitigation");
    expect(text).toContain("GS-1001");
    expect(text).toContain("Gold Star Restoration of Brooklyn LLC");
  });

  it("builds the signed copy with the signer and the answers they gave", async () => {
    const bytes = await buildContractPdf({
      ...INPUT,
      signature: {
        signerName: "Jane Doe",
        signerRole: "Owner",
        signerEmail: "jane@example.com",
        signedAtIso: "2026-11-11T15:00:00Z",
        signatureDataUrl: DOT,
        ip: "203.0.113.5",
        userAgent: "test",
      },
    });
    const text = await pageText(bytes);
    expect(text).toContain("Jane Doe");
    expect(text).toContain("555-0100");
    const path = process.env.CONTRACT_SAMPLE;
    if (path) writeFileSync(path, bytes);
  });
});
