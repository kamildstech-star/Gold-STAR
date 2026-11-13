import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { describeAuditRow } from "./access-history";

/**
 * David, 24 Sep, in the users admin: "I can't edit this? I can only remove it
 * and re-add?" — and he noticed the change history.
 */
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const EDITOR = read("src/components/user-editor.tsx");
const SQL = read("supabase/migrations/20260928120000_location_membership_edit_in_place.sql");

describe("an assignment is edited where it is", () => {
  it("changes the role or the office with an UPDATE, not remove + add", () => {
    const edit = EDITOR.match(/const editMembership = useMutation\(\{[\s\S]*?\n {2}\}\);/)![0];
    expect(edit).toContain('.from("location_members")');
    expect(edit).toContain(".update(v.patch)");
    expect(EDITOR).toContain("patch: { role: v as LocationMemberRole },");
    expect(EDITOR).toContain("patch: { location_id: v }");
  });

  it("never offers your own assignments for editing", () => {
    expect(EDITOR).toMatch(/\{isSelf \? \(\s*<Badge/);
  });
});

describe("the history records every edit", () => {
  it("logs a role change, and an office move as removed + added", () => {
    const fn = SQL.match(
      /CREATE OR REPLACE FUNCTION public\.audit_location_members[\s\S]*?END \$\$;/,
    )![0];
    expect(fn).toContain("NEW.location_id IS DISTINCT FROM OLD.location_id");
    expect(fn).toContain("'location_role_changed'");
    expect(fn.match(/'location_removed'/g)).toHaveLength(2);
    expect(fn.match(/'location_added'/g)).toHaveLength(2);
    expect(fn).toContain("EXCEPTION WHEN OTHERS THEN");
  });

  it("the history already words a role change", () => {
    const row = describeAuditRow(
      {
        id: "a",
        action: "location_role_changed",
        entity: "location_members",
        old_value: { location_id: "l1", role: "field" },
        new_value: { location_id: "l1", role: "manager" },
        occurred_at: "2026-09-28T10:00:00Z",
        actor_id: null,
        target_user_id: "u",
      } as never,
      { locationName: () => "Lakewood" } as never,
    );
    expect(JSON.stringify(row)).toMatch(/field → manager|Field → Manager/);
  });

  it("a moved assignment carries the primary office with it", () => {
    expect(SQL).toMatch(/AFTER UPDATE OF location_id ON public\.location_members/);
  });
});
