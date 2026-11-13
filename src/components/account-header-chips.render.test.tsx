import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/**
 * The header chips are shared by the full record and the prospect layout.
 * A static render pins that they say the same thing wherever they sit, and
 * that a single-office account draws no footprint chip at all.
 */
vi.mock("@/components/app-context", () => ({
  useAppContext: () => ({ allLocations: [{ id: "a" }, { id: "b" }, { id: "c" }] }),
}));
vi.mock("@/lib/account-locations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-locations")>()),
  useAccountLocations: (id: string | null) => ({ data: id ? ["a", "b"] : undefined }),
}));

import { AccountFootprintChip, AccountStatusPill, AccountTypeChip } from "./account-header-chips";

describe("account header chips", () => {
  it("names the status and the type the way the full record does", () => {
    expect(
      renderToStaticMarkup(createElement(AccountStatusPill, { status: "prospect" })),
    ).toContain("Prospect");
    expect(renderToStaticMarkup(createElement(AccountTypeChip, { type: "commercial" }))).toContain(
      "Commercial",
    );
  });

  it("draws the footprint only on a multi-location account", () => {
    expect(
      renderToStaticMarkup(
        createElement(AccountFootprintChip, { accountId: "x", isMultiLocation: false }),
      ),
    ).toBe("");
    expect(
      renderToStaticMarkup(
        createElement(AccountFootprintChip, { accountId: "x", isMultiLocation: true }),
      ),
    ).toContain("Multi-location · 2 offices");
  });
});
