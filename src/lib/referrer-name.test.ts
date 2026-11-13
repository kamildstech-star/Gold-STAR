import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { idChunks, referrerDisplayName } from "./referrer-name";
import { referrerLine, type JobReferrerFacts } from "./job-commission";

/*
 * David, 21 Oct: the referral column showed the wrong people. The job's
 * `referred_by_name` is a stale free-text copy; the live contact must win.
 */
describe("referral names come from the live contact, not the stale copy", () => {
  const contacts = { c1: "Dana Live" };
  const accounts = { a1: "Acme Plumbing" };

  it("prefers the contact's current name over referred_by_name", () => {
    expect(
      referrerDisplayName(
        {
          referred_by_contact_id: "c1",
          referred_by_account_id: "a1",
          referred_by_name: "Old Person",
        },
        contacts,
        accounts,
      ),
    ).toBe("Dana Live");
  });

  it("uses the company for a company-only pick, and free text only with no ids", () => {
    expect(
      referrerDisplayName(
        { referred_by_contact_id: null, referred_by_account_id: "a1", referred_by_name: "x" },
        contacts,
        accounts,
      ),
    ).toBe("Acme Plumbing");
    expect(
      referrerDisplayName(
        { referred_by_contact_id: null, referred_by_account_id: null, referred_by_name: " Bob " },
        contacts,
        accounts,
      ),
    ).toBe("Bob");
  });

  it("chunks ids for the lookup and drops blanks and repeats", () => {
    const ids = Array.from({ length: 250 }, (_, i) => `id${i % 210}`).concat(["", ""]);
    const chunks = idChunks(ids);
    expect(chunks.map((c) => c.length)).toEqual([100, 100, 10]);
  });

  it("a company payee is never labeled with the person's name", () => {
    const facts: JobReferrerFacts = {
      accountId: "a1",
      contactId: "c1",
      sourceKey: null,
      overridePct: null,
      overrideFlat: null,
      rules: [
        {
          id: "r1",
          account_id: "a1",
          contact_id: null,
          kind: "percent",
          value: 10,
          effective_from: null,
          effective_to: null,
          note: null,
        } as never,
      ],
      sources: [],
      on: "2026-10-01",
      contactName: "Dana Live",
      accountName: null,
      referredByName: "Dana Live",
      paidOn: null,
      paidAmount: null,
    };
    const line = referrerLine(facts, 1000);
    expect(line?.basis?.origin).toBe("company");
    expect(line?.payee_type).toBe("account");
    expect(line?.payee_name).toBe("Referring company");
  });

  it("the commissions report and the referral book read live names", () => {
    const report = readFileSync("src/lib/commissions-report.ts", "utf8");
    expect(report).toMatch(/for \(const chunk of idChunks\(ids\)\)/);
    expect(report).toMatch(/if \(error\) throw error;/);
    const book = readFileSync("src/components/dashboards-sales.tsx", "utf8");
    expect(book).not.toMatch(/name: j\.referred_by_name \?\?/);
    expect(book).not.toMatch(/` · \$\{j\.referred_by_name\}`/);
  });
});
