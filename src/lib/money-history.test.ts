import { describe, expect, it } from "vitest";

import {
  auditFields,
  auditKind,
  auditSummary,
  auditValue,
  auditWhat,
  changeLogCsv,
  type AuditEntry,
} from "@/lib/money-history";

const entry = (over: Partial<AuditEntry>): AuditEntry => ({
  id: 1,
  changed_at: "2026-10-29T14:05:00Z",
  changed_by: "u1",
  book: "cost",
  entity: "money_value",
  entity_key: "PCT",
  field: "cost_rate",
  old_value: null,
  new_value: { value: 62, effective_from: "2026-10-29" },
  office_id: null,
  note: "Mgmt, 2026",
  ...over,
});

describe("the change log reads like a sentence", () => {
  it("says a dated value, a reset, and a plain change in words", () => {
    expect(auditValue({ value: 62, effective_from: "2026-10-29" })).toBe("$62.00 from 2026-10-29");
    expect(auditValue({ value: null, effective_from: "2026-11-01" })).toBe(
      "back to default from 2026-11-01",
    );
    expect(auditValue(null)).toBe("—");
    expect(auditValue(true)).toBe("yes");
    expect(auditWhat(entry({}))).toBe("Cost");
    expect(auditWhat(entry({ field: "cost_hr" }))).toBe("Cost per field hour");
    expect(auditWhat(entry({ entity: "equipment_type", field: "default_make" }))).toBe(
      "equipment type: default make",
    );
  });

  it("exports who, old → new, when, book, office and note as CSV", () => {
    const csv = changeLogCsv(
      [
        entry({}),
        entry({
          id: 2,
          changed_by: null,
          book: "overhead",
          entity_key: "wage",
          field: "cost_hr",
          office_id: "nj",
          note: null,
        }),
      ],
      new Map([["u1", "Dana Admin"]]),
      new Map([["nj", "Lakewood"]]),
    );
    const [head, a, b] = csv.split("\n");
    expect(head).toBe("When,Who,Book,Item,What,Old,New,Office,Note");
    expect(a).toMatch(
      /,Dana Admin,Cost,PCT,Cost,—,\$62\.00 from 2026-10-29,Company default,"Mgmt, 2026"$/,
    );
    expect(b).toMatch(
      /,System,Overhead,wage,Cost per field hour,—,\$62\.00 from 2026-10-29,Lakewood,$/,
    );
  });
});

describe("a record change reads as a summary, field by field in Details", () => {
  const created = entry({
    book: "catalog",
    entity: "catalog_item",
    entity_key: "318",
    field: "created",
    old_value: null,
    new_value: {
      name: "Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring",
      unit: "day",
      active: true,
      category: "equipment",
    },
  });

  it("an added item is its name and key facts, not JSON", () => {
    expect(auditKind(created)).toBe("added");
    expect(auditWhat(created)).toBe("Catalog item added");
    expect(auditSummary(created)).toBe(
      "Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring · Day · Active · Equipment",
    );
    expect(auditSummary(created)).not.toContain("{");
  });

  it("Details lists every field in words", () => {
    expect(auditFields(created)?.map((f) => [f.label, f.new])).toEqual([
      ["Name", "Dehumidifier - Desiccant - 8500-15000 CFM - No monitoring"],
      ["Unit", "Day"],
      ["Active", "Yes"],
      ["Category", "Equipment"],
    ]);
  });

  it("an edit names the fields that moved, changed ones first", () => {
    const edited = entry({
      entity: "catalog_item",
      field: "updated",
      old_value: { name: "Fan", unit: "day", active: true, sort_order: 4 },
      new_value: { name: "Air mover", unit: "day", active: false, sort_order: 5 },
    });
    expect(auditKind(edited)).toBe("changed");
    expect(auditSummary(edited)).toBe("Name: Fan → Air mover · Active: Yes → No · +1 more");
    expect(auditFields(edited)?.map((f) => f.key)).toEqual([
      "name",
      "active",
      "sort_order",
      "unit",
    ]);
  });

  it("a dated money value keeps its old → new line", () => {
    expect(auditFields(entry({}))).toBeNull();
    expect(auditSummary(entry({}))).toBe("— → $62.00 from 2026-10-29");
  });
});
