import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Mark, with a screenshot of an account header: "the labels need to show."
 *
 * Two labels were ticked in the picker and saved. The header still read
 * "Labels" and nothing else. A label nobody can see without opening a popover
 * is not doing the job a label is for — the whole point of GIFTS OK or OFF
 * LIMITS is that somebody reads it before they act.
 *
 * The picker is the single place all of this is drawn: the account header,
 * both drawers and the account panel all render it, and none of them showed
 * labels by any other route. Fixing it here fixes all four.
 */
const SOURCE = readFileSync("src/components/label-picker.tsx", "utf8");

describe("the label picker", () => {
  it("draws the applied labels, not just a button", () => {
    expect(SOURCE).toContain("<LabelPills");
    expect(SOURCE).toContain("labels={applied}");
  });

  it("shows them by default, because that is the whole point", () => {
    expect(SOURCE).toMatch(/showApplied = true/);
  });

  it("reads which labels are on this record", () => {
    expect(SOURCE).toContain("fetchLabelIdsFor(scope, recordId!)");
  });

  it("orders them the way an admin arranged them", () => {
    // Not by when somebody happened to tick them, which would reshuffle the
    // header every time anyone edited it.
    expect(SOURCE).toContain("(allQ.data ?? []).filter((l) => ids.has(l.id))");
  });

  it("refreshes the chips when the popover saves", () => {
    // Otherwise the ticks say one thing and the header says another until a
    // reload, which reads as the save having failed.
    expect(SOURCE).toContain('invalidateQueries({ queryKey: ["label-ids", scope, recordId] })');
  });

  it("asks for nothing when there is no record to ask about", () => {
    // Manage-only mode on the admin screen has no recordId.
    expect(SOURCE).toContain("enabled: showApplied && !!recordId");
  });
});

describe("everywhere the picker is mounted", () => {
  const places = [
    "src/components/account-drawer.tsx",
    "src/components/account-panel.tsx",
    "src/components/contact-drawer.tsx",
  ];

  it("gets the labels without asking for them", () => {
    for (const f of places) {
      const src = readFileSync(f, "utf8");
      expect(src, f).toContain("<LabelPicker");
      // None of them opted out, and none of them draws labels separately, so
      // none of them ends up showing the same labels twice.
      expect(src, f).not.toContain("showApplied={false}");
      expect(src, f).not.toContain("<LabelPills");
    }
  });
});
