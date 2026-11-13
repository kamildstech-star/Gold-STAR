import { describe, expect, it } from "vitest";

import {
  calculateJob,
  emptyJobCalculationInput,
  toCustomerCalculation,
  type JobCalculationInput,
} from "@/lib/job-calculator";
import { buildJobCalculatorPdf } from "@/lib/job-calculator-pdf";

const INPUT: JobCalculationInput = {
  ...emptyJobCalculationInput(),
  jobDate: "2026-09-15",
  jobType: "water",
  customerName: "Ada Customer",
  contactNumber: "555-0100",
  email: "ada@example.com",
  address: "100 Main Street",
  locality: "Brooklyn",
  region: "NY",
  postalCode: "11201",
  days: 2,
  workers: 3,
  regularHours: 8,
  afterHours: 2,
  emergency: true,
  garbageFee: 150,
  miscellaneousFee: 75,
  equipment: {
    boarding: 1,
    air_mover: 4,
    dehumidifier: 2,
    air_samples: 1,
  },
};

/** Read the actual show-text operands from pdf-lib's compressed streams. */
async function pageText(bytes: Uint8Array): Promise<string> {
  const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("pdf-lib");
  const doc = await PDFDocument.load(bytes);
  let out = "";
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) continue;
    try {
      out += new TextDecoder("latin1").decode(decodePDFRawStream(object).decode());
    } catch {
      // Font or image stream, not page text.
    }
  }
  return out.replace(/<([0-9A-Fa-f]+)>/g, (_match, hex: string) =>
    (hex.match(/../g) ?? []).map((byte) => String.fromCharCode(Number.parseInt(byte, 16))).join(""),
  );
}

describe("David's job calculator mapping", () => {
  it("reproduces workbook labor, supply, truck and emergency formulas", () => {
    const result = calculateJob(INPUT);

    // Job Calculator!J10: emergency workers + regular labor + after-hours labor.
    expect(result.regularLaborPrice).toBe(3_360);
    expect(result.afterHoursLaborPrice).toBe(1_260);
    expect(result.emergencyWorkerBonuses).toBe(300);
    expect(result.laborCustomerPrice).toBe(4_920);
    expect(result.laborInternalCost).toBe(3_162.86);

    // Job Calculator!G10/H10 and J30's $50/day truck-cost adjustment.
    expect(result.supplyCost).toBe(500);
    expect(result.truckCustomerPrice).toBe(200);
    expect(result.truckInternalCost).toBe(100);
  });

  it("uses the visible equipment rate tables instead of the broken row-140 formulas", () => {
    const result = calculateJob(INPUT);

    expect(result.equipmentCustomerPrice).toBe(1_880);
    expect(result.equipmentInternalCost).toBe(235);
    expect(result.equipmentProfit).toBe(1_645);
    expect(result.customerPrice).toBe(7_725);
    expect(result.internalCost).toBe(4_222.86);
    expect(result.overallProfit).toBe(3_502.14);
  });

  it("uses the correct supply rate for every supported job type", () => {
    expect(calculateJob({ ...INPUT, jobType: "water" }).supplyCost).toBe(500);
    expect(calculateJob({ ...INPUT, jobType: "mold" }).supplyCost).toBe(500);
    expect(calculateJob({ ...INPUT, jobType: "fire_smoke" }).supplyCost).toBe(600);
  });

  it("clamps invalid negative input instead of producing a negative quote", () => {
    const result = calculateJob({
      ...INPUT,
      days: -1,
      workers: -3,
      garbageFee: -100,
      equipment: { air_mover: -4 },
    });
    expect(result.customerPrice).toBe(75);
    expect(result.internalCost).toBe(75);
    expect(result.overallProfit).toBe(0);
  });
});

describe("customer PDF privacy", () => {
  it("removes private values before the PDF builder receives its payload", () => {
    const result = calculateJob(INPUT);
    const publicCalculation = toCustomerCalculation(INPUT, result);
    const serialized = JSON.stringify(publicCalculation);

    expect(serialized).not.toContain("internalCost");
    expect(serialized).not.toContain("internalRate");
    expect(serialized).not.toContain("equipmentProfit");
    expect(serialized).not.toContain("overallProfit");
    expect(serialized).not.toContain("4222.86");
    expect(serialized).toContain('"jobDate":"2026-09-15"');
    expect(serialized).toContain("7725");
  });

  it("prints the customer total without internal cost or profit labels/values", async () => {
    const result = calculateJob(INPUT);
    const pdf = await buildJobCalculatorPdf(
      toCustomerCalculation(INPUT, result),
      new Date("2026-09-04T12:00:00Z"),
    );
    const text = await pageText(pdf.bytes);

    expect(text).toContain("Ada Customer");
    expect(text).toContain("Job date: 9/15/2026");
    expect(text).toContain("CUSTOMER PRICE");
    expect(text).toContain("$7,725.00");
    expect(text).not.toContain("INTERNAL");
    expect(text).not.toContain("PROFIT");
    expect(text).not.toContain("$4,222.86");
    expect(text).not.toContain("$1,645.00");
    expect(text).not.toContain("$3,502.14");
  });
});
