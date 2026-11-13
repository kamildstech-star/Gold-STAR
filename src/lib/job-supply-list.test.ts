import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  CONDENSED_SUPPLY_CODES,
  condensedRows,
  supplyCodesFor,
  supplyListKind,
} from "./job-supply-list";
import { TM_RATE_CODES_COMPILED } from "./tm-rate-codes";

/* FE10, 28 Oct: the job type picks the material list. */
describe("which supply list a job uses", () => {
  it("T&M jobs keep the detailed rate sheet; every other job the condensed list", () => {
    expect(supplyListKind("t_m")).toBe("detailed");
    for (const t of ["self_pay", "insurance", "undetermined", null, undefined]) {
      expect(supplyListKind(t)).toBe("condensed");
    }
    expect(supplyCodesFor("detailed")).toBeNull();
    expect([...supplyCodesFor("condensed")!]).toEqual([...CONDENSED_SUPPLY_CODES]);
  });

  it("the condensed list is about ten real catalogue codes, none of them labour", () => {
    expect(CONDENSED_SUPPLY_CODES.length).toBe(10);
    const rows = condensedRows(TM_RATE_CODES_COMPILED);
    expect(rows.map((r) => r.code)).toEqual([...CONDENSED_SUPPLY_CODES]);
    expect(rows.every((r) => r.section !== "labor")).toBe(true);
  });

  it("the field form, the supply editor and the ledger all follow it", () => {
    const read = (f: string) => readFileSync(f, "utf8");
    expect(read("src/routes/_authenticated/jobs.$id.tsx")).toContain(
      "supplyList={supplyListKind(job.job_type)}",
    );
    expect(read("src/components/tm-form-editors.tsx")).toContain(
      "(!onlyCodes || onlyCodes.has(r.code) || qty.has(r.code))",
    );
    const ledger = read("src/lib/invoice-ledger-pull.ts");
    expect(ledger).toContain("out.push(...(await condensedSupplyListLines(client, jobId)));");
    expect(ledger).toMatch(/supplyListKind\(.*job_type\) !== "condensed"/);
  });
});
