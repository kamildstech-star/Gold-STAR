import { describe, expect, it } from "vitest";

import { BILL_TO_JOB_EMBED, billToLines, resolveBillTo, type BillToAccount } from "@/lib/bill-to";

const acct = (name: string): BillToAccount => ({
  name,
  address_line1: null,
  city: null,
  state: null,
  postal_code: null,
  email: null,
});

describe("who a document is addressed to", () => {
  it("is the job's named payer first, then the document's customer", () => {
    const job = { bill_to: acct("Managing Agent LLC"), job_customer: acct("Job Customer") };
    expect(resolveBillTo(job, acct("Invoice Customer")).account?.name).toBe("Managing Agent LLC");
    expect(
      resolveBillTo({ job_customer: acct("Job Customer") }, acct("Invoice Customer")).account?.name,
    ).toBe("Invoice Customer");
  });

  it("falls back to the job's own customer when the document has none (12 Nov)", () => {
    // Receipt GS-INV-2026-00012-R1 printed "Received from -": the invoice had
    // no account and the job named no payer, though the job has a customer.
    const payer = resolveBillTo({ job_customer: acct("AJH Management") }, null);
    expect(payer.account?.name).toBe("AJH Management");
    expect(payer.explicit).toBe(false);
    expect(billToLines(payer)[0]).toBe("AJH Management");
  });

  it("prints a dash only when nobody is known at all", () => {
    expect(billToLines(resolveBillTo(null, null))[0]).toBe("-");
  });

  it("reads the job's customer in the same embed the PDFs already use", () => {
    expect(BILL_TO_JOB_EMBED).toContain("job_customer:accounts!jobs_account_id_fkey(");
  });
});
