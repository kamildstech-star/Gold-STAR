// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OtherOfficeNotice, officeList, otherOfficeNames } from "@/components/other-office-notice";

/*
 * 13 Nov: hidden other-office records made duplicates likely, so the pickers
 * say one line — a match exists, and where — and show nothing of the record.
 */
describe("the other-office duplicate warning", () => {
  it("names each office once", () => {
    expect(otherOfficeNames(["Baltimore", null, " Baltimore ", "NJ", ""])).toEqual([
      "Baltimore",
      "NJ",
    ]);
    expect(officeList(["Baltimore"])).toBe("Baltimore");
    expect(officeList(["Baltimore", "NJ", "DC"])).toBe("Baltimore, NJ and DC");
    expect(officeList([])).toBe("another office");
  });

  it("says where, and nothing about the record", () => {
    const html = renderToStaticMarkup(
      <OtherOfficeNotice offices={["Baltimore"]} what="customer" />,
    );
    expect(html).toMatch(/already exist in another office \(Baltimore\)/);
    expect(html).not.toMatch(/<(button|a)\b/);
  });

  it("renders nothing without a match", () => {
    expect(renderToStaticMarkup(<OtherOfficeNotice offices={null} what="company" />)).toBe("");
  });

  it("is used where a rep searches for or creates a customer or company", () => {
    for (const f of [
      "src/components/customer-picker.tsx",
      "src/components/account-picker.tsx",
      "src/components/create-customer-dialog.tsx",
    ]) {
      expect(readFileSync(f, "utf8")).toContain("<OtherOfficeNotice");
    }
  });
});
