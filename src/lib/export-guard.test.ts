import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { EXPORT_MANAGER_ROLES, MANAGER_EXPORTABLE_ENTITIES, managerMayExport } from "./export-guard";

/**
 * Mark, 6 Oct: office managers may export the Equipment register. Exports are
 * otherwise a leak surface, so the exception is one entity and the managers,
 * and the database — log_export — is the real gate. These keep the client's
 * list and the function's list the same list.
 */
const SQL = readFileSync(
  "supabase/migrations/20261006120000_export_gate_equipment_managers.sql",
  "utf8",
).replace(/\r\n/g, "\n");
const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION public.log_export("));

describe("which managers may export what", () => {
  it("lets an office manager export the Equipment register", () => {
    expect(managerMayExport(["location_manager"], "equipment")).toBe(true);
    expect(managerMayExport(["office"], "equipment")).toBe(true);
    expect(managerMayExport(["regional"], "equipment")).toBe(true);
  });

  it("does not let a manager export anything else", () => {
    for (const entity of ["jobs", "contacts", "accounts", "invoices", "profitability", undefined]) {
      expect(managerMayExport(["location_manager"], entity), String(entity)).toBe(false);
    }
  });

  it("does not let a rep or crew export the register", () => {
    for (const role of ["sales_rep", "crew", "field", "field_chaser", "cold_caller"] as const) {
      expect(managerMayExport([role], "equipment"), role).toBe(false);
    }
  });
});

describe("log_export asks the same question", () => {
  it("opens exactly the client's entities to exactly the client's roles", () => {
    for (const entity of MANAGER_EXPORTABLE_ENTITIES) expect(fn).toContain(`_entity = '${entity}'`);
    const roles = fn.match(/role::text IN \(([^)]*)\)/)![1]!;
    const listed = [...roles.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...EXPORT_MANAGER_ROLES].sort());
  });

  it("still requires can_export for everything else, and audits before the file", () => {
    expect(fn).toMatch(/public\.can_export\(auth\.uid\(\)\)/);
    expect(fn.indexOf("INSERT INTO public.export_audit")).toBeLessThan(fn.indexOf("RETURN v_id"));
  });

  it("writes the large-export alert into columns notifications actually has", () => {
    // `kind` and `link` do not exist; the old insert raised at 500+ rows and
    // took the export down with it.
    expect(fn).toMatch(/INSERT INTO public\.notifications \(user_id, type, title, body, href, priority\)/);
    expect(fn).not.toMatch(/\bkind\b/);
    expect(fn).not.toMatch(/\blink\b/);
    expect(SQL).toMatch(/ALTER TYPE public\.notification_type ADD VALUE IF NOT EXISTS 'export_alert';/);
  });
});

describe("the page and the Excel button pass their entity to the gate", () => {
  it("Equipment's CSV and the shared Excel button both name it", () => {
    const page = readFileSync("src/routes/_authenticated/equipment.index.tsx", "utf8");
    expect(page).toContain('useExportGate({ entity: "equipment" })');
    const button = readFileSync("src/components/export-excel-button.tsx", "utf8");
    expect(button).toContain("useExportGate({ entity: entity ?? report })");
  });
});
