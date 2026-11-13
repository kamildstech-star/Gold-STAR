import { describe, expect, it, vi } from "vitest";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";

const fixture = vi.hoisted(() => ({
  status: "draft",
  id: "estimate-1",
  invoice_number: "INV-1",
  job_id: "job-1",
  location_id: "location-1",
  customer_name: "Sample Customer",
  notes: "Approved customer work",
  billed_amount: 100,
  job: {
    id: "job-1",
    job_number: "JOB-1",
    address: "100 Main St",
    important_instructions: "PRIVATE: Do not block driveway",
  },
  location: { name: "Gold Star Restoration" },
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => {
      const result = {
        data: table === "invoices" || table === "estimates" ? fixture : [],
        error: null,
      };
      const query = {
        select: () => query,
        eq: () => query,
        order: () => query,
        limit: () => query,
        single: async () => result,
        maybeSingle: async () => ({ data: null, error: null }),
        then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
      };
      return query;
    },
  },
}));
import { buildInvoicePdf } from "./invoice-pdf";
import { buildEstimatePdf } from "./estimate-pdf";
import { DEFAULT_REPORT_FILTERS } from "./report-filters";

async function pdfText(bytes: Uint8Array) {
  const pdf = await PDFDocument.load(bytes);
  let text = "";
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      text += new TextDecoder("latin1").decode(decodePDFRawStream(object).decode());
    } catch {
      /* Non-text stream. */
    }
  }
  return text.replace(/<([0-9A-Fa-f]+)>/g, (_, hex: string) =>
    (hex.match(/../g) ?? []).map((byte) => String.fromCharCode(parseInt(byte, 16))).join(""),
  );
}

describe("internal job instructions stay off customer documents", () => {
  for (const [name, build] of [
    ["invoice", buildInvoicePdf],
    ["estimate", buildEstimatePdf],
  ] as const) {
    it(`keeps customer notes but excludes private instructions from the ${name}`, async () => {
      const pdf = await build("document-1", { ...DEFAULT_REPORT_FILTERS, notes: true }, "customer");
      const text = await pdfText(pdf.bytes);
      expect(text).toContain("Approved customer work");
      expect(text).not.toContain("PRIVATE");
      expect(text).not.toContain("Do not block driveway");
    });
  }
});
