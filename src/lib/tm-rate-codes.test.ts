import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  TM_RATE_CODES_COMPILED,
  TM_SECTIONS,
  codeIsPrinted,
  groupBySection,
  laborCodes,
  type TmRateCode,
} from "@/lib/tm-rate-codes";

/*
 * The catalogue is Daily Supply List 1.1, line for line. These counts were
 * taken off the PDF (pymupdf text extraction, checked against the render):
 * 27 labor codes APM…WE3, consumables 100–156, equipment 300–346, PPE
 * 200–212, vehicles 400–406, and six General Charges with no printed code.
 */
const SHEET_COUNTS: Record<string, number> = {
  labor: 27,
  consumable: 57,
  equipment: 47,
  ppe: 13,
  vehicle: 7,
  general: 6,
};

const MIGRATION = readFileSync(
  "supabase/migrations/20261007230000_tm_rate_codes.sql",
  "utf8",
).replace(/\r\n/g, "\n");

/** The seed's VALUES rows, parsed — ('CODE', 'section', 'label', sort). */
function seedRows(): { code: string; section: string; label: string; sort: number }[] {
  const block = MIGRATION.match(
    /INSERT INTO public\.tm_rate_codes[^]*?VALUES\n([^]*?)\nON CONFLICT/,
  );
  expect(block).not.toBeNull();
  const re = /\('((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)', (\d+)\)/g;
  const out: { code: string; section: string; label: string; sort: number }[] = [];
  for (const m of block![1]!.matchAll(re)) {
    const un = (s: string) => s.replace(/''/g, "'");
    out.push({ code: un(m[1]!), section: un(m[2]!), label: un(m[3]!), sort: Number(m[4]) });
  }
  return out;
}

describe("T&M rate codes — the Daily Supply List", () => {
  it("has every line of the sheet, section by section", () => {
    const counts: Record<string, number> = {};
    for (const r of TM_RATE_CODES_COMPILED) counts[r.section] = (counts[r.section] ?? 0) + 1;
    expect(counts).toEqual(SHEET_COUNTS);
    expect(TM_RATE_CODES_COMPILED).toHaveLength(157);
  });

  it("numbers the coded sections without a gap", () => {
    const codes = (s: string) =>
      TM_RATE_CODES_COMPILED.filter((r) => r.section === s).map((r) => Number(r.code));
    const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
    expect(codes("consumable")).toEqual(range(100, 156));
    expect(codes("ppe")).toEqual(range(200, 212));
    expect(codes("equipment")).toEqual(range(300, 346));
    expect(codes("vehicle")).toEqual(range(400, 406));
  });

  it("keeps the labor codes T&M Pro knows, in the sheet's order", () => {
    expect(laborCodes(TM_RATE_CODES_COMPILED).map((r) => r.code)).toEqual(
      "APM BMT CA CE CC CM CCF DL DI GL HSO MT PNT PCT PCR PE PF PM PS RS RT SL SPM SCL TL WE WE3".split(
        " ",
      ),
    );
  });

  it("spells lines exactly as printed", () => {
    const by = new Map(TM_RATE_CODES_COMPILED.map((r) => [r.code, r]));
    expect(by.get("WE3")!.label).toBe("Water Extraction - Cat 3");
    expect(by.get("103")!.label).toBe(
      "4 Mil Poly (for containment and protection) Billed per roll",
    );
    expect(by.get("300")!.label).toBe('2" submersible trash pump and hose - per hr');
    expect(by.get("212")!.label).toBe("Safety Glasses");
    expect(by.get("406")!.label).toBe("Pickup Truck");
    // The sheet prints this line twice, under 317 and 318; both are kept.
    expect(by.get("317")!.label).toBe(by.get("318")!.label);
    expect(
      TM_RATE_CODES_COMPILED.filter((r) => r.section === "general").map((r) => r.label),
    ).toEqual([
      "Emergency Service Fee",
      "Debris Removal - Pass Through plus 20%",
      "Hotel - Pass Through plus 20%",
      "O & P - 20% of 3rd party bills",
      "Per Diem - Per Person",
      "Small Tools Charge - 3% of billed labor",
    ]);
  });

  it("never prints a General Charge's storage key as a code", () => {
    for (const r of TM_RATE_CODES_COMPILED) {
      expect(codeIsPrinted(r)).toBe(r.section !== "general");
      if (r.section === "general") expect(r.code.startsWith("GEN-")).toBe(true);
    }
  });

  it("groups into the six sheet sections in order, and drops switched-off labor codes", () => {
    const rows: TmRateCode[] = TM_RATE_CODES_COMPILED.map((r) =>
      r.code === "CA" ? { ...r, active: false } : r,
    );
    expect(groupBySection(rows).map((g) => g.section)).toEqual([...TM_SECTIONS]);
    expect(laborCodes(rows).some((r) => r.code === "CA")).toBe(false);
  });

  it("seeds the database with exactly the compiled list", () => {
    const seeded = seedRows();
    expect(seeded).toEqual(
      TM_RATE_CODES_COMPILED.map((r) => ({
        code: r.code,
        section: r.section,
        label: r.label,
        sort: r.sort_order,
      })),
    );
  });

  it("every code fits the table's CHECK", () => {
    for (const r of TM_RATE_CODES_COMPILED) expect(r.code).toMatch(/^[A-Z0-9][A-Z0-9-]{0,23}$/);
    expect(new Set(TM_RATE_CODES_COMPILED.map((r) => r.code)).size).toBe(157);
  });
});
