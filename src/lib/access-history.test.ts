import { describe, expect, it } from "vitest";

import { auditRowRole, describeAuditRow, subjectForKey } from "@/lib/access-history";

const labels = new Map([["fleet.manage", "Manage fleet"]]);

describe("describeAuditRow — role rules", () => {
  it("names the page and the role when a role is allowed a page", () => {
    const line = describeAuditRow(
      {
        action: "role_permission_added",
        entity: "role_permissions",
        old_value: null,
        new_value: { role: "crew", permission_key: "page.pipeline" },
      },
      labels,
    );
    expect(line.title).toBe("Page allowed");
    expect(line.subject).toBe("Pipeline");
    expect(line.change).toBe("off → on");
    expect(line.role).toBe("Crew");
  });

  it("reads the removed row from old_value and labels a capability by the catalog", () => {
    const line = describeAuditRow(
      {
        action: "role_permission_removed",
        entity: "role_permissions",
        old_value: { role: "sales_rep", permission_key: "fleet.manage" },
        new_value: null,
      },
      labels,
    );
    expect(line.title).toBe("Capability removed");
    expect(line.subject).toBe("Manage fleet");
    expect(line.change).toBe("on → off");
  });
});

describe("describeAuditRow — personal overrides", () => {
  it("says blocked for a revoke and allowed for a grant", () => {
    const grant = describeAuditRow({
      action: "user_permission_added",
      entity: "user_permissions",
      old_value: null,
      new_value: { permission_key: "page.jobs", effect: "grant" },
    });
    expect(grant.title).toBe("Page allowed for this person");
    expect(grant.subject).toBe("Jobs");
    expect(grant.change).toBe("role → allow");

    const block = describeAuditRow({
      action: "user_permission_added",
      entity: "user_permissions",
      old_value: null,
      new_value: { permission_key: "page.jobs", effect: "revoke" },
    });
    expect(block.title).toBe("Page blocked for this person");
    expect(block.change).toBe("role → block");
  });

  it("shows the value that was cleared, so 'back to role' has a before", () => {
    const line = describeAuditRow({
      action: "user_permission_removed",
      entity: "user_permissions",
      old_value: { permission_key: "page.jobs", effect: "revoke" },
      new_value: null,
    });
    expect(line.title).toBe("Personal override cleared");
    expect(line.change).toBe("block → role");
  });

  it("understands the action names the first trigger emitted", () => {
    const line = describeAuditRow({
      action: "permission_revoked",
      entity: "user_permissions",
      old_value: null,
      new_value: { permission_key: "fleet.manage", effect: "revoke" },
    });
    expect(line.title).toBe("Capability blocked for this person");
  });
});

describe("describeAuditRow — roles and sign-in", () => {
  it("labels a role assignment with the role", () => {
    const line = describeAuditRow({
      action: "role_granted",
      entity: "user_roles",
      old_value: null,
      new_value: { role: "sales_rep" },
    });
    expect(line.title).toBe("Role granted");
    expect(line.subject).toBe("Sales Rep (legacy)");
  });

  it("says which way sign-in went instead of printing is_active", () => {
    const line = describeAuditRow({
      action: "deactivated",
      entity: "profiles",
      old_value: { is_active: true },
      new_value: { is_active: false },
    });
    expect(line.title).toBe("Deactivated");
    expect(line.subject).toBeNull();
    expect(line.change).toBe("active → inactive");
    expect(JSON.stringify(line)).not.toContain('{"is_active');
  });

  it("never throws on a row with no values at all", () => {
    const line = describeAuditRow({
      action: "deactivated",
      entity: "profiles",
      old_value: null,
      new_value: null,
    });
    expect(line.title).toBe("Deactivated");
    expect(line.subject).toBeNull();
    expect(line.change).toBeNull();
  });
});

describe("describeAuditRow — location and region memberships", () => {
  const names = {
    locations: new Map([["d71e7e1b-5f8f-42cc-9a39-8690768236ba", "Haverstraw, NY"]]),
    regions: new Map([["f8c15557-3b8c-4b8e-a6c4-f4197cb4fd91", "Northeast"]]),
  };

  it("names the office and the membership role, never the UUID", () => {
    const line = describeAuditRow(
      {
        action: "location_added",
        entity: "location_members",
        old_value: null,
        new_value: { role: "field", location_id: "d71e7e1b-5f8f-42cc-9a39-8690768236ba" },
      },
      undefined,
      names,
    );
    expect(line.title).toBe("Location added");
    expect(line.subject).toBe("Haverstraw, NY");
    expect(line.detail).toBe("as Field");
    expect(line.change).toBeNull();
    expect(JSON.stringify(line)).not.toContain("d71e7e1b");
  });

  it("reads a removal from old_value", () => {
    const line = describeAuditRow(
      {
        action: "location_removed",
        entity: "location_members",
        old_value: { role: "manager", location_id: "d71e7e1b-5f8f-42cc-9a39-8690768236ba" },
        new_value: null,
      },
      undefined,
      names,
    );
    expect(line.title).toBe("Location removed");
    expect(line.subject).toBe("Haverstraw, NY");
    expect(line.detail).toBe("as Manager");
  });

  it("shows a role change as old → new", () => {
    const line = describeAuditRow(
      {
        action: "location_role_changed",
        entity: "location_members",
        old_value: { role: "field", location_id: "d71e7e1b-5f8f-42cc-9a39-8690768236ba" },
        new_value: { role: "office", location_id: "d71e7e1b-5f8f-42cc-9a39-8690768236ba" },
      },
      undefined,
      names,
    );
    expect(line.title).toBe("Location role changed");
    expect(line.subject).toBe("Haverstraw, NY");
    expect(line.change).toBe("Field → Office");
    expect(line.detail).toBeNull();
  });

  it("says so in words when the office is gone or no names were given", () => {
    const row = {
      action: "location_added",
      entity: "location_members",
      old_value: null,
      new_value: { role: "field", location_id: "00000000-0000-0000-0000-000000000000" },
    };
    expect(describeAuditRow(row, undefined, names).subject).toBe("a location no longer on file");
    expect(describeAuditRow(row).subject).toBe("a location no longer on file");
    expect(JSON.stringify(describeAuditRow(row))).not.toContain("00000000-0000");
  });

  it("names the region", () => {
    const line = describeAuditRow(
      {
        action: "region_added",
        entity: "region_members",
        old_value: null,
        new_value: { region_id: "f8c15557-3b8c-4b8e-a6c4-f4197cb4fd91" },
      },
      undefined,
      names,
    );
    expect(line.title).toBe("Region added");
    expect(line.subject).toBe("Northeast");
    expect(line.detail).toBeNull();
  });
});

describe("describeAuditRow — entities nobody has written wording for", () => {
  it("names the record and its fields in words, never as JSON", () => {
    const line = describeAuditRow({
      action: "vehicle_assigned",
      entity: "fleet_assignments",
      old_value: null,
      new_value: { id: "row-1", vehicle_code: "VAN-7", user_id: "u1", note: null },
    });
    expect(line.title).toBe("Vehicle assigned");
    expect(line.subject).toBe("Fleet assignments");
    expect(line.detail).toBe("vehicle code: VAN-7, note: —");
    expect(line.change).toBeNull();
    for (const v of Object.values(line)) expect(String(v)).not.toMatch(/[{}]/);
  });

  it("writes a changed field as old → new", () => {
    const line = describeAuditRow({
      action: "quota_changed",
      entity: "sales_quotas",
      old_value: { target: 10, currency: "USD" },
      new_value: { target: 12, currency: "USD" },
    });
    expect(line.detail).toBe("target: 10 → 12, currency: USD");
  });

  it("still reads when there is nothing but an action", () => {
    const line = describeAuditRow({
      action: "something_odd",
      entity: null,
      old_value: null,
      new_value: null,
    });
    expect(line.title).toBe("Something odd");
    expect(line.subject).toBeNull();
    expect(line.detail).toBeNull();
  });
});

describe("helpers", () => {
  it("subjectForKey resolves pages from the catalog and capabilities from labels", () => {
    expect(subjectForKey("page.customers")).toBe("Customers");
    expect(subjectForKey("page.not-a-page")).toBe("page.not-a-page");
    expect(subjectForKey("fleet.manage", labels)).toBe("Manage fleet");
    expect(subjectForKey("fleet.manage")).toBe("fleet.manage");
    expect(subjectForKey(null)).toBeNull();
  });

  it("auditRowRole reads the role from whichever side has it", () => {
    expect(auditRowRole({ old_value: null, new_value: { role: "crew" } })).toBe("crew");
    expect(auditRowRole({ old_value: { role: "office" }, new_value: null })).toBe("office");
    expect(auditRowRole({ old_value: null, new_value: null })).toBeNull();
  });
});
