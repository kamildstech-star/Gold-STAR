/**
 * The Access screen's read-only variant, as markup.
 *
 * "It cannot be changed" has to be visible, not merely true: a switch that is
 * disabled still reads as a switch somebody could re-enable, and one that saves
 * nothing is worse. So the break-glass rows render a padlock and no control at
 * all. Server render only — no browser needed.
 */
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AccessRow } from "./access-row";
import { BREAK_GLASS_REASON, BREAK_GLASS_ROLE, resolveRolePages } from "@/lib/page-access";

/** Exactly the props the role panel passes for a page row of the dev role. */
function devPageRow() {
  const resolved = resolveRolePages({
    role: BREAK_GLASS_ROLE,
    storedRolePages: new Map(),
    catalogueSeeded: true,
  });
  const a = resolved.get("admin-access")!;
  return renderToString(
    createElement(AccessRow, {
      label: "Access (this screen)",
      detail: "/admin/permissions",
      note: BREAK_GLASS_REASON,
      allowed: a.allowed,
      source: a.source,
      locked: true,
      onToggle: () => {},
    }),
  );
}

function ordinaryPageRow() {
  return renderToString(
    createElement(AccessRow, {
      label: "Access (this screen)",
      detail: "/admin/permissions",
      allowed: true,
      source: "role",
      onToggle: () => {},
    }),
  );
}

describe("AccessRow — the dev role is drawn read-only", () => {
  it("renders a padlock and no switch for a locked row", () => {
    const html = devPageRow();
    expect(html).toContain("Locked");
    expect(html).toContain("lucide-lock");
    expect(html).not.toContain('role="switch"');
  });

  it("still shows it as allowed, with the recovery-role badge", () => {
    const html = devPageRow();
    expect(html).toContain("Recovery role");
  });

  it("says why, so the padlock never has to be guessed at", () => {
    // The reason travels with the row rather than living in a tooltip only.
    expect(devPageRow()).toContain("Always reaches every page");
  });

  it("every other row is still an ordinary switch — nothing else was re-locked", () => {
    const html = ordinaryPageRow();
    expect(html).toContain('role="switch"');
    expect(html).not.toContain("lucide-lock");
  });
});
