import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { BillingRail } from "./billing-rail";

/**
 * Mark, 2026-09-09: "move carrier biling office and totals to the right where
 * the runniong cost and bill to is."
 *
 * The Billing tab ran three columns at desktop width: the line-item table, the
 * editor's own 20rem rail, and then the page's 20rem rail. An editor's cards
 * now go to the page rail instead, through a portal, because they hold live
 * inputs and belong to one document while the page rail belongs to the job.
 *
 * Server rendering is the case this pins. A portal has no DOM to render into
 * on the server, and `useRailWidth` is deliberately false until an effect
 * runs, so the very first paint must put the cards where they have always
 * been rather than dropping them. A rail that renders nothing on the server is
 * a blank sidebar on every cold load.
 */
describe("an editor's rail before the browser has measured anything", () => {
  const cards = createElement("p", null, "Totals for this document");

  it("renders its cards in place rather than nothing at all", () => {
    const html = renderToStaticMarkup(
      createElement(BillingRail, { label: "GS-INV-2026-00005", children: cards }),
    );
    expect(html).toContain("Totals for this document");
  });

  it("keeps the spacing the cards were always laid out with", () => {
    const html = renderToStaticMarkup(
      createElement(BillingRail, { label: "GS-INV-2026-00005", children: cards }),
    );
    expect(html).toContain("space-y-3");
  });

  it("does not print the document heading until the cards actually move", () => {
    // In place, under the document's own editor, the heading is noise. It
    // exists only to tell two portalled groups apart in the shared rail.
    const html = renderToStaticMarkup(
      createElement(BillingRail, { label: "GS-INV-2026-00005", children: cards }),
    );
    expect(html).not.toContain("GS-INV-2026-00005");
  });
});
