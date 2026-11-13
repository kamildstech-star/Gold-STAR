import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

/**
 * The payment receipt (receipt-pdf.ts, SendReceiptButton) was built on 2 Sep
 * and placed on no screen until 12 Nov, so nobody could make one. It lives on
 * every payment row of the job's Billing tab, beside History.
 */
describe("the payment receipt is reachable", () => {
  const panel = readFileSync("src/components/job-billing-panel.tsx", "utf8");

  it("is rendered for each payment on the job's Billing tab", () => {
    expect(panel).toContain('import { SendReceiptButton } from "@/components/send-receipt-button"');
    const rows = panel.slice(panel.indexOf("{payments.map((p) => {"));
    expect(rows).toContain("<SendReceiptButton paymentId={p.id} jobId={jobId} />");
  });
});
