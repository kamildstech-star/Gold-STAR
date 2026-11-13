import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  rosterActions,
  rosterOfficeText,
  rosterSummary,
  type StaffRosterRow,
} from "./staff-roster";

const row = (over: Partial<StaffRosterRow>): StaffRosterRow => ({
  email: "a@b.com",
  full_name: "A B",
  roles: ["crew"],
  job_title: null,
  primary_office: "lakewood",
  office_scope: "primary",
  except_office: null,
  invite_policy: "invite",
  note: null,
  user_id: null,
  last_outcome: null,
  last_detail: null,
  invited_at: null,
  account_created_at: null,
  ...over,
});

describe("staff roster panel", () => {
  it("offers access only to people without an account, and never invites a held one", () => {
    expect(rosterActions(row({}))).toEqual(["invite", "link", "account"]);
    expect(rosterActions(row({ invite_policy: "hold" }))).toEqual(["account"]);
    expect(rosterActions(row({ user_id: "u" }))).toEqual([]);
  });

  it("describes the office scope", () => {
    const label = (k: string) => ({ lakewood: "Lakewood, NJ", brooklyn: "Brooklyn, NY" })[k] ?? k;
    expect(rosterOfficeText(row({}), label)).toBe("Lakewood, NJ");
    expect(
      rosterOfficeText(row({ office_scope: "all_except", except_office: "brooklyn" }), label),
    ).toBe("All except Brooklyn, NY (primary Lakewood, NJ)");
    expect(rosterOfficeText(row({ office_scope: "all", primary_office: "brooklyn" }), label)).toBe(
      "All offices (primary Brooklyn, NY)",
    );
  });

  it("counts outcomes", () => {
    const s = rosterSummary([
      row({}),
      row({ user_id: "u", last_outcome: "updated" }),
      row({ invite_policy: "hold", last_outcome: "held" }),
    ]);
    expect(s).toMatchObject({ awaiting_account: 1, updated: 1, held: 1 });
  });

  it("sends mail only from the per-person Send invite action", () => {
    const fns = readFileSync("src/lib/staff-roster.functions.ts", "utf8");
    expect(fns.match(/inviteUserByEmail\(/g)).toHaveLength(1);
    expect(fns).toMatch(/if \(mode === "account"\)[\s\S]*createUser\(/);
    const panel = readFileSync("src/components/admin/staff-roster-panel.tsx", "utf8");
    // No "invite everybody" loop.
    expect(panel).not.toMatch(/rows\.(map|forEach)\([^)]*provision/);
  });

  it("Create all missing accounts sends no email and skips existing accounts", () => {
    const fns = readFileSync("src/lib/staff-roster.functions.ts", "utf8");
    const bulk = fns.slice(fns.indexOf("export const adminCreateMissingRosterAccounts"));
    expect(bulk).not.toMatch(/inviteUserByEmail|generateLink|resend\(|resetPasswordForEmail/);
    expect(bulk).toMatch(/createUser\(\{\s*email,\s*email_confirm: false/);
    // Checked against the live auth list, case-insensitively, not the roster's note.
    expect(bulk).toMatch(/listUsers\(/);
    expect(bulk).toMatch(/existing\.has\(email\)[\s\S]*result: "skipped"/);
    expect(bulk).toMatch(/assertPrivileged\(context\.supabase, context\.userId\)/);
    // Every person gets a line: created, skipped or error.
    expect(bulk).toMatch(/result: "created"/);
    expect(bulk).toMatch(/result: "error"/);
  });

  it("asks before creating, and shows the per-person report", () => {
    const panel = readFileSync("src/components/admin/staff-roster-panel.tsx", "utf8");
    expect(panel).toMatch(/data-create-all-missing/);
    expect(panel).toMatch(/<AlertDialogAction onClick=\{\(\) => createMissing\.mutate\(\)\}>/);
    expect(panel).toMatch(/data-bulk-report/);
  });
});
