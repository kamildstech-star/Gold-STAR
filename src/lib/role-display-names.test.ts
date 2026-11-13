import { describe, expect, it } from "vitest";

import { ALL_ROLES, ROLE_LABELS, dashboardFor } from "@/lib/roles";

/*
 * Melly meeting, 21 Oct: "Regional" is shown as Regional Director and
 * "Location Manager" as Project Manager. Display only — the keys, which the
 * database enum, the access rules and every stored membership use, stay.
 */
describe("role display names", () => {
  it("shows the new names", () => {
    expect(ROLE_LABELS.regional).toBe("Regional Director");
    expect(ROLE_LABELS.location_manager).toBe("Project Manager");
  });

  it("keeps the keys and the dashboards they open", () => {
    expect(ALL_ROLES).toContain("regional");
    expect(ALL_ROLES).toContain("location_manager");
    expect(dashboardFor("regional")).toBe("regional");
    expect(dashboardFor("location_manager")).toBe("location_manager");
  });
});
